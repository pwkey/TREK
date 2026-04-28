/**
 * [460-fork] Milestone 6 slice 1 — per-day journal endpoints.
 * Covers JOURNAL-001 to JOURNAL-008.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import type { Application } from 'express';

const { testDb, dbMock } = vi.hoisted(() => {
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  const mock = {
    db,
    closeDb: () => {},
    reinitialize: () => {},
    canAccessTrip: (tripId: any, userId: number) =>
      db.prepare(`SELECT t.id, t.user_id FROM trips t LEFT JOIN trip_members m ON m.trip_id = t.id AND m.user_id = ? WHERE t.id = ? AND (t.user_id = ? OR m.user_id IS NOT NULL)`).get(userId, tripId, userId),
    isOwner: (tripId: any, userId: number) =>
      !!db.prepare('SELECT id FROM trips WHERE id = ? AND user_id = ?').get(tripId, userId),
  };
  return { testDb: db, dbMock: mock };
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
import { createUser, createTrip, createDay, addTripMember } from '../helpers/factories';
import { authCookie } from '../helpers/auth';
import { loginAttempts, mfaAttempts } from '../../src/routes/auth';

const app: Application = createApp();

beforeAll(() => {
  createTables(testDb);
  runMigrations(testDb);
});

beforeEach(() => {
  resetTestDb(testDb);
  loginAttempts.clear();
  mfaAttempts.clear();
});

afterAll(() => {
  testDb.close();
});

describe('Get day journal', () => {
  it('JOURNAL-001 — GET returns null for a day with no journal yet', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    const day = createDay(testDb, trip.id, { date: '2026-05-01' });

    const res = await request(app)
      .get(`/api/trips/${trip.id}/days/${day.id}/journal`)
      .set('Cookie', authCookie(user.id));
    expect(res.status).toBe(200);
    expect(res.body.journal).toBeNull();
  });

  it('JOURNAL-002 — non-member cannot read journal', async () => {
    const { user: owner } = createUser(testDb);
    const { user: stranger } = createUser(testDb);
    const trip = createTrip(testDb, owner.id);
    const day = createDay(testDb, trip.id);

    const res = await request(app)
      .get(`/api/trips/${trip.id}/days/${day.id}/journal`)
      .set('Cookie', authCookie(stranger.id));
    expect(res.status).toBe(404);
  });
});

describe('Create / update day journal', () => {
  it('JOURNAL-003 — PUT inserts on first write', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    const day = createDay(testDb, trip.id, { date: '2026-05-01' });

    const res = await request(app)
      .put(`/api/trips/${trip.id}/days/${day.id}/journal`)
      .set('Cookie', authCookie(user.id))
      .send({ content_markdown: '# Day 1\n\nWoke up early.' });
    expect(res.status).toBe(200);
    expect(res.body.journal.day_id).toBe(day.id);
    expect(res.body.journal.content_markdown).toBe('# Day 1\n\nWoke up early.');
    expect(res.body.journal.updated_by).toBe(user.id);
    expect(res.body.journal.updated_at).toBeDefined();
  });

  it('JOURNAL-004 — PUT upserts on subsequent writes', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    const day = createDay(testDb, trip.id, { date: '2026-05-01' });

    await request(app)
      .put(`/api/trips/${trip.id}/days/${day.id}/journal`)
      .set('Cookie', authCookie(user.id))
      .send({ content_markdown: 'first' });
    const res = await request(app)
      .put(`/api/trips/${trip.id}/days/${day.id}/journal`)
      .set('Cookie', authCookie(user.id))
      .send({ content_markdown: 'second' });
    expect(res.status).toBe(200);
    expect(res.body.journal.content_markdown).toBe('second');

    // Verify there's only one row.
    const rows = testDb.prepare('SELECT COUNT(*) AS n FROM day_journals WHERE day_id = ?').get(day.id) as { n: number };
    expect(rows.n).toBe(1);
  });

  it('JOURNAL-005 — content_markdown must be a string', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    const day = createDay(testDb, trip.id);

    const res = await request(app)
      .put(`/api/trips/${trip.id}/days/${day.id}/journal`)
      .set('Cookie', authCookie(user.id))
      .send({ content_markdown: 12345 });
    expect(res.status).toBe(400);
  });

  it('JOURNAL-006 — over-length content rejected', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    const day = createDay(testDb, trip.id);

    const big = 'x'.repeat(100_001);
    const res = await request(app)
      .put(`/api/trips/${trip.id}/days/${day.id}/journal`)
      .set('Cookie', authCookie(user.id))
      .send({ content_markdown: big });
    expect(res.status).toBe(400);
  });

  it('JOURNAL-007 — trip member with edit permission can write', async () => {
    const { user: owner } = createUser(testDb);
    const { user: collaborator } = createUser(testDb);
    const trip = createTrip(testDb, owner.id);
    addTripMember(testDb, trip.id, collaborator.id);
    const day = createDay(testDb, trip.id);

    const res = await request(app)
      .put(`/api/trips/${trip.id}/days/${day.id}/journal`)
      .set('Cookie', authCookie(collaborator.id))
      .send({ content_markdown: 'collaborator wrote this' });
    expect(res.status).toBe(200);
    expect(res.body.journal.updated_by).toBe(collaborator.id);
  });
});

describe('Stale-write conflict precondition', () => {
  it('JOURNAL-008 — If-Unmodified-Since mismatch parks as conflict', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    const day = createDay(testDb, trip.id);

    // Seed a journal so subsequent updates have an updated_at to compare to.
    const seedRes = await request(app)
      .put(`/api/trips/${trip.id}/days/${day.id}/journal`)
      .set('Cookie', authCookie(user.id))
      .send({ content_markdown: 'seed' });
    expect(seedRes.status).toBe(200);
    const firstUpdatedAt = seedRes.body.journal.updated_at as string;

    // Bump the row so the precondition check has something to mismatch against.
    await new Promise(r => setTimeout(r, 1100)); // ensure CURRENT_TIMESTAMP advances by ≥ 1s
    const bumpRes = await request(app)
      .put(`/api/trips/${trip.id}/days/${day.id}/journal`)
      .set('Cookie', authCookie(user.id))
      .send({ content_markdown: 'server moved on' });
    expect(bumpRes.status).toBe(200);
    expect(bumpRes.body.journal.updated_at).not.toBe(firstUpdatedAt);

    // Now PUT with the OLD updated_at as If-Unmodified-Since → 409.
    const staleRes = await request(app)
      .put(`/api/trips/${trip.id}/days/${day.id}/journal`)
      .set('Cookie', authCookie(user.id))
      .set('If-Unmodified-Since', firstUpdatedAt)
      .set('X-Client-Mutation-Id', 'test-mid-1')
      .send({ content_markdown: 'my offline edit' });
    expect(staleRes.status).toBe(409);
    expect(staleRes.body.code).toBe('STALE_WRITE');
    expect(staleRes.body.conflict_id).toBeDefined();

    // Server's content is unchanged.
    const verify = await request(app)
      .get(`/api/trips/${trip.id}/days/${day.id}/journal`)
      .set('Cookie', authCookie(user.id));
    expect(verify.body.journal.content_markdown).toBe('server moved on');
  });
});
