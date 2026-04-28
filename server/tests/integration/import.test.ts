/**
 * [460-fork] Milestone 7 slice 3 — JSON / bundle import.
 * Covers IMPORT-001 to IMPORT-008.
 *
 * Strategy: round-trip through the export to keep the test envelopes
 * realistic. Each test builds a small source trip, exports it, then
 * imports the result and asserts the new trip matches the source.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import path from 'node:path';
import fs from 'node:fs';
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
import { createUser, createTrip, createDay } from '../helpers/factories';
import { authCookie } from '../helpers/auth';
import { loginAttempts, mfaAttempts } from '../../src/routes/auth';
import { filesDir } from '../../src/services/fileService';

const app: Application = createApp();

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

/** Build a source trip, export it, return the JSON envelope buffer. */
async function buildAndExport(userId: number, tripTitle: string, opts: { format: 'json' | 'bundle' } = { format: 'json' }) {
  const trip = createTrip(testDb, userId, { title: tripTitle });
  const day = createDay(testDb, trip.id, { date: '2026-05-01', title: 'First day' });
  testDb.prepare(`INSERT INTO places (trip_id, name) VALUES (?, ?)`).run(trip.id, 'Eiffel Tower');
  testDb.prepare(`INSERT INTO day_journals (day_id, content_markdown, updated_by) VALUES (?, ?, ?)`).run(day.id, '# Day one\nThe markets.', userId);
  const cookie = authCookie(userId);
  const res = await request(app)
    .get(opts.format === 'bundle' ? `/api/trips/${trip.id}/export/bundle` : `/api/trips/${trip.id}/export`)
    .set('Cookie', cookie)
    .buffer(true)
    .parse((response, callback) => {
      const chunks: Buffer[] = [];
      response.on('data', (c: Buffer) => chunks.push(c));
      response.on('end', () => callback(null, Buffer.concat(chunks)));
    });
  expect(res.status).toBe(200);
  return { sourceTripId: trip.id, payload: res.body as Buffer };
}

describe('Import dry run', () => {
  it('IMPORT-001 — POST without ?dry_run=false returns the dry-run report and writes nothing', async () => {
    const { user } = createUser(testDb);
    const { payload } = await buildAndExport(user.id, 'Source A');
    const tripCountBefore = (testDb.prepare('SELECT COUNT(*) AS n FROM trips').get() as { n: number }).n;

    const res = await request(app)
      .post('/api/trips/import')
      .set('Cookie', authCookie(user.id))
      .attach('file', payload, 'export.json');
    expect(res.status).toBe(200);
    expect(res.body.dry_run).toBe(true);
    expect(res.body.report.would_create.trip).toBe(1);
    expect(res.body.report.would_create.days).toBe(1);
    expect(res.body.report.would_create.places).toBe(1);
    expect(res.body.report.would_create.journals).toBe(1);
    expect(res.body.report.source_trip.title).toBe('Source A');

    const tripCountAfter = (testDb.prepare('SELECT COUNT(*) AS n FROM trips').get() as { n: number }).n;
    expect(tripCountAfter).toBe(tripCountBefore);
  });

  it('IMPORT-002 — bundle dry-run reports photos_with_binary correctly', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    const day = createDay(testDb, trip.id);
    // Seed a photo with a real-but-tiny file on disk so the export bundle picks it up.
    const realName = `imp-test-${Date.now()}.jpg`;
    fs.writeFileSync(path.join(filesDir, realName), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    const tf = testDb.prepare(`INSERT INTO trip_files (trip_id, filename, original_name, file_size, mime_type, uploaded_by) VALUES (?, ?, 'IMG.jpg', 4, 'image/jpeg', ?)`).run(trip.id, realName, user.id);
    testDb.prepare(`INSERT INTO day_photos (day_id, upload_id, position) VALUES (?, ?, 0)`).run(day.id, tf.lastInsertRowid);

    const exportRes = await request(app)
      .get(`/api/trips/${trip.id}/export/bundle`)
      .set('Cookie', authCookie(user.id))
      .buffer(true)
      .parse((response, callback) => {
        const chunks: Buffer[] = [];
        response.on('data', (c: Buffer) => chunks.push(c));
        response.on('end', () => callback(null, Buffer.concat(chunks)));
      });
    expect(exportRes.status).toBe(200);

    const res = await request(app)
      .post('/api/trips/import')
      .set('Cookie', authCookie(user.id))
      .attach('file', exportRes.body as Buffer, 'bundle.zip');
    expect(res.body.report.would_create.photos_with_binary).toBe(1);
    expect(res.body.report.would_create.photos_metadata_only).toBe(0);

    try { fs.unlinkSync(path.join(filesDir, realName)); } catch { /* ignore */ }
  });

  it('IMPORT-003 — schema_version mismatch returns errors', async () => {
    const { user } = createUser(testDb);
    const bad = JSON.stringify({ schema_version: 999, app: '460-trip-planner', trip: { title: 'x' } });

    const res = await request(app)
      .post('/api/trips/import')
      .set('Cookie', authCookie(user.id))
      .attach('file', Buffer.from(bad), 'bad.json');
    expect(res.status).toBe(200);
    expect(res.body.report.errors.length).toBeGreaterThan(0);
    expect(res.body.report.errors.join(' ')).toMatch(/schema_version/);
  });

  it('IMPORT-004 — non-JSON / non-zip input returns 400', async () => {
    const { user } = createUser(testDb);
    const res = await request(app)
      .post('/api/trips/import')
      .set('Cookie', authCookie(user.id))
      .attach('file', Buffer.from('not valid'), 'garbage.json');
    expect(res.status).toBe(400);
  });
});

describe('Import apply', () => {
  it('IMPORT-005 — confirm=false (apply) creates a new trip owned by the importer', async () => {
    const { user: source } = createUser(testDb);
    const { user: importer } = createUser(testDb);
    const { sourceTripId, payload } = await buildAndExport(source.id, 'Source B');

    const res = await request(app)
      .post('/api/trips/import?dry_run=false')
      .set('Cookie', authCookie(importer.id))
      .attach('file', payload, 'export.json');
    expect(res.status).toBe(201);
    expect(res.body.dry_run).toBe(false);
    expect(res.body.result.trip_id).toBeGreaterThan(0);
    expect(res.body.result.trip_id).not.toBe(sourceTripId);

    const created = testDb.prepare('SELECT id, title, user_id FROM trips WHERE id = ?').get(res.body.result.trip_id) as { id: number; title: string; user_id: number };
    expect(created.title).toBe('Source B');
    expect(created.user_id).toBe(importer.id); // owned by importer, not source user
  });

  it('IMPORT-006 — apply restores days, places, assignments, and journals', async () => {
    const { user } = createUser(testDb);
    // Build a source with a place + day + assignment + journal.
    const sTrip = createTrip(testDb, user.id, { title: 'Round-trip' });
    const sDay = createDay(testDb, sTrip.id, { date: '2026-06-01', title: 'D1' });
    const placeRes = testDb.prepare(`INSERT INTO places (trip_id, name) VALUES (?, ?)`).run(sTrip.id, 'Cathedral');
    testDb.prepare(`INSERT INTO day_assignments (day_id, place_id, order_index) VALUES (?, ?, 0)`).run(sDay.id, placeRes.lastInsertRowid);
    testDb.prepare(`INSERT INTO day_journals (day_id, content_markdown, updated_by) VALUES (?, 'Hello', ?)`).run(sDay.id, user.id);

    // Export.
    const exportRes = await request(app)
      .get(`/api/trips/${sTrip.id}/export`)
      .set('Cookie', authCookie(user.id))
      .buffer(true)
      .parse((response, callback) => {
        const chunks: Buffer[] = [];
        response.on('data', (c: Buffer) => chunks.push(c));
        response.on('end', () => callback(null, Buffer.concat(chunks)));
      });

    // Import.
    const importRes = await request(app)
      .post('/api/trips/import?dry_run=false')
      .set('Cookie', authCookie(user.id))
      .attach('file', exportRes.body as Buffer, 'export.json');
    expect(importRes.status).toBe(201);
    const newTripId = importRes.body.result.trip_id;

    // Verify the imported trip has the same shape.
    const days = testDb.prepare('SELECT id, title FROM days WHERE trip_id = ?').all(newTripId) as { id: number; title: string }[];
    expect(days).toHaveLength(1);
    expect(days[0].title).toBe('D1');

    const places = testDb.prepare('SELECT id, name FROM places WHERE trip_id = ?').all(newTripId) as { id: number; name: string }[];
    expect(places).toHaveLength(1);
    expect(places[0].name).toBe('Cathedral');

    const assignments = testDb.prepare('SELECT id, day_id, place_id FROM day_assignments WHERE day_id = ?').all(days[0].id) as any[];
    expect(assignments).toHaveLength(1);
    expect(assignments[0].place_id).toBe(places[0].id);

    const journal = testDb.prepare('SELECT content_markdown FROM day_journals WHERE day_id = ?').get(days[0].id) as { content_markdown: string };
    expect(journal.content_markdown).toBe('Hello');
  });

  it('IMPORT-007 — bundle apply writes photo binaries to disk and links them', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id, { title: 'Photo bundle' });
    const day = createDay(testDb, trip.id);
    // Real binary on disk.
    const realName = `imp-bin-${Date.now()}.jpg`;
    const expectedBytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    fs.writeFileSync(path.join(filesDir, realName), expectedBytes);
    const tf = testDb.prepare(`INSERT INTO trip_files (trip_id, filename, original_name, file_size, mime_type, uploaded_by) VALUES (?, ?, 'IMG.jpg', 4, 'image/jpeg', ?)`).run(trip.id, realName, user.id);
    testDb.prepare(`INSERT INTO day_photos (day_id, upload_id, caption, position) VALUES (?, ?, 'Sunset', 0)`).run(day.id, tf.lastInsertRowid);

    const exportRes = await request(app)
      .get(`/api/trips/${trip.id}/export/bundle`)
      .set('Cookie', authCookie(user.id))
      .buffer(true)
      .parse((response, callback) => {
        const chunks: Buffer[] = [];
        response.on('data', (c: Buffer) => chunks.push(c));
        response.on('end', () => callback(null, Buffer.concat(chunks)));
      });

    const importRes = await request(app)
      .post('/api/trips/import?dry_run=false')
      .set('Cookie', authCookie(user.id))
      .attach('file', exportRes.body as Buffer, 'bundle.zip');
    expect(importRes.status).toBe(201);
    const newTripId = importRes.body.result.trip_id;

    const newPhoto = testDb.prepare(`
      SELECT dp.caption, f.filename, f.file_size FROM day_photos dp
      JOIN trip_files f ON f.id = dp.upload_id
      JOIN days d ON d.id = dp.day_id
      WHERE d.trip_id = ?
    `).get(newTripId) as { caption: string; filename: string; file_size: number };
    expect(newPhoto.caption).toBe('Sunset');
    expect(newPhoto.filename).not.toBe(realName); // should be a fresh UUID
    expect(newPhoto.file_size).toBe(expectedBytes.length);

    const writtenBytes = fs.readFileSync(path.join(filesDir, newPhoto.filename));
    expect(writtenBytes.equals(expectedBytes)).toBe(true);

    // Cleanup both the source seed file and the imported copy.
    try { fs.unlinkSync(path.join(filesDir, realName)); } catch { /* ignore */ }
    try { fs.unlinkSync(path.join(filesDir, newPhoto.filename)); } catch { /* ignore */ }
  });

  it('IMPORT-008 — apply with validation errors returns 400, not 201', async () => {
    const { user } = createUser(testDb);
    const bad = JSON.stringify({ schema_version: 999, trip: { title: 'x' } });

    const res = await request(app)
      .post('/api/trips/import?dry_run=false')
      .set('Cookie', authCookie(user.id))
      .attach('file', Buffer.from(bad), 'bad.json');
    expect(res.status).toBe(400);
    expect(res.body.report.errors.length).toBeGreaterThan(0);
  });
});
