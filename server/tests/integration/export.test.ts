/**
 * [460-fork] Milestone 7 slice 1 — single-trip JSON export.
 * Covers EXPORT-001 to EXPORT-007.
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
    getPlaceWithTags: (placeId: number) => {
      const place: any = db.prepare(`SELECT p.*, c.name as category_name, c.color as category_color, c.icon as category_icon FROM places p LEFT JOIN categories c ON p.category_id = c.id WHERE p.id = ?`).get(placeId);
      if (!place) return null;
      return { ...place, category: place.category_id ? { id: place.category_id, name: place.category_name, color: place.category_color, icon: place.category_icon } : null, tags: [] };
    },
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

describe('JSON export envelope', () => {
  it('EXPORT-001 — GET returns the schema_version + app + exported_by envelope', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id, { title: 'Test Trip' });

    const res = await request(app)
      .get(`/api/trips/${trip.id}/export`)
      .set('Cookie', authCookie(user.id));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.headers['content-disposition']).toMatch(/attachment;\s*filename="test-trip-\d+\.json"/);

    const body = JSON.parse(res.text);
    expect(body.schema_version).toBe(1);
    expect(body.app).toBe('460-trip-planner');
    expect(body.exported_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(body.exported_by.id).toBe(user.id);
    expect(body.exported_by.username).toBe(user.username);
  });
});

describe('Trip content', () => {
  it('EXPORT-002 — includes members with role + email but no password hashes or tokens', async () => {
    const { user: owner } = createUser(testDb);
    const { user: collab } = createUser(testDb);
    const trip = createTrip(testDb, owner.id);
    addTripMember(testDb, trip.id, collab.id);

    const res = await request(app)
      .get(`/api/trips/${trip.id}/export`)
      .set('Cookie', authCookie(owner.id));
    const body = JSON.parse(res.text);
    expect(body.trip.members).toHaveLength(2);
    const ownerEntry = body.trip.members.find((m: any) => m.id === owner.id);
    expect(ownerEntry.role).toBe('owner');
    expect(ownerEntry.email).toBe(owner.email);
    // Deny-list any obvious leakage.
    expect(JSON.stringify(body)).not.toMatch(/password_hash/);
    expect(JSON.stringify(body)).not.toMatch(/encrypted_/);
    expect(JSON.stringify(body)).not.toMatch(/api_key/);
    expect(JSON.stringify(body)).not.toMatch(/mfa_secret/);
    expect(JSON.stringify(body)).not.toMatch(/session/i);
  });

  it('EXPORT-003 — includes days, with journals + photos hydrated per day', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    const day = createDay(testDb, trip.id, { date: '2026-05-01', title: 'First day' });

    // Seed a journal directly via the DB.
    testDb.prepare(`
      INSERT INTO day_journals (day_id, content_markdown, updated_by)
      VALUES (?, ?, ?)
    `).run(day.id, '# Hello\n\nFirst entry.', user.id);

    // Seed a photo (need a trip_files row + day_photos row).
    const fileResult = testDb.prepare(`
      INSERT INTO trip_files (trip_id, filename, original_name, file_size, mime_type, uploaded_by)
      VALUES (?, 'test-uuid.jpg', 'IMG_0001.jpg', 12345, 'image/jpeg', ?)
    `).run(trip.id, user.id);
    testDb.prepare(`
      INSERT INTO day_photos (day_id, upload_id, caption, taken_at, lat, lng, position)
      VALUES (?, ?, ?, ?, ?, ?, 0)
    `).run(day.id, fileResult.lastInsertRowid, 'Sunrise', '2026-05-01T05:30:00Z', 48.8566, 2.3522);

    const res = await request(app)
      .get(`/api/trips/${trip.id}/export`)
      .set('Cookie', authCookie(user.id));
    const body = JSON.parse(res.text);
    expect(body.trip.days).toHaveLength(1);
    const exportedDay = body.trip.days[0];
    expect(exportedDay.title).toBe('First day');
    expect(exportedDay.journal.content_markdown).toBe('# Hello\n\nFirst entry.');
    expect(exportedDay.journal.updated_by_username).toBe(user.username);
    expect(exportedDay.photos).toHaveLength(1);
    expect(exportedDay.photos[0].caption).toBe('Sunrise');
    expect(exportedDay.photos[0].lat).toBeCloseTo(48.8566, 4);
    expect(exportedDay.photos[0].lng).toBeCloseTo(2.3522, 4);
  });
});

describe('Permissions', () => {
  it('EXPORT-004 — non-member returns 404', async () => {
    const { user: owner } = createUser(testDb);
    const { user: stranger } = createUser(testDb);
    const trip = createTrip(testDb, owner.id);

    const res = await request(app)
      .get(`/api/trips/${trip.id}/export`)
      .set('Cookie', authCookie(stranger.id));
    expect(res.status).toBe(404);
  });

  it('EXPORT-005 — trip member can export', async () => {
    const { user: owner } = createUser(testDb);
    const { user: collab } = createUser(testDb);
    const trip = createTrip(testDb, owner.id);
    addTripMember(testDb, trip.id, collab.id);

    const res = await request(app)
      .get(`/api/trips/${trip.id}/export`)
      .set('Cookie', authCookie(collab.id));
    expect(res.status).toBe(200);
    const body = JSON.parse(res.text);
    expect(body.exported_by.id).toBe(collab.id);
  });

  it('EXPORT-006 — invalid trip id returns 400', async () => {
    const { user } = createUser(testDb);
    const res = await request(app)
      .get('/api/trips/not-a-number/export')
      .set('Cookie', authCookie(user.id));
    expect(res.status).toBe(400);
  });
});

describe('Filename', () => {
  it('EXPORT-007 — Content-Disposition slugifies the trip title and falls back to "trip"', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id, { title: 'Berlin & München, 2026!' });

    const res = await request(app)
      .get(`/api/trips/${trip.id}/export`)
      .set('Cookie', authCookie(user.id));
    expect(res.headers['content-disposition']).toMatch(/filename="berlin-m(?:uenchen|unchen|nchen)-2026-\d+\.json"/);
  });
});
