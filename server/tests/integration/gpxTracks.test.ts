/**
 * [460-fork] M6 follow-up — GPX track endpoints.
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
import { createUser, createTrip, addTripMember } from '../helpers/factories';
import { authCookie } from '../helpers/auth';
import { loginAttempts, mfaAttempts } from '../../src/routes/auth';

const app: Application = createApp();

const SAMPLE_GPX = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Test">
  <trk>
    <name>Sydney Harbour Walk</name>
    <trkseg>
      <trkpt lat="-33.8568" lon="151.2153"><ele>5</ele></trkpt>
      <trkpt lat="-33.8569" lon="151.2160"><ele>5</ele></trkpt>
      <trkpt lat="-33.8580" lon="151.2170"><ele>4</ele></trkpt>
      <trkpt lat="-33.8595" lon="151.2185"><ele>3</ele></trkpt>
    </trkseg>
  </trk>
</gpx>`;

const ROUTE_GPX = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Test">
  <rte>
    <name>Planned route</name>
    <rtept lat="-33.8568" lon="151.2153" />
    <rtept lat="-33.8595" lon="151.2185" />
  </rte>
</gpx>`;

const EMPTY_GPX = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Test"></gpx>`;

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

describe('GPX tracks', () => {
  it('GPX-001 — POST parses trkpts and stores the polyline', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);

    const res = await request(app)
      .post(`/api/trips/${trip.id}/gpx-tracks`)
      .set('Cookie', authCookie(user.id))
      .attach('file', Buffer.from(SAMPLE_GPX), 'walk.gpx');

    expect(res.status).toBe(201);
    expect(res.body.track.point_count).toBe(4);
    expect(res.body.track.points).toHaveLength(4);
    expect(res.body.track.points[0]).toEqual([-33.8568, 151.2153]);
    expect(res.body.track.distance_m).toBeGreaterThan(0);
    // <trk><name> wins over the filename when no body name supplied.
    expect(res.body.track.name).toBe('Sydney Harbour Walk');
  });

  it('GPX-002 — explicit body `name` overrides the GPX <name>', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);

    const res = await request(app)
      .post(`/api/trips/${trip.id}/gpx-tracks`)
      .set('Cookie', authCookie(user.id))
      .field('name', 'Day 3 morning')
      .attach('file', Buffer.from(SAMPLE_GPX), 'walk.gpx');
    expect(res.status).toBe(201);
    expect(res.body.track.name).toBe('Day 3 morning');
  });

  it('GPX-003 — falls back to <rte><rtept> when no <trk>', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    const res = await request(app)
      .post(`/api/trips/${trip.id}/gpx-tracks`)
      .set('Cookie', authCookie(user.id))
      .attach('file', Buffer.from(ROUTE_GPX), 'r.gpx');
    expect(res.status).toBe(201);
    expect(res.body.track.point_count).toBe(2);
  });

  it('GPX-004 — empty GPX rejected', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    const res = await request(app)
      .post(`/api/trips/${trip.id}/gpx-tracks`)
      .set('Cookie', authCookie(user.id))
      .attach('file', Buffer.from(EMPTY_GPX), 'empty.gpx');
    expect(res.status).toBe(400);
  });

  it('GPX-005 — GET lists all tracks', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    await request(app).post(`/api/trips/${trip.id}/gpx-tracks`).set('Cookie', authCookie(user.id))
      .field('name', 'A').attach('file', Buffer.from(SAMPLE_GPX), 'a.gpx');
    await request(app).post(`/api/trips/${trip.id}/gpx-tracks`).set('Cookie', authCookie(user.id))
      .field('name', 'B').attach('file', Buffer.from(SAMPLE_GPX), 'b.gpx');

    const list = await request(app)
      .get(`/api/trips/${trip.id}/gpx-tracks`)
      .set('Cookie', authCookie(user.id));
    expect(list.status).toBe(200);
    expect(list.body.tracks).toHaveLength(2);
    expect(list.body.tracks.map((t: any) => t.name).sort()).toEqual(['A', 'B']);
  });

  it('GPX-006 — PATCH renames', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    const created = await request(app).post(`/api/trips/${trip.id}/gpx-tracks`).set('Cookie', authCookie(user.id))
      .attach('file', Buffer.from(SAMPLE_GPX), 'a.gpx');
    const id = created.body.track.id;

    const renamed = await request(app)
      .patch(`/api/trips/${trip.id}/gpx-tracks/${id}`)
      .set('Cookie', authCookie(user.id))
      .send({ name: 'Renamed' });
    expect(renamed.status).toBe(200);
    expect(renamed.body.track.name).toBe('Renamed');
  });

  it('GPX-007 — DELETE removes', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    const created = await request(app).post(`/api/trips/${trip.id}/gpx-tracks`).set('Cookie', authCookie(user.id))
      .attach('file', Buffer.from(SAMPLE_GPX), 'a.gpx');
    const id = created.body.track.id;

    const del = await request(app)
      .delete(`/api/trips/${trip.id}/gpx-tracks/${id}`)
      .set('Cookie', authCookie(user.id));
    expect(del.status).toBe(200);
    expect(del.body.removed).toBe(true);

    const list = await request(app)
      .get(`/api/trips/${trip.id}/gpx-tracks`)
      .set('Cookie', authCookie(user.id));
    expect(list.body.tracks).toHaveLength(0);
  });

  it('GPX-008 — non-member cannot upload or list', async () => {
    const { user: owner } = createUser(testDb);
    const { user: stranger } = createUser(testDb);
    const trip = createTrip(testDb, owner.id);

    const post = await request(app)
      .post(`/api/trips/${trip.id}/gpx-tracks`)
      .set('Cookie', authCookie(stranger.id))
      .attach('file', Buffer.from(SAMPLE_GPX), 'a.gpx');
    expect(post.status).toBe(404);

    const get = await request(app)
      .get(`/api/trips/${trip.id}/gpx-tracks`)
      .set('Cookie', authCookie(stranger.id));
    expect(get.status).toBe(404);
  });

  it('GPX-009 — trip member with edit permission can upload', async () => {
    const { user: owner } = createUser(testDb);
    const { user: collab } = createUser(testDb);
    const trip = createTrip(testDb, owner.id);
    addTripMember(testDb, trip.id, collab.id);

    const res = await request(app)
      .post(`/api/trips/${trip.id}/gpx-tracks`)
      .set('Cookie', authCookie(collab.id))
      .attach('file', Buffer.from(SAMPLE_GPX), 'a.gpx');
    expect(res.status).toBe(201);
  });

  it('GPX-010 — deleting the trip cascades to its tracks', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    await request(app).post(`/api/trips/${trip.id}/gpx-tracks`).set('Cookie', authCookie(user.id))
      .attach('file', Buffer.from(SAMPLE_GPX), 'a.gpx');

    testDb.prepare('DELETE FROM trips WHERE id = ?').run(trip.id);
    // Scope to *this* trip's tracks — gpx_tracks isn't in the test
    // helper's reset list, so a global COUNT picks up residue from
    // earlier tests in the file. The point of this assertion is the
    // cascade, not isolation.
    const remaining = testDb.prepare('SELECT COUNT(*) AS cnt FROM gpx_tracks WHERE trip_id = ?').get(trip.id) as { cnt: number };
    expect(remaining.cnt).toBe(0);
  });
});
