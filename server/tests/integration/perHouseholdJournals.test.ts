/**
 * Per-household journals & photos on shared segment days — Milestone 13, slice 4.
 *
 * A shared-segment day is one canonical row owned by the home trip; sibling
 * trips read it via the days.segment_id UNION. Journals and photos are keyed by
 * (day_id, trip_id), so each household keeps its OWN memoir of the shared day
 * while the itinerary stays shared. These tests prove that isolation: each trip
 * sees only its own journal/photos, and one household's write never alters the
 * other's.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import type { Application } from 'express';

const { testDb, dbMock } = vi.hoisted(() => {
  const DB = require('better-sqlite3');
  const db = new DB(':memory:');
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
import { createUser, createTrip, createDay } from '../helpers/factories';
import { authCookie } from '../helpers/auth';

const app: Application = createApp();

let _segSeq = 0;
/** Two households (A=home, B=sibling) sharing one canonical day. */
function sharedSegmentDay() {
  const { user: ownerA } = createUser(testDb);
  const { user: ownerB } = createUser(testDb);
  const tripA = createTrip(testDb, ownerA.id);
  const tripB = createTrip(testDb, ownerB.id);
  const segId = `seg-phj-${++_segSeq}`;
  testDb.prepare('INSERT INTO segments (id, title, created_by) VALUES (?, ?, ?)').run(segId, 'Shared Days', ownerA.id);
  testDb.prepare('INSERT INTO trip_segments (trip_id, segment_id, is_home, joined_by) VALUES (?, ?, 1, ?)').run(tripA.id, segId, ownerA.id);
  testDb.prepare('INSERT INTO trip_segments (trip_id, segment_id, is_home, joined_by) VALUES (?, ?, 0, ?)').run(tripB.id, segId, ownerB.id);
  const day = createDay(testDb, tripA.id, { date: '2026-07-10' });
  testDb.prepare('UPDATE days SET segment_id = ? WHERE id = ?').run(segId, day.id);
  return { ownerA, ownerB, tripA, tripB, segId, dayId: day.id };
}

function addPhoto(tripId: number, dayId: number, uploaderId: number, caption: string) {
  const tf = testDb.prepare(
    `INSERT INTO trip_files (trip_id, filename, original_name, mime_type, uploaded_by) VALUES (?, ?, ?, 'image/jpeg', ?)`
  ).run(tripId, `${caption}.jpg`, `${caption}.jpg`, uploaderId);
  testDb.prepare(
    `INSERT INTO day_photos (day_id, trip_id, upload_id, caption, position) VALUES (?, ?, ?, ?, 0)`
  ).run(dayId, tripId, tf.lastInsertRowid, caption);
}

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

describe('Per-household journals on a shared day', () => {
  it('PHJ-001 — each household keeps its own journal; writes are independent', async () => {
    const { ownerA, ownerB, tripA, tripB, dayId } = sharedSegmentDay();

    const aPut = await request(app)
      .put(`/api/trips/${tripA.id}/days/${dayId}/journal`)
      .set('Cookie', authCookie(ownerA.id))
      .send({ content_markdown: "A's memoir of the shared day" });
    expect(aPut.status).toBe(200);

    const bPut = await request(app)
      .put(`/api/trips/${tripB.id}/days/${dayId}/journal`)
      .set('Cookie', authCookie(ownerB.id))
      .send({ content_markdown: "B's own recollection" });
    expect(bPut.status).toBe(200);

    // Each reads back its own — B's write did NOT clobber A's.
    const aGet = await request(app).get(`/api/trips/${tripA.id}/days/${dayId}/journal`).set('Cookie', authCookie(ownerA.id));
    expect(aGet.body.journal.content_markdown).toBe("A's memoir of the shared day");
    const bGet = await request(app).get(`/api/trips/${tripB.id}/days/${dayId}/journal`).set('Cookie', authCookie(ownerB.id));
    expect(bGet.body.journal.content_markdown).toBe("B's own recollection");

    // Two distinct rows for the one shared day.
    const count = (testDb.prepare('SELECT COUNT(*) AS c FROM day_journals WHERE day_id = ?').get(dayId) as { c: number }).c;
    expect(count).toBe(2);
  });

  it('PHJ-002 — a shared day has no journal for a household that has not written one', async () => {
    const { ownerA, ownerB, tripA, tripB, dayId } = sharedSegmentDay();
    await request(app)
      .put(`/api/trips/${tripA.id}/days/${dayId}/journal`)
      .set('Cookie', authCookie(ownerA.id))
      .send({ content_markdown: "Only A wrote" });

    const bGet = await request(app).get(`/api/trips/${tripB.id}/days/${dayId}/journal`).set('Cookie', authCookie(ownerB.id));
    expect(bGet.status).toBe(200);
    expect(bGet.body.journal).toBeNull(); // B sees no journal until B writes one
  });
});

describe('Per-household photos on a shared day', () => {
  it('PHJ-003 — each household sees only its own photos on the shared day', async () => {
    const { ownerA, ownerB, tripA, tripB, dayId } = sharedSegmentDay();
    addPhoto(tripA.id, dayId, ownerA.id, 'A-photo');
    addPhoto(tripB.id, dayId, ownerB.id, 'B-photo');

    const aPhotos = await request(app).get(`/api/trips/${tripA.id}/days/${dayId}/photos`).set('Cookie', authCookie(ownerA.id));
    expect(aPhotos.status).toBe(200);
    expect(aPhotos.body.photos.map((p: any) => p.caption)).toEqual(['A-photo']);

    const bPhotos = await request(app).get(`/api/trips/${tripB.id}/days/${dayId}/photos`).set('Cookie', authCookie(ownerB.id));
    expect(bPhotos.status).toBe(200);
    expect(bPhotos.body.photos.map((p: any) => p.caption)).toEqual(['B-photo']);
  });
});
