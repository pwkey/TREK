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
  testDb.prepare(`INSERT INTO day_journals (day_id, trip_id, content_markdown, updated_by) VALUES (?, ?, ?, ?)`).run(day.id, trip.id, '# Day one\nThe markets.', userId);
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
    testDb.prepare(`INSERT INTO day_photos (day_id, trip_id, upload_id, position) VALUES (?, ?, ?, 0)`).run(day.id, trip.id, tf.lastInsertRowid);

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
    testDb.prepare(`INSERT INTO day_journals (day_id, trip_id, content_markdown, updated_by) VALUES (?, ?, 'Hello', ?)`).run(sDay.id, sTrip.id, user.id);

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
    testDb.prepare(`INSERT INTO day_photos (day_id, trip_id, upload_id, caption, position) VALUES (?, ?, ?, 'Sunset', 0)`).run(day.id, trip.id, tf.lastInsertRowid);

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

  it('IMPORT-009 — to-do items import into the todo_items.name column (regression)', async () => {
    // Was inserting into a non-existent `text` column, which crashed the whole
    // apply transaction for any trip that had to-dos. Guards the column name.
    const { user } = createUser(testDb);
    const envelope = {
      schema_version: 1, app: '460-trip-planner', format: 'metadata-only',
      trip: {
        title: 'Todo import test', days: [], places: [], reservations: [], accommodations: [],
        todo_items: [{ name: 'Cancel the spare night', category: 'Bookings to sort', checked: 0, sort_order: 0 }],
      },
    };
    const res = await request(app)
      .post('/api/trips/import?dry_run=false')
      .set('Cookie', authCookie(user.id))
      .attach('file', Buffer.from(JSON.stringify(envelope)), 'export.json');
    expect(res.status).toBe(201);
    const todo = testDb.prepare('SELECT name, category FROM todo_items WHERE trip_id = ?').get(res.body.result.trip_id) as { name: string; category: string };
    expect(todo.name).toBe('Cancel the spare night');
    expect(todo.category).toBe('Bookings to sort');
  });

  it('IMPORT-010 — place categories resolve-or-create and dedupe by name (regression)', async () => {
    // The importer used to drop place categories entirely (no category_id in the
    // INSERT), so imported places were always uncategorised. Categories are
    // per-user with no trip_id, so two places sharing a name must create ONE
    // category, and an unnamed/absent category leaves category_id null.
    const { user } = createUser(testDb);
    const envelope = {
      schema_version: 1, app: '460-trip-planner', format: 'metadata-only',
      trip: {
        title: 'Category import test', days: [], reservations: [], accommodations: [],
        places: [
          { id: 1, name: 'Alhambra', category: { name: 'Sightseeing', color: '#e11d48', icon: '🏛️' } },
          { id: 2, name: 'Sagrada Família', category: { name: 'Sightseeing', color: '#e11d48', icon: '🏛️' } },
          { id: 3, name: 'El Celler', category: { name: 'Food & Drink', color: '#f59e0b', icon: '🍽️' } },
          { id: 4, name: 'Random viewpoint' },
        ],
      },
    };
    const res = await request(app)
      .post('/api/trips/import?dry_run=false')
      .set('Cookie', authCookie(user.id))
      .attach('file', Buffer.from(JSON.stringify(envelope)), 'export.json');
    expect(res.status).toBe(201);
    const tripId = res.body.result.trip_id;

    // Exactly two categories created for this user (Sightseeing deduped).
    const cats = testDb.prepare('SELECT name, color, icon FROM categories WHERE user_id = ? ORDER BY name').all(user.id) as Array<{ name: string; color: string; icon: string }>;
    expect(cats.map(c => c.name)).toEqual(['Food & Drink', 'Sightseeing']);
    const sightseeing = cats.find(c => c.name === 'Sightseeing')!;
    expect(sightseeing.color).toBe('#e11d48');
    expect(sightseeing.icon).toBe('🏛️');

    // Both Sightseeing places point at the same category id; the uncategorised
    // place is null.
    const places = testDb.prepare('SELECT name, category_id FROM places WHERE trip_id = ? ORDER BY name').all(tripId) as Array<{ name: string; category_id: number | null }>;
    const byName = Object.fromEntries(places.map(p => [p.name, p.category_id]));
    expect(byName['Alhambra']).not.toBeNull();
    expect(byName['Alhambra']).toBe(byName['Sagrada Família']);
    expect(byName['El Celler']).not.toBe(byName['Alhambra']);
    expect(byName['Random viewpoint']).toBeNull();
  });

  it('IMPORT-011 — import reuses an existing same-named category instead of duplicating (shared, not per-user)', async () => {
    // Categories are shared instance-wide, so an import by a different user must
    // reuse a category that already exists by name (case-insensitively) rather
    // than mint a duplicate. Assert deltas, not absolute counts: the test DB
    // keeps seeded/other-test categories across resets, so we only check that
    // THIS import added no new 'Sightseeing' and linked to a pre-existing one.
    const sightseeingIds = () =>
      (testDb.prepare("SELECT id FROM categories WHERE name = 'Sightseeing' COLLATE NOCASE ORDER BY id").all() as Array<{ id: number }>).map(r => r.id);

    const { user: owner } = createUser(testDb);
    testDb.prepare(
      "INSERT INTO categories (name, color, icon, user_id) VALUES ('Sightseeing', '#123456', 'Landmark', ?)",
    ).run(owner.id);
    const before = sightseeingIds();

    const { user: importer } = createUser(testDb);
    const envelope = {
      schema_version: 1, app: '460-trip-planner', format: 'metadata-only',
      trip: {
        title: 'Reuse category test', days: [], reservations: [], accommodations: [],
        places: [{ id: 1, name: 'Alhambra', category: { name: 'sightseeing', color: '#999999', icon: 'Mountain' } }],
      },
    };
    const res = await request(app)
      .post('/api/trips/import?dry_run=false')
      .set('Cookie', authCookie(importer.id))
      .attach('file', Buffer.from(JSON.stringify(envelope)), 'export.json');
    expect(res.status).toBe(201);

    // No new 'Sightseeing' minted, and the place links to a pre-existing one.
    expect(sightseeingIds()).toEqual(before);
    const place = testDb.prepare(`SELECT category_id FROM places WHERE trip_id = ?`).get(res.body.result.trip_id) as { category_id: number };
    expect(before).toContain(place.category_id);
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

  it('IMPORT-015 — a hotel reservation re-links to its accommodation through import', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id, { title: 'Hotel link' });
    const dIn = createDay(testDb, trip.id, { date: '2026-07-01', title: 'Check in' });
    const dOut = createDay(testDb, trip.id, { date: '2026-07-02', title: 'Check out' });
    const place = testDb.prepare(`INSERT INTO places (trip_id, name) VALUES (?, 'Grand Hotel')`).run(trip.id);
    const acc = testDb.prepare(
      `INSERT INTO day_accommodations (trip_id, place_id, start_day_id, end_day_id, confirmation) VALUES (?, ?, ?, ?, 'CONF123')`
    ).run(trip.id, place.lastInsertRowid, dIn.id, dOut.id);
    // A hotel reservation linked to that accommodation (the app's own model).
    testDb.prepare(
      `INSERT INTO reservations (trip_id, title, type, status, accommodation_id, confirmation_number) VALUES (?, 'Grand Hotel booking', 'hotel', 'confirmed', ?, 'CONF123')`
    ).run(trip.id, acc.lastInsertRowid);

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
      .attach('file', exportRes.body as Buffer, 'hotel.json');
    expect(importRes.status).toBe(201);
    const newTripId = importRes.body.result.trip_id;

    // The imported hotel reservation must point at the imported accommodation's
    // NEW id (the link survived the id re-mapping), not the stale source id.
    const newAcc = testDb.prepare('SELECT id FROM day_accommodations WHERE trip_id = ?').get(newTripId) as { id: number };
    const newRes = testDb.prepare(`SELECT accommodation_id FROM reservations WHERE trip_id = ? AND type = 'hotel'`).get(newTripId) as { accommodation_id: number | string | null };
    expect(newAcc?.id).toBeGreaterThan(0);
    // accommodation_id is a TEXT column → may come back as a string; compare numerically.
    expect(Number(newRes?.accommodation_id)).toBe(newAcc.id);
  });

  it('IMPORT-016 — an imported trip auto-adds the importer’s household members', async () => {
    const { user: importer } = createUser(testDb);
    const { user: partner } = createUser(testDb);
    // Put both accounts in one household (the M11 link is users.household_id).
    const hh = testDb.prepare('INSERT INTO households (created_by) VALUES (?)').run(importer.id);
    const hid = Number(hh.lastInsertRowid);
    testDb.prepare('UPDATE users SET household_id = ? WHERE id IN (?, ?)').run(hid, importer.id, partner.id);

    const envelope = {
      schema_version: 1, app: '460-trip-planner', format: 'metadata-only',
      trip: { title: 'Household import', days: [], places: [], reservations: [], accommodations: [], todo_items: [] },
    };
    const res = await request(app)
      .post('/api/trips/import?dry_run=false')
      .set('Cookie', authCookie(importer.id))
      .attach('file', Buffer.from(JSON.stringify(envelope)), 'hh.json');
    expect(res.status).toBe(201);
    const newTripId = res.body.result.trip_id;

    // The household partner must have been added to the imported trip.
    const member = testDb.prepare('SELECT user_id, invited_by FROM trip_members WHERE trip_id = ? AND user_id = ?').get(newTripId, partner.id) as { user_id: number; invited_by: number } | undefined;
    expect(member?.user_id).toBe(partner.id);
    expect(member?.invited_by).toBe(importer.id);
  });
});

// [460-fork] Milestone 15 — merge import ("patch" an existing trip).
describe('M15 — merge import into an existing trip', () => {
  /** A target trip with two dated days; day 1 already has a title + notes. */
  function seedTarget(userId: number) {
    const trip = createTrip(testDb, userId, { title: 'Target trip' });
    const d1 = createDay(testDb, trip.id, { date: '2026-09-18', title: 'My own title' });
    const d2 = createDay(testDb, trip.id, { date: '2026-09-19' });
    testDb.prepare('UPDATE days SET notes = ? WHERE id = ?').run('My own note', d1.id);
    return { trip, d1, d2 };
  }
  const patchFile = () => Buffer.from(JSON.stringify({
    schema_version: 1, app: '460-trip-planner', format: 'metadata-only',
    patch_key: 'spain',
    trip: {
      places: [{ id: 1, external_ref: 'eu:place:alhambra', name: 'Alhambra', lat: 37.176, lng: -3.588 }],
      days: [
        { date: '2026-09-18', title: 'Should NOT overwrite', notes: 'Alhambra tickets 09:00', assignments: [{ place: { id: 1 } }] },
        { date: '2026-12-31', title: 'Not a day in this trip', notes: 'nope' },
      ],
    },
  }));
  const post = (tripId: number, userId: number, dryRun = false) =>
    request(app)
      .post(`/api/trips/import?mode=merge&trip_id=${tripId}&dry_run=${dryRun}`)
      .set('Cookie', authCookie(userId))
      .attach('file', patchFile(), 'patch.json');

  it('MERGE-001 — patches matched days, warns + skips dates not in the trip', async () => {
    const { user } = createUser(testDb);
    const { trip, d1 } = seedTarget(user.id);

    const res = await post(trip.id, user.id);
    expect(res.status).toBe(200);
    expect(res.body.report.totals.days_matched).toBe(1);
    expect(res.body.report.totals.days_skipped).toBe(1);
    expect(res.body.report.warnings.join(' ')).toMatch(/2026-12-31/);

    // The place landed, stamped with its ref, and got assigned to the matched day.
    const place = testDb.prepare('SELECT id, name, external_ref FROM places WHERE trip_id = ?').get(trip.id) as { id: number; name: string; external_ref: string };
    expect(place.name).toBe('Alhambra');
    expect(place.external_ref).toBe('eu:place:alhambra');
    const asg = testDb.prepare('SELECT COUNT(*) AS n FROM day_assignments WHERE day_id = ? AND place_id = ?').get(d1.id, place.id) as { n: number };
    expect(asg.n).toBe(1);
  });

  it('MERGE-002 — add-only: existing title kept, notes appended as a keyed block', async () => {
    const { user } = createUser(testDb);
    const { trip, d1 } = seedTarget(user.id);
    await post(trip.id, user.id);

    const day = testDb.prepare('SELECT title, notes FROM days WHERE id = ?').get(d1.id) as { title: string; notes: string };
    expect(day.title).toBe('My own title');            // never overwritten
    expect(day.notes).toContain('My own note');        // own text survives
    expect(day.notes).toContain('<!-- 460-import: spain -->');
    expect(day.notes).toContain('Alhambra tickets 09:00');
  });

  it('MERGE-003 — re-importing the same patch duplicates nothing', async () => {
    const { user } = createUser(testDb);
    const { trip, d1 } = seedTarget(user.id);
    await post(trip.id, user.id);
    await post(trip.id, user.id);

    const places = testDb.prepare("SELECT COUNT(*) AS n FROM places WHERE trip_id = ? AND external_ref = 'eu:place:alhambra'").get(trip.id) as { n: number };
    expect(places.n).toBe(1);
    const asg = testDb.prepare('SELECT COUNT(*) AS n FROM day_assignments WHERE day_id = ?').get(d1.id) as { n: number };
    expect(asg.n).toBe(1);
    const day = testDb.prepare('SELECT notes FROM days WHERE id = ?').get(d1.id) as { notes: string };
    expect(day.notes.match(/460-import: spain/g)?.length).toBe(1); // block replaced, not appended twice
    expect(day.notes).toContain('My own note');
  });

  it('MERGE-004 — dry run reports the diff and writes nothing', async () => {
    const { user } = createUser(testDb);
    const { trip, d1 } = seedTarget(user.id);

    const res = await post(trip.id, user.id, true);
    expect(res.status).toBe(200);
    expect(res.body.dry_run).toBe(true);
    expect(res.body.report.totals.places_added).toBe(1);
    expect(res.body.report.totals.days_matched).toBe(1);

    expect((testDb.prepare('SELECT COUNT(*) AS n FROM places WHERE trip_id = ?').get(trip.id) as { n: number }).n).toBe(0);
    expect((testDb.prepare('SELECT notes FROM days WHERE id = ?').get(d1.id) as { notes: string }).notes).toBe('My own note');
  });

  it('MERGE-005 — a user with no access to the target trip is rejected', async () => {
    const { user: owner } = createUser(testDb);
    const { user: stranger } = createUser(testDb);
    const { trip } = seedTarget(owner.id);

    const res = await post(trip.id, stranger.id);
    expect(res.status).toBe(403);
  });

  // ── Slice 2: reservations, accommodations, budget items, to-dos ──────────
  const fullPatch = () => Buffer.from(JSON.stringify({
    schema_version: 1, app: '460-trip-planner', format: 'metadata-only', patch_key: 'spain',
    trip: {
      places: [{ id: 1, external_ref: 'eu:place:hotel', name: 'Hotel Granada' }],
      days: [],
      reservations: [{ external_ref: 'eu:res:alhambra', title: 'Alhambra entry', type: 'event', reservation_time: '2026-09-18T09:00', confirmation_number: 'H0MAXDJ' }],
      accommodations: [{ external_ref: 'eu:acc:granada', place_ref: 'eu:place:hotel', start_date: '2026-09-18', end_date: '2026-09-19', confirmation: 'BK123' }],
      budget_items: [{ external_ref: 'eu:bud:tickets', category: 'Activities', name: 'Alhambra tickets', total_price: 120 }],
      todo_items: [{ external_ref: 'eu:todo:confirm', name: 'Confirm Alhambra time', category: 'Bookings to sort' }],
    },
  }));
  const postFull = (tripId: number, userId: number) =>
    request(app)
      .post(`/api/trips/import?mode=merge&trip_id=${tripId}&dry_run=false`)
      .set('Cookie', authCookie(userId))
      .attach('file', fullPatch(), 'patch.json');

  it('MERGE-006 — merges reservations, accommodations, budget items and to-dos', async () => {
    const { user } = createUser(testDb);
    const { trip, d1, d2 } = seedTarget(user.id);

    const res = await postFull(trip.id, user.id);
    expect(res.status).toBe(200);
    const t = res.body.report.totals;
    expect([t.reservations_added, t.accommodations_added, t.budget_items_added, t.todo_items_added]).toEqual([1, 1, 1, 1]);

    const resv = testDb.prepare("SELECT title, external_ref FROM reservations WHERE trip_id = ?").get(trip.id) as { title: string; external_ref: string };
    expect(resv.title).toBe('Alhambra entry');
    expect(resv.external_ref).toBe('eu:res:alhambra');

    // Accommodation anchored to the right days via its dates.
    const acc = testDb.prepare('SELECT start_day_id, end_day_id, confirmation FROM day_accommodations WHERE trip_id = ?').get(trip.id) as { start_day_id: number; end_day_id: number; confirmation: string };
    expect(acc.start_day_id).toBe(d1.id);
    expect(acc.end_day_id).toBe(d2.id);
    expect(acc.confirmation).toBe('BK123');

    expect((testDb.prepare('SELECT name FROM budget_items WHERE trip_id = ?').get(trip.id) as { name: string }).name).toBe('Alhambra tickets');
    expect((testDb.prepare('SELECT name FROM todo_items WHERE trip_id = ?').get(trip.id) as { name: string }).name).toBe('Confirm Alhambra time');
  });

  it('MERGE-007 — re-importing updates those items in place, never duplicating', async () => {
    const { user } = createUser(testDb);
    const { trip } = seedTarget(user.id);
    await postFull(trip.id, user.id);
    const second = await postFull(trip.id, user.id);

    const t = second.body.report.totals;
    expect([t.reservations_added, t.accommodations_added, t.budget_items_added, t.todo_items_added]).toEqual([0, 0, 0, 0]);
    expect([t.reservations_updated, t.accommodations_updated, t.budget_items_updated, t.todo_items_updated]).toEqual([1, 1, 1, 1]);

    for (const table of ['reservations', 'day_accommodations', 'budget_items', 'todo_items']) {
      const n = testDb.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE trip_id = ?`).get(trip.id) as { n: number };
      expect(`${table}=${n.n}`).toBe(`${table}=1`);
    }
  });

  it('MERGE-008 — an accommodation whose dates are not in the trip is warned + skipped', async () => {
    const { user } = createUser(testDb);
    const { trip } = seedTarget(user.id);
    const patch = Buffer.from(JSON.stringify({
      schema_version: 1, app: '460-trip-planner', format: 'metadata-only', patch_key: 'spain',
      trip: {
        places: [{ id: 1, external_ref: 'eu:place:hotel', name: 'Hotel Granada' }],
        accommodations: [{ external_ref: 'eu:acc:x', place_ref: 'eu:place:hotel', start_date: '2027-01-01', end_date: '2027-01-02' }],
      },
    }));
    const res = await request(app)
      .post(`/api/trips/import?mode=merge&trip_id=${trip.id}&dry_run=false`)
      .set('Cookie', authCookie(user.id))
      .attach('file', patch, 'patch.json');

    expect(res.status).toBe(200);
    expect(res.body.report.totals.accommodations_added).toBe(0);
    expect(res.body.report.warnings.join(' ')).toMatch(/start_date and end_date/);
    expect((testDb.prepare('SELECT COUNT(*) AS n FROM day_accommodations WHERE trip_id = ?').get(trip.id) as { n: number }).n).toBe(0);
  });
});
