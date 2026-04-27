/**
 * Integration tests for the X-Client-Mutation-Id idempotency middleware
 * (Milestone 5 slice 2). The middleware sits after authenticate and short-
 * circuits a duplicate mutation with the cached response. We exercise it
 * via the day-update route which is small, well-known, and predictable.
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
const MUTATION_ID = '00000000-0000-4000-8000-000000000abc';

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

describe('X-Client-Mutation-Id idempotency middleware', () => {
  it('caches the response on first call and replays it byte-identical', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id, { title: 'T', start_date: '2027-01-01', end_date: '2027-01-02' });
    const day = createDay(testDb, trip.id, { date: '2027-01-01' });

    const first = await request(app)
      .put(`/api/trips/${trip.id}/days/${day.id}`)
      .set('Cookie', authCookie(user.id))
      .set('X-Client-Mutation-Id', MUTATION_ID)
      .send({ title: 'First write', notes: 'first' });
    expect(first.status).toBe(200);
    expect(first.body.day.title).toBe('First write');

    // Second call with same id but a DIFFERENT body: server replays the
    // cached response and does NOT apply the second body.
    const replay = await request(app)
      .put(`/api/trips/${trip.id}/days/${day.id}`)
      .set('Cookie', authCookie(user.id))
      .set('X-Client-Mutation-Id', MUTATION_ID)
      .send({ title: 'Different write', notes: 'should be ignored' });
    expect(replay.status).toBe(first.status);
    expect(replay.body).toEqual(first.body);

    // DB confirms the second write was suppressed.
    const dayRow = testDb.prepare('SELECT title, notes FROM days WHERE id = ?').get(day.id) as { title: string; notes: string };
    expect(dayRow.title).toBe('First write');
    expect(dayRow.notes).toBe('first');
  });

  it('does not cache GET requests', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id, { title: 'T' });
    const before = (testDb.prepare('SELECT COUNT(*) AS c FROM client_mutations WHERE user_id = ?').get(user.id) as { c: number }).c;

    await request(app)
      .get(`/api/trips/${trip.id}`)
      .set('Cookie', authCookie(user.id))
      .set('X-Client-Mutation-Id', MUTATION_ID);

    const after = (testDb.prepare('SELECT COUNT(*) AS c FROM client_mutations WHERE user_id = ?').get(user.id) as { c: number }).c;
    expect(after).toBe(before);
  });

  it('does not cache when the header is absent', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id, { title: 'T', start_date: '2027-01-01', end_date: '2027-01-02' });
    const day = createDay(testDb, trip.id, { date: '2027-01-01' });

    await request(app)
      .put(`/api/trips/${trip.id}/days/${day.id}`)
      .set('Cookie', authCookie(user.id))
      .send({ title: 'No mutation id', notes: 'x' });

    const cached = (testDb.prepare('SELECT COUNT(*) AS c FROM client_mutations WHERE user_id = ?').get(user.id) as { c: number }).c;
    expect(cached).toBe(0);
  });

  it('scopes the cache by user — same id from a different user does not collide', async () => {
    const { user: alice } = createUser(testDb);
    const { user: bob } = createUser(testDb);
    const aTrip = createTrip(testDb, alice.id, { title: 'A', start_date: '2027-01-01', end_date: '2027-01-02' });
    const bTrip = createTrip(testDb, bob.id, { title: 'B', start_date: '2027-01-01', end_date: '2027-01-02' });
    const aDay = createDay(testDb, aTrip.id, { date: '2027-01-01' });
    const bDay = createDay(testDb, bTrip.id, { date: '2027-01-01' });

    const aliceRes = await request(app)
      .put(`/api/trips/${aTrip.id}/days/${aDay.id}`)
      .set('Cookie', authCookie(alice.id))
      .set('X-Client-Mutation-Id', MUTATION_ID)
      .send({ title: 'Alice write', notes: 'a' });
    expect(aliceRes.status).toBe(200);

    // Bob uses the same id; should NOT get Alice's cached response.
    const bobRes = await request(app)
      .put(`/api/trips/${bTrip.id}/days/${bDay.id}`)
      .set('Cookie', authCookie(bob.id))
      .set('X-Client-Mutation-Id', MUTATION_ID)
      .send({ title: 'Bob write', notes: 'b' });
    expect(bobRes.status).toBe(200);
    expect(bobRes.body.day.title).toBe('Bob write');

    const bDayRow = testDb.prepare('SELECT title FROM days WHERE id = ?').get(bDay.id) as { title: string };
    expect(bDayRow.title).toBe('Bob write');
  });

  it('does not cache 4xx responses (so a fixed retry can succeed)', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id, { title: 'T', start_date: '2027-01-01', end_date: '2027-01-02' });

    // Hit a non-existent day id → 404.
    const res = await request(app)
      .put(`/api/trips/${trip.id}/days/99999`)
      .set('Cookie', authCookie(user.id))
      .set('X-Client-Mutation-Id', MUTATION_ID)
      .send({ title: 'Whoops', notes: 'x' });
    expect(res.status).toBe(404);

    const cached = (testDb.prepare('SELECT COUNT(*) AS c FROM client_mutations WHERE user_id = ?').get(user.id) as { c: number }).c;
    expect(cached).toBe(0);
  });
});
