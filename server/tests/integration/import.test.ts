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

// [460-fork] M12 slices 2+3 — faithful off-boarding round-trip.
describe('M12 — faithful off-boarding round-trip', () => {
  it('IMPORT-012 — a segment-linked trip re-imports with a STANDALONE segment + re-associated days', async () => {
    const { user } = createUser(testDb);
    // Source trip with 3 dated days; days 2 and 3 belong to a segment.
    const trip = createTrip(testDb, user.id, { title: 'Segment source', start_date: '2027-06-10', end_date: '2027-06-12' });
    const days = testDb.prepare('SELECT id, date FROM days WHERE trip_id = ? ORDER BY date').all(trip.id) as Array<{ id: number; date: string }>;
    const segId = 'seg-src-0001';
    testDb.prepare(`INSERT INTO segments (id, title, start_date, end_date, created_by, updated_by) VALUES (?, 'Shared with Smiths', '2027-06-11', '2027-06-12', ?, ?)`).run(segId, user.id, user.id);
    testDb.prepare(`INSERT INTO trip_segments (trip_id, segment_id, is_home, joined_by) VALUES (?, ?, 1, ?)`).run(trip.id, segId, user.id);
    testDb.prepare('UPDATE days SET segment_id = ? WHERE id IN (?, ?)').run(segId, days[1].id, days[2].id);

    // Export → import.
    const exportRes = await request(app)
      .get(`/api/trips/${trip.id}/export`)
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
      .attach('file', exportRes.body as Buffer, 'seg.json');
    expect(importRes.status).toBe(201);
    const newTripId = importRes.body.result.trip_id;

    // A fresh standalone segment exists, linked is_home=1 to the new trip,
    // and exactly the two member days carry its id.
    const link = testDb.prepare('SELECT segment_id, is_home FROM trip_segments WHERE trip_id = ?').get(newTripId) as { segment_id: string; is_home: number };
    expect(link).toBeTruthy();
    expect(link.is_home).toBe(1);
    expect(link.segment_id).not.toBe(segId); // fresh UUID, not the source id

    const seg = testDb.prepare('SELECT title, start_date, end_date FROM segments WHERE id = ?').get(link.segment_id) as { title: string; start_date: string; end_date: string };
    expect(seg.title).toBe('Shared with Smiths');
    // Dates RECOMPUTED from the member days (11th–12th), not blindly copied.
    expect(seg.start_date).toBe('2027-06-11');
    expect(seg.end_date).toBe('2027-06-12');

    const taggedDays = testDb.prepare('SELECT date FROM days WHERE trip_id = ? AND segment_id = ? ORDER BY date').all(newTripId, link.segment_id) as Array<{ date: string }>;
    expect(taggedDays.map(d => d.date)).toEqual(['2027-06-11', '2027-06-12']);
  });

  it('IMPORT-013 — budget split re-links by email; unmatched email is skipped (no crash)', async () => {
    const { user: owner } = createUser(testDb, { email: 'owner@example.com', username: 'owner' });
    const trip = createTrip(testDb, owner.id, { title: 'Budget source' });
    const item = testDb.prepare(`INSERT INTO budget_items (trip_id, name, category, total_price) VALUES (?, 'Hotel', 'Lodging', 300)`).run(trip.id);
    const itemId = Number(item.lastInsertRowid);
    // Owner (will match by email on import) + a member who WON'T exist on import.
    testDb.prepare('INSERT INTO budget_item_members (budget_item_id, user_id, paid) VALUES (?, ?, 1)').run(itemId, owner.id);
    const ghost = createUser(testDb, { email: 'ghost@example.com', username: 'ghost' });
    testDb.prepare('INSERT INTO budget_item_members (budget_item_id, user_id, paid) VALUES (?, ?, 0)').run(itemId, ghost.user.id);

    const exportRes = await request(app)
      .get(`/api/trips/${trip.id}/export`)
      .set('Cookie', authCookie(owner.id))
      .buffer(true)
      .parse((response, callback) => {
        const chunks: Buffer[] = [];
        response.on('data', (c: Buffer) => chunks.push(c));
        response.on('end', () => callback(null, Buffer.concat(chunks)));
      });

    // Simulate the "moved to another instance" case: the ghost user does
    // NOT exist when we import. Delete them before importing.
    testDb.prepare('DELETE FROM budget_item_members WHERE user_id = ?').run(ghost.user.id);
    testDb.prepare('DELETE FROM users WHERE id = ?').run(ghost.user.id);

    const importRes = await request(app)
      .post('/api/trips/import?dry_run=false')
      .set('Cookie', authCookie(owner.id))
      .attach('file', exportRes.body as Buffer, 'budget.json');
    expect(importRes.status).toBe(201);
    const newTripId = importRes.body.result.trip_id;

    const newItem = testDb.prepare('SELECT id FROM budget_items WHERE trip_id = ?').get(newTripId) as { id: number };
    const members = testDb.prepare('SELECT user_id, paid FROM budget_item_members WHERE budget_item_id = ?').all(newItem.id) as Array<{ user_id: number; paid: number }>;
    // Owner re-linked by email (paid=1); ghost silently dropped (no account).
    expect(members).toHaveLength(1);
    expect(members[0].user_id).toBe(owner.id);
    expect(members[0].paid).toBe(1);
  });

  it('IMPORT-014 — bundle re-links a reservation-attached file to the imported reservation', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id, { title: 'Resv bundle' });
    const resv = testDb.prepare(`INSERT INTO reservations (trip_id, title, type, status) VALUES (?, 'QF1', 'flight', 'pending')`).run(trip.id);
    const reservationId = Number(resv.lastInsertRowid);
    const realName = `imp-resv-${Date.now()}.pdf`;
    const bytes = Buffer.from('%PDF-1.4 round-trip');
    fs.writeFileSync(path.join(filesDir, realName), bytes);
    testDb.prepare(`INSERT INTO trip_files (trip_id, filename, original_name, file_size, mime_type, uploaded_by, reservation_id) VALUES (?, ?, 'booking.pdf', ?, 'application/pdf', ?, ?)`).run(trip.id, realName, bytes.length, user.id, reservationId);

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
      .attach('file', exportRes.body as Buffer, 'resv.zip');
    expect(importRes.status).toBe(201);
    const newTripId = importRes.body.result.trip_id;

    const newResv = testDb.prepare('SELECT id FROM reservations WHERE trip_id = ?').get(newTripId) as { id: number };
    const linkedFile = testDb.prepare('SELECT filename, original_name, reservation_id FROM trip_files WHERE trip_id = ? AND reservation_id IS NOT NULL').get(newTripId) as { filename: string; original_name: string; reservation_id: number };
    expect(linkedFile).toBeTruthy();
    expect(linkedFile.reservation_id).toBe(newResv.id);
    expect(linkedFile.original_name).toBe('booking.pdf');
    expect(linkedFile.filename).not.toBe(realName); // fresh UUID
    const written = fs.readFileSync(path.join(filesDir, linkedFile.filename));
    expect(written.equals(bytes)).toBe(true);

    try { fs.unlinkSync(path.join(filesDir, realName)); } catch { /* ignore */ }
    try { fs.unlinkSync(path.join(filesDir, linkedFile.filename)); } catch { /* ignore */ }
  });
});
