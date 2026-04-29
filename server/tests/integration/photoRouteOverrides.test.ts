/**
 * [460-fork] M6 follow-up — photo route override endpoints.
 * Per-segment waypoint overrides for the chronological photo route.
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

/** Spin up a trip with two days, each with a single photo, and return
 *  the IDs we need for the override tests. The photos themselves don't
 *  need bytes on disk — the override endpoints only care about IDs and
 *  the FK chain to trips via days. */
function setupTripWithTwoPhotos(ownerId: number): { tripId: number; photoAId: number; photoBId: number } {
  const trip = createTrip(testDb, ownerId);
  const dayA = createDay(testDb, trip.id);
  const dayB = createDay(testDb, trip.id);
  const fileA = testDb.prepare(`INSERT INTO trip_files (trip_id, filename, original_name, mime_type, file_size, uploaded_by) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(trip.id, 'a.jpg', 'a.jpg', 'image/jpeg', 100, ownerId);
  const fileB = testDb.prepare(`INSERT INTO trip_files (trip_id, filename, original_name, mime_type, file_size, uploaded_by) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(trip.id, 'b.jpg', 'b.jpg', 'image/jpeg', 100, ownerId);
  const photoA = testDb.prepare(`INSERT INTO day_photos (day_id, upload_id, taken_at, lat, lng) VALUES (?, ?, ?, ?, ?)`)
    .run(dayA.id, fileA.lastInsertRowid, '2026-04-21T05:30:00Z', -33.8688, 151.2093);
  const photoB = testDb.prepare(`INSERT INTO day_photos (day_id, upload_id, taken_at, lat, lng) VALUES (?, ?, ?, ?, ?)`)
    .run(dayB.id, fileB.lastInsertRowid, '2026-04-22T05:30:00Z', -33.8650, 151.2150);
  return {
    tripId: trip.id,
    photoAId: Number(photoA.lastInsertRowid),
    photoBId: Number(photoB.lastInsertRowid),
  };
}

describe('Photo route overrides', () => {
  it('PRO-001 — PUT creates an override and GET lists it', async () => {
    const { user } = createUser(testDb);
    const { tripId, photoAId, photoBId } = setupTripWithTwoPhotos(user.id);

    const wp = [[-33.867, 151.210], [-33.866, 151.213]];
    const put = await request(app)
      .put(`/api/trips/${tripId}/photo-route-overrides/${photoAId}/${photoBId}`)
      .set('Cookie', authCookie(user.id))
      .send({ waypoints: wp });

    expect(put.status).toBe(200);
    expect(put.body.override.from_photo_id).toBe(photoAId);
    expect(put.body.override.to_photo_id).toBe(photoBId);
    expect(put.body.override.waypoints).toEqual(wp);

    const list = await request(app)
      .get(`/api/trips/${tripId}/photo-route-overrides`)
      .set('Cookie', authCookie(user.id));
    expect(list.status).toBe(200);
    expect(list.body.overrides).toHaveLength(1);
    expect(list.body.overrides[0].waypoints).toEqual(wp);
  });

  it('PRO-002 — PUT replaces existing waypoints (idempotent on same key)', async () => {
    const { user } = createUser(testDb);
    const { tripId, photoAId, photoBId } = setupTripWithTwoPhotos(user.id);

    await request(app)
      .put(`/api/trips/${tripId}/photo-route-overrides/${photoAId}/${photoBId}`)
      .set('Cookie', authCookie(user.id))
      .send({ waypoints: [[-33.867, 151.210]] });

    const second = await request(app)
      .put(`/api/trips/${tripId}/photo-route-overrides/${photoAId}/${photoBId}`)
      .set('Cookie', authCookie(user.id))
      .send({ waypoints: [[-33.866, 151.211], [-33.865, 151.214]] });

    expect(second.status).toBe(200);
    expect(second.body.override.waypoints).toHaveLength(2);

    const list = await request(app)
      .get(`/api/trips/${tripId}/photo-route-overrides`)
      .set('Cookie', authCookie(user.id));
    expect(list.body.overrides).toHaveLength(1);
    expect(list.body.overrides[0].waypoints).toHaveLength(2);
  });

  it('PRO-003 — DELETE removes the override', async () => {
    const { user } = createUser(testDb);
    const { tripId, photoAId, photoBId } = setupTripWithTwoPhotos(user.id);

    await request(app)
      .put(`/api/trips/${tripId}/photo-route-overrides/${photoAId}/${photoBId}`)
      .set('Cookie', authCookie(user.id))
      .send({ waypoints: [[-33.867, 151.210]] });

    const del = await request(app)
      .delete(`/api/trips/${tripId}/photo-route-overrides/${photoAId}/${photoBId}`)
      .set('Cookie', authCookie(user.id));
    expect(del.status).toBe(200);
    expect(del.body.removed).toBe(true);

    const list = await request(app)
      .get(`/api/trips/${tripId}/photo-route-overrides`)
      .set('Cookie', authCookie(user.id));
    expect(list.body.overrides).toHaveLength(0);
  });

  it('PRO-004 — deleting a photo cascades to its overrides', async () => {
    const { user } = createUser(testDb);
    const { tripId, photoAId, photoBId } = setupTripWithTwoPhotos(user.id);

    await request(app)
      .put(`/api/trips/${tripId}/photo-route-overrides/${photoAId}/${photoBId}`)
      .set('Cookie', authCookie(user.id))
      .send({ waypoints: [[-33.867, 151.210]] });

    // Drop the photo via SQL — same effect as the dayPhotos DELETE
    // endpoint would have via cascade.
    testDb.prepare('DELETE FROM day_photos WHERE id = ?').run(photoAId);

    const list = await request(app)
      .get(`/api/trips/${tripId}/photo-route-overrides`)
      .set('Cookie', authCookie(user.id));
    expect(list.body.overrides).toHaveLength(0);
  });

  it('PRO-005 — non-member cannot read or write', async () => {
    const { user: owner } = createUser(testDb);
    const { user: stranger } = createUser(testDb);
    const { tripId, photoAId, photoBId } = setupTripWithTwoPhotos(owner.id);

    const get = await request(app)
      .get(`/api/trips/${tripId}/photo-route-overrides`)
      .set('Cookie', authCookie(stranger.id));
    expect(get.status).toBe(404);

    const put = await request(app)
      .put(`/api/trips/${tripId}/photo-route-overrides/${photoAId}/${photoBId}`)
      .set('Cookie', authCookie(stranger.id))
      .send({ waypoints: [[-33.867, 151.210]] });
    expect(put.status).toBe(404);
  });

  it('PRO-006 — trip member with edit permission can write', async () => {
    const { user: owner } = createUser(testDb);
    const { user: collab } = createUser(testDb);
    const { tripId, photoAId, photoBId } = setupTripWithTwoPhotos(owner.id);
    addTripMember(testDb, tripId, collab.id);

    const put = await request(app)
      .put(`/api/trips/${tripId}/photo-route-overrides/${photoAId}/${photoBId}`)
      .set('Cookie', authCookie(collab.id))
      .send({ waypoints: [[-33.867, 151.210]] });
    expect(put.status).toBe(200);
  });

  it('PRO-007 — invalid waypoints (non-array) rejected', async () => {
    const { user } = createUser(testDb);
    const { tripId, photoAId, photoBId } = setupTripWithTwoPhotos(user.id);
    const res = await request(app)
      .put(`/api/trips/${tripId}/photo-route-overrides/${photoAId}/${photoBId}`)
      .set('Cookie', authCookie(user.id))
      .send({ waypoints: 'not-an-array' });
    expect(res.status).toBe(400);
  });

  it('PRO-008 — out-of-range coordinates rejected', async () => {
    const { user } = createUser(testDb);
    const { tripId, photoAId, photoBId } = setupTripWithTwoPhotos(user.id);
    const res = await request(app)
      .put(`/api/trips/${tripId}/photo-route-overrides/${photoAId}/${photoBId}`)
      .set('Cookie', authCookie(user.id))
      .send({ waypoints: [[200, 500]] });
    expect(res.status).toBe(400);
  });

  it('PRO-009 — photos must belong to the trip', async () => {
    const { user } = createUser(testDb);
    const { tripId, photoAId } = setupTripWithTwoPhotos(user.id);
    // Photo in a different trip
    const otherTrip = createTrip(testDb, user.id);
    const otherDay = createDay(testDb, otherTrip.id);
    const otherFile = testDb.prepare(`INSERT INTO trip_files (trip_id, filename, original_name, mime_type, file_size, uploaded_by) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(otherTrip.id, 'x.jpg', 'x.jpg', 'image/jpeg', 100, user.id);
    const otherPhoto = testDb.prepare(`INSERT INTO day_photos (day_id, upload_id, taken_at, lat, lng) VALUES (?, ?, ?, ?, ?)`)
      .run(otherDay.id, otherFile.lastInsertRowid, '2026-04-23T05:30:00Z', 0, 0);

    const res = await request(app)
      .put(`/api/trips/${tripId}/photo-route-overrides/${photoAId}/${otherPhoto.lastInsertRowid}`)
      .set('Cookie', authCookie(user.id))
      .send({ waypoints: [[-33.867, 151.210]] });
    expect(res.status).toBe(404);
  });

  it('PRO-010 — repeated PUT with same X-Client-Mutation-Id is idempotent', async () => {
    const { user } = createUser(testDb);
    const { tripId, photoAId, photoBId } = setupTripWithTwoPhotos(user.id);
    const mutationId = 'test-mutation-' + Date.now();

    const a = await request(app)
      .put(`/api/trips/${tripId}/photo-route-overrides/${photoAId}/${photoBId}`)
      .set('Cookie', authCookie(user.id))
      .set('X-Client-Mutation-Id', mutationId)
      .send({ waypoints: [[-33.867, 151.210]] });
    expect(a.status).toBe(200);

    // Same mutation ID, but DIFFERENT body — the cached response must
    // win (this is the offline-replay safety contract).
    const b = await request(app)
      .put(`/api/trips/${tripId}/photo-route-overrides/${photoAId}/${photoBId}`)
      .set('Cookie', authCookie(user.id))
      .set('X-Client-Mutation-Id', mutationId)
      .send({ waypoints: [[-33.999, 151.999]] });
    expect(b.status).toBe(200);
    expect(b.body.override.waypoints).toEqual(a.body.override.waypoints);
  });
});
