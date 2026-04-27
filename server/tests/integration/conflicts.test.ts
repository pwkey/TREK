/**
 * Integration tests for stale-write conflict detection + resolution
 * (Milestone 5 slice 4). Day update is the only route currently wired.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import type { Application } from 'express';

const { testDb, dbMock } = vi.hoisted(() => {
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  return {
    testDb: db,
    dbMock: {
      db,
      closeDb: () => {},
      reinitialize: () => {},
      canAccessTrip: (tripId: any, userId: number) =>
        db.prepare(`SELECT t.id, t.user_id FROM trips t LEFT JOIN trip_members m ON m.trip_id = t.id AND m.user_id = ? WHERE t.id = ? AND (t.user_id = ? OR m.user_id IS NOT NULL)`).get(userId, tripId, userId),
      isOwner: (tripId: any, userId: number) =>
        !!db.prepare('SELECT id FROM trips WHERE id = ? AND user_id = ?').get(tripId, userId),
    },
  };
});

vi.mock('../../src/db/database', () => dbMock);
vi.mock('../../src/config', () => ({
  JWT_SECRET: 'test-jwt-secret-for-trek-testing-only',
  ENCRYPTION_KEY: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6a7b8c9d0e1f2a3b4c5d6a7b8c9d0e1f2',
  updateJwtSecret: () => {},
}));

import { createApp } from '../../src/app';
import { createTables } from '../../src/db/schema';
import { runMigrations } from '../../src/db/migrations';
import { resetTestDb } from '../helpers/test-db';
import { createUser, createTrip, createDay } from '../helpers/factories';
import { authCookie } from '../helpers/auth';

const app: Application = createApp();

beforeAll(() => {
  createTables(testDb);
  runMigrations(testDb);
});

beforeEach(() => {
  resetTestDb(testDb);
});

afterAll(() => {
  testDb.close();
});

async function setupStaleDay() {
  const { user } = createUser(testDb);
  const trip = createTrip(testDb, user.id, { title: 'T', start_date: '2027-01-01', end_date: '2027-01-02' });
  const day = createDay(testDb, trip.id, { date: '2027-01-01' });
  // First write to capture a known updated_at, then advance time so the next
  // write produces a different timestamp.
  await request(app)
    .put(`/api/trips/${trip.id}/days/${day.id}`)
    .set('Cookie', authCookie(user.id))
    .send({ title: 'Original', notes: 'first' });
  const original = testDb.prepare('SELECT updated_at FROM days WHERE id = ?').get(day.id) as { updated_at: string };
  // Force a newer updated_at to simulate "server moved on".
  testDb.prepare("UPDATE days SET updated_at = datetime('now', '+1 second'), title = 'After Bob' WHERE id = ?").run(day.id);
  return { user, trip, day, observedStale: original.updated_at };
}

describe('Stale-write conflict detection', () => {
  it('parks the mutation as a conflict and returns 409 when If-Unmodified-Since is stale', async () => {
    const { user, trip, day, observedStale } = await setupStaleDay();
    const res = await request(app)
      .put(`/api/trips/${trip.id}/days/${day.id}`)
      .set('Cookie', authCookie(user.id))
      .set('X-Client-Mutation-Id', 'm-stale-1')
      .set('If-Unmodified-Since', observedStale)
      .send({ title: 'My queued write', notes: 'mine' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('STALE_WRITE');
    expect(res.body.conflict_id).toBeTruthy();

    // Server state was NOT touched.
    const dayRow = testDb.prepare('SELECT title FROM days WHERE id = ?').get(day.id) as { title: string };
    expect(dayRow.title).toBe('After Bob');
  });

  it('GET /api/conflicts lists the parked conflict', async () => {
    const { user, trip, day, observedStale } = await setupStaleDay();
    await request(app)
      .put(`/api/trips/${trip.id}/days/${day.id}`)
      .set('Cookie', authCookie(user.id))
      .set('X-Client-Mutation-Id', 'm-list-1')
      .set('If-Unmodified-Since', observedStale)
      .send({ title: 'Mine', notes: 'mine' });

    const list = await request(app).get('/api/conflicts').set('Cookie', authCookie(user.id));
    expect(list.status).toBe(200);
    expect(list.body.count).toBe(1);
    const c = list.body.conflicts[0];
    expect(c.record_type).toBe('day');
    expect(c.record_id).toBe(day.id);
    expect(c.mine).toMatchObject({ title: 'Mine' });
    expect(c.theirs).toMatchObject({ title: 'After Bob' });
  });

  it("resolve 'theirs' marks the conflict resolved without touching the record", async () => {
    const { user, trip, day, observedStale } = await setupStaleDay();
    await request(app)
      .put(`/api/trips/${trip.id}/days/${day.id}`)
      .set('Cookie', authCookie(user.id))
      .set('X-Client-Mutation-Id', 'm-theirs-1')
      .set('If-Unmodified-Since', observedStale)
      .send({ title: 'Mine', notes: 'mine' });
    const list = await request(app).get('/api/conflicts').set('Cookie', authCookie(user.id));
    const conflictId = list.body.conflicts[0].id;

    const res = await request(app)
      .post(`/api/conflicts/${conflictId}/resolve`)
      .set('Cookie', authCookie(user.id))
      .send({ choice: 'theirs' });
    expect(res.status).toBe(200);

    const dayRow = testDb.prepare('SELECT title FROM days WHERE id = ?').get(day.id) as { title: string };
    expect(dayRow.title).toBe('After Bob'); // server's version wins

    const after = await request(app).get('/api/conflicts').set('Cookie', authCookie(user.id));
    expect(after.body.count).toBe(0); // resolved → off the open list
  });

  it("resolve 'mine' re-applies the queued payload, overriding the server", async () => {
    const { user, trip, day, observedStale } = await setupStaleDay();
    await request(app)
      .put(`/api/trips/${trip.id}/days/${day.id}`)
      .set('Cookie', authCookie(user.id))
      .set('X-Client-Mutation-Id', 'm-mine-1')
      .set('If-Unmodified-Since', observedStale)
      .send({ title: 'Mine wins', notes: 'mine notes' });
    const list = await request(app).get('/api/conflicts').set('Cookie', authCookie(user.id));
    const conflictId = list.body.conflicts[0].id;

    const res = await request(app)
      .post(`/api/conflicts/${conflictId}/resolve`)
      .set('Cookie', authCookie(user.id))
      .send({ choice: 'mine' });
    expect(res.status).toBe(200);
    expect(res.body.day.title).toBe('Mine wins');

    const dayRow = testDb.prepare('SELECT title, notes FROM days WHERE id = ?').get(day.id) as { title: string; notes: string };
    expect(dayRow.title).toBe('Mine wins');
    expect(dayRow.notes).toBe('mine notes');
  });

  it("resolve 'combine' applies the caller-provided merged payload", async () => {
    const { user, trip, day, observedStale } = await setupStaleDay();
    await request(app)
      .put(`/api/trips/${trip.id}/days/${day.id}`)
      .set('Cookie', authCookie(user.id))
      .set('X-Client-Mutation-Id', 'm-combine-1')
      .set('If-Unmodified-Since', observedStale)
      .send({ title: 'Mine', notes: 'mine paragraph' });
    const list = await request(app).get('/api/conflicts').set('Cookie', authCookie(user.id));
    const conflictId = list.body.conflicts[0].id;

    const res = await request(app)
      .post(`/api/conflicts/${conflictId}/resolve`)
      .set('Cookie', authCookie(user.id))
      .send({ choice: 'combine', merged: { title: 'Combined', notes: 'mine paragraph\n---\nBob sentence' } });
    expect(res.status).toBe(200);
    const dayRow = testDb.prepare('SELECT title, notes FROM days WHERE id = ?').get(day.id) as { title: string; notes: string };
    expect(dayRow.title).toBe('Combined');
    expect(dayRow.notes).toContain('Bob sentence');
  });

  it("rejects an invalid choice", async () => {
    const { user, trip, day, observedStale } = await setupStaleDay();
    await request(app)
      .put(`/api/trips/${trip.id}/days/${day.id}`)
      .set('Cookie', authCookie(user.id))
      .set('X-Client-Mutation-Id', 'm-bad-1')
      .set('If-Unmodified-Since', observedStale)
      .send({ title: 'M', notes: 'm' });
    const list = await request(app).get('/api/conflicts').set('Cookie', authCookie(user.id));
    const conflictId = list.body.conflicts[0].id;

    const res = await request(app)
      .post(`/api/conflicts/${conflictId}/resolve`)
      .set('Cookie', authCookie(user.id))
      .send({ choice: 'whatever' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_CHOICE');
  });

  it("does NOT park a conflict when If-Unmodified-Since matches", async () => {
    const { user, trip, day } = await setupStaleDay();
    // Read current updated_at and use it as the precondition — fresh, not stale.
    const fresh = (testDb.prepare('SELECT updated_at FROM days WHERE id = ?').get(day.id) as { updated_at: string }).updated_at;
    const res = await request(app)
      .put(`/api/trips/${trip.id}/days/${day.id}`)
      .set('Cookie', authCookie(user.id))
      .set('X-Client-Mutation-Id', 'm-fresh-1')
      .set('If-Unmodified-Since', fresh)
      .send({ title: 'New title', notes: 'fresh' });
    expect(res.status).toBe(200);

    const after = await request(app).get('/api/conflicts').set('Cookie', authCookie(user.id));
    expect(after.body.count).toBe(0);
  });
});
