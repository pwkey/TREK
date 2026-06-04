/**
 * [460-fork] Milestone 6 slice 2 — per-day photo endpoints.
 * Covers DAYPHOTO-001 to DAYPHOTO-010.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import path from 'path';
import fs from 'fs';
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
import { authCookie, authHeader } from '../helpers/auth';
import { loginAttempts, mfaAttempts } from '../../src/routes/auth';
import { filesDir, thumbsDir, thumbFilename } from '../../src/services/fileService';

const app: Application = createApp();

// Tiny valid JPEG (smallest legal one — 125 bytes). Enough to satisfy
// multer's image/* mimetype check via supertest's Buffer attachment.
const TINY_JPEG = Buffer.from([
  0xff,0xd8,0xff,0xe0,0x00,0x10,0x4a,0x46,0x49,0x46,0x00,0x01,0x01,0x01,0x00,0x48,
  0x00,0x48,0x00,0x00,0xff,0xdb,0x00,0x43,0x00,0x08,0x06,0x06,0x07,0x06,0x05,0x08,
  0x07,0x07,0x07,0x09,0x09,0x08,0x0a,0x0c,0x14,0x0d,0x0c,0x0b,0x0b,0x0c,0x19,0x12,
  0x13,0x0f,0x14,0x1d,0x1a,0x1f,0x1e,0x1d,0x1a,0x1c,0x1c,0x20,0x24,0x2e,0x27,0x20,
  0x22,0x2c,0x23,0x1c,0x1c,0x28,0x37,0x29,0x2c,0x30,0x31,0x34,0x34,0x34,0x1f,0x27,
  0x39,0x3d,0x38,0x32,0x3c,0x2e,0x33,0x34,0x32,0xff,0xc0,0x00,0x0b,0x08,0x00,0x01,
  0x00,0x01,0x01,0x01,0x11,0x00,0xff,0xc4,0x00,0x14,0x00,0x01,0x00,0x00,0x00,0x00,
  0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0xff,0xda,0x00,0x08,
  0x01,0x01,0x00,0x00,0x3f,0x00,0x37,0xff,0xd9,
]);

beforeAll(() => {
  createTables(testDb);
  runMigrations(testDb);
  if (!fs.existsSync(filesDir)) fs.mkdirSync(filesDir, { recursive: true });
});

beforeEach(() => {
  resetTestDb(testDb);
  loginAttempts.clear();
  mfaAttempts.clear();
});

afterAll(() => {
  testDb.close();
});

describe('Upload day photo', () => {
  it('DAYPHOTO-001 — POST attaches a photo to a day and returns the row', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    const day = createDay(testDb, trip.id);

    const res = await request(app)
      .post(`/api/trips/${trip.id}/days/${day.id}/photos`)
      .set('Cookie', authCookie(user.id))
      .field('caption', 'Sunrise from the room')
      .field('taken_at', '2026-04-21T05:30:00Z')
      .attach('file', TINY_JPEG, 'sunrise.jpg');

    expect(res.status).toBe(201);
    expect(res.body.photo.day_id).toBe(day.id);
    expect(res.body.photo.caption).toBe('Sunrise from the room');
    expect(res.body.photo.taken_at).toBe('2026-04-21T05:30:00Z');
    expect(res.body.photo.position).toBe(0);
    expect(res.body.photo.upload_id).toBeDefined();

    // The underlying trip_files row exists.
    const filesRow = testDb.prepare('SELECT id FROM trip_files WHERE id = ?').get(res.body.photo.upload_id);
    expect(filesRow).toBeDefined();
  });

  it('DAYPHOTO-002 — non-image file rejected', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    const day = createDay(testDb, trip.id);

    const res = await request(app)
      .post(`/api/trips/${trip.id}/days/${day.id}/photos`)
      .set('Cookie', authCookie(user.id))
      .attach('file', Buffer.from('hello world'), { filename: 'note.txt', contentType: 'text/plain' });

    expect(res.status).toBe(400);
  });

  it('DAYPHOTO-003 — non-member cannot upload', async () => {
    const { user: owner } = createUser(testDb);
    const { user: stranger } = createUser(testDb);
    const trip = createTrip(testDb, owner.id);
    const day = createDay(testDb, trip.id);

    const res = await request(app)
      .post(`/api/trips/${trip.id}/days/${day.id}/photos`)
      .set('Cookie', authCookie(stranger.id))
      .attach('file', TINY_JPEG, 'a.jpg');

    expect(res.status).toBe(404);
  });

  it('DAYPHOTO-004 — trip member with edit permission can upload', async () => {
    const { user: owner } = createUser(testDb);
    const { user: collaborator } = createUser(testDb);
    const trip = createTrip(testDb, owner.id);
    addTripMember(testDb, trip.id, collaborator.id);
    const day = createDay(testDb, trip.id);

    const res = await request(app)
      .post(`/api/trips/${trip.id}/days/${day.id}/photos`)
      .set('Cookie', authCookie(collaborator.id))
      .attach('file', TINY_JPEG, 'b.jpg');

    expect(res.status).toBe(201);
  });
});

describe('List day photos', () => {
  it('DAYPHOTO-005 — GET returns photos in position order', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    const day = createDay(testDb, trip.id);

    await request(app).post(`/api/trips/${trip.id}/days/${day.id}/photos`).set('Cookie', authCookie(user.id)).attach('file', TINY_JPEG, '1.jpg');
    await request(app).post(`/api/trips/${trip.id}/days/${day.id}/photos`).set('Cookie', authCookie(user.id)).attach('file', TINY_JPEG, '2.jpg');
    await request(app).post(`/api/trips/${trip.id}/days/${day.id}/photos`).set('Cookie', authCookie(user.id)).attach('file', TINY_JPEG, '3.jpg');

    const res = await request(app)
      .get(`/api/trips/${trip.id}/days/${day.id}/photos`)
      .set('Cookie', authCookie(user.id));
    expect(res.status).toBe(200);
    expect(res.body.photos).toHaveLength(3);
    expect(res.body.photos.map((p: { position: number }) => p.position)).toEqual([0, 1, 2]);
  });
});

describe('Update day photo', () => {
  it('DAYPHOTO-006 — PUT changes caption', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    const day = createDay(testDb, trip.id);

    const created = await request(app)
      .post(`/api/trips/${trip.id}/days/${day.id}/photos`)
      .set('Cookie', authCookie(user.id))
      .field('caption', 'orig')
      .attach('file', TINY_JPEG, 'a.jpg');

    const res = await request(app)
      .put(`/api/trips/${trip.id}/days/${day.id}/photos/${created.body.photo.id}`)
      .set('Cookie', authCookie(user.id))
      .send({ caption: 'edited' });
    expect(res.status).toBe(200);
    expect(res.body.photo.caption).toBe('edited');
  });

  it('DAYPHOTO-007 — PUT validates types', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    const day = createDay(testDb, trip.id);

    const created = await request(app)
      .post(`/api/trips/${trip.id}/days/${day.id}/photos`)
      .set('Cookie', authCookie(user.id))
      .attach('file', TINY_JPEG, 'a.jpg');

    const res = await request(app)
      .put(`/api/trips/${trip.id}/days/${day.id}/photos/${created.body.photo.id}`)
      .set('Cookie', authCookie(user.id))
      .send({ caption: 12345 });
    expect(res.status).toBe(400);
  });
});

describe('Reorder day photos', () => {
  it('DAYPHOTO-008 — PUT /reorder applies new ordering', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    const day = createDay(testDb, trip.id);

    const a = (await request(app).post(`/api/trips/${trip.id}/days/${day.id}/photos`).set('Cookie', authCookie(user.id)).attach('file', TINY_JPEG, '1.jpg')).body.photo.id;
    const b = (await request(app).post(`/api/trips/${trip.id}/days/${day.id}/photos`).set('Cookie', authCookie(user.id)).attach('file', TINY_JPEG, '2.jpg')).body.photo.id;
    const c = (await request(app).post(`/api/trips/${trip.id}/days/${day.id}/photos`).set('Cookie', authCookie(user.id)).attach('file', TINY_JPEG, '3.jpg')).body.photo.id;

    const res = await request(app)
      .put(`/api/trips/${trip.id}/days/${day.id}/photos/reorder`)
      .set('Cookie', authCookie(user.id))
      .send({ orderedIds: [c, a, b] });
    expect(res.status).toBe(200);
    expect(res.body.photos.map((p: { id: number }) => p.id)).toEqual([c, a, b]);
  });
});

describe('GPS round-trip', () => {
  it('DAYPHOTO-011 — POST stores lat/lng form fields and GET returns them', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    const day = createDay(testDb, trip.id);

    const created = await request(app)
      .post(`/api/trips/${trip.id}/days/${day.id}/photos`)
      .set('Cookie', authCookie(user.id))
      .field('lat', '48.8566')
      .field('lng', '2.3522')
      .attach('file', TINY_JPEG, 'paris.jpg');
    expect(created.status).toBe(201);
    expect(created.body.photo.lat).toBeCloseTo(48.8566, 4);
    expect(created.body.photo.lng).toBeCloseTo(2.3522, 4);

    const list = await request(app)
      .get(`/api/trips/${trip.id}/days/${day.id}/photos`)
      .set('Cookie', authCookie(user.id));
    expect(list.body.photos[0].lat).toBeCloseTo(48.8566, 4);
    expect(list.body.photos[0].lng).toBeCloseTo(2.3522, 4);
  });

  it('DAYPHOTO-013 — altitude + camera round-trip', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    const day = createDay(testDb, trip.id);

    const created = await request(app)
      .post(`/api/trips/${trip.id}/days/${day.id}/photos`)
      .set('Cookie', authCookie(user.id))
      .field('altitude', '2742')
      .field('camera', 'Apple iPhone 15 Pro')
      .attach('file', TINY_JPEG, 'mountain.jpg');
    expect(created.status).toBe(201);
    expect(created.body.photo.altitude).toBeCloseTo(2742, 0);
    expect(created.body.photo.camera).toBe('Apple iPhone 15 Pro');

    const list = await request(app)
      .get(`/api/trips/${trip.id}/days/${day.id}/photos`)
      .set('Cookie', authCookie(user.id));
    expect(list.body.photos[0].altitude).toBeCloseTo(2742, 0);
    expect(list.body.photos[0].camera).toBe('Apple iPhone 15 Pro');
  });

  it('DAYPHOTO-014 — implausible altitude silently dropped', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    const day = createDay(testDb, trip.id);

    const res = await request(app)
      .post(`/api/trips/${trip.id}/days/${day.id}/photos`)
      .set('Cookie', authCookie(user.id))
      .field('altitude', '99999999')
      .attach('file', TINY_JPEG, 'bad-alt.jpg');
    expect(res.status).toBe(201);
    expect(res.body.photo.altitude).toBeNull();
  });

  it('DAYPHOTO-012 — out-of-range lat/lng silently dropped', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    const day = createDay(testDb, trip.id);

    const res = await request(app)
      .post(`/api/trips/${trip.id}/days/${day.id}/photos`)
      .set('Cookie', authCookie(user.id))
      .field('lat', '999')
      .field('lng', '-999')
      .attach('file', TINY_JPEG, 'bad.jpg');
    expect(res.status).toBe(201);
    expect(res.body.photo.lat).toBeNull();
    expect(res.body.photo.lng).toBeNull();
  });
});

describe('Delete day photo', () => {
  it('DAYPHOTO-009 — DELETE removes the row AND the trip_files row', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    const day = createDay(testDb, trip.id);

    const created = await request(app)
      .post(`/api/trips/${trip.id}/days/${day.id}/photos`)
      .set('Cookie', authCookie(user.id))
      .attach('file', TINY_JPEG, 'a.jpg');
    const uploadId = created.body.photo.upload_id;
    const photoId = created.body.photo.id;

    const res = await request(app)
      .delete(`/api/trips/${trip.id}/days/${day.id}/photos/${photoId}`)
      .set('Cookie', authCookie(user.id));
    expect(res.status).toBe(200);

    const dpRow = testDb.prepare('SELECT id FROM day_photos WHERE id = ?').get(photoId);
    expect(dpRow).toBeUndefined();
    const fileRow = testDb.prepare('SELECT id FROM trip_files WHERE id = ?').get(uploadId);
    expect(fileRow).toBeUndefined();
  });

  it('DAYPHOTO-010 — DELETE on a photo that does not belong to the day returns 404', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    const dayA = createDay(testDb, trip.id, { day_number: 1 });
    const dayB = createDay(testDb, trip.id, { day_number: 2 });

    const created = await request(app)
      .post(`/api/trips/${trip.id}/days/${dayA.id}/photos`)
      .set('Cookie', authCookie(user.id))
      .attach('file', TINY_JPEG, 'a.jpg');

    // Try to delete dayA's photo via dayB's URL.
    const res = await request(app)
      .delete(`/api/trips/${trip.id}/days/${dayB.id}/photos/${created.body.photo.id}`)
      .set('Cookie', authCookie(user.id));
    expect(res.status).toBe(404);
  });
});

// [460-fork] Thumbnail generation + serving.
describe('Photo thumbnails', () => {
  async function uploadPhoto(userId: number, tripId: number, dayId: number, name = 'a.jpg') {
    const res = await request(app)
      .post(`/api/trips/${tripId}/days/${dayId}/photos`)
      .set('Cookie', authCookie(userId))
      .attach('file', TINY_JPEG, name);
    expect(res.status).toBe(201);
    const uploadId = res.body.photo.upload_id as number;
    const photoId = res.body.photo.id as number;
    const row = testDb.prepare('SELECT filename FROM trip_files WHERE id = ?').get(uploadId) as { filename: string };
    return { photoId, uploadId, filename: row.filename };
  }

  it('DAYPHOTO-THUMB-1 — upload generates a thumbnail and ?thumb=1 serves it', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    const day = createDay(testDb, trip.id);

    const { uploadId, filename } = await uploadPhoto(user.id, trip.id, day.id);
    const thumbPath = path.join(thumbsDir, thumbFilename(filename));
    expect(fs.existsSync(thumbPath)).toBe(true);

    const dl = await request(app)
      .get(`/api/trips/${trip.id}/files/${uploadId}/download?thumb=1`)
      .set(authHeader(user.id));
    expect(dl.status).toBe(200);
  });

  it('DAYPHOTO-THUMB-2 — ?thumb=1 falls back to the original when no thumbnail exists', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    const day = createDay(testDb, trip.id);

    const { uploadId, filename } = await uploadPhoto(user.id, trip.id, day.id, 'b.jpg');
    // Simulate an old photo / failed generation by removing the thumb.
    const thumbPath = path.join(thumbsDir, thumbFilename(filename));
    if (fs.existsSync(thumbPath)) fs.unlinkSync(thumbPath);

    const dl = await request(app)
      .get(`/api/trips/${trip.id}/files/${uploadId}/download?thumb=1`)
      .set(authHeader(user.id));
    expect(dl.status).toBe(200); // served the original
  });

  it('DAYPHOTO-THUMB-3 — deleting a photo removes its thumbnail', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    const day = createDay(testDb, trip.id);

    const { photoId, filename } = await uploadPhoto(user.id, trip.id, day.id, 'c.jpg');
    const thumbPath = path.join(thumbsDir, thumbFilename(filename));
    expect(fs.existsSync(thumbPath)).toBe(true);

    const del = await request(app)
      .delete(`/api/trips/${trip.id}/days/${day.id}/photos/${photoId}`)
      .set('Cookie', authCookie(user.id));
    expect(del.status).toBe(200);
    expect(fs.existsSync(thumbPath)).toBe(false);
  });
});
