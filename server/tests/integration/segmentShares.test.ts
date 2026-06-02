/**
 * Segment document-sharing integration tests — Milestone 13, slice 1.
 *
 * Slice 1 is write-only: no read path consults the share junctions yet, so
 * these tests exercise the share/un-share endpoints and assert directly on the
 * junction rows. The cross-household visibility (and the leak guards that
 * prove a NON-shared record stays private) land in slice 2.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import type { Application } from 'express';
import Database from 'better-sqlite3';

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
import { createUser, createTrip, createReservation, createDay, createPlace } from '../helpers/factories';
import { authCookie } from '../helpers/auth';
import { getDownloadableFile } from '../../src/services/fileService';

const app: Application = createApp();

// ── Local factories (no shared segment/file factory exists yet) ──────────────
let _segSeq = 0;
function createSegment(db: Database.Database, homeTripId: number, createdBy: number): { id: string } {
  const id = `seg-${++_segSeq}`;
  db.prepare('INSERT INTO segments (id, title, created_by) VALUES (?, ?, ?)').run(id, 'Shared Segment', createdBy);
  db.prepare('INSERT INTO trip_segments (trip_id, segment_id, is_home, joined_by) VALUES (?, ?, 1, ?)').run(homeTripId, id, createdBy);
  return { id };
}
function linkTrip(db: Database.Database, tripId: number, segmentId: string, joinedBy: number): void {
  db.prepare('INSERT INTO trip_segments (trip_id, segment_id, is_home, joined_by) VALUES (?, ?, 0, ?)').run(tripId, segmentId, joinedBy);
}
let _fileSeq = 0;
function createFile(db: Database.Database, tripId: number, uploadedBy: number, reservationId?: number): { id: number } {
  const r = db.prepare('INSERT INTO trip_files (trip_id, filename, original_name, uploaded_by, reservation_id) VALUES (?, ?, ?, ?, ?)')
    .run(tripId, `f-${++_fileSeq}.pdf`, 'booking.pdf', uploadedBy, reservationId ?? null);
  return { id: r.lastInsertRowid as number };
}

/** Two households sharing one segment; a reservation + a file live in trip A. */
function setupSharedSegment() {
  const { user: ownerA } = createUser(testDb);
  const { user: ownerB } = createUser(testDb);
  const tripA = createTrip(testDb, ownerA.id);
  const tripB = createTrip(testDb, ownerB.id);
  const seg = createSegment(testDb, tripA.id, ownerA.id);
  linkTrip(testDb, tripB.id, seg.id, ownerB.id);
  const resv = createReservation(testDb, tripA.id, { title: 'Rental House', type: 'hotel' });
  const file = createFile(testDb, tripA.id, ownerA.id);
  return { ownerA, ownerB, tripA, tripB, seg, resv, file };
}

const ssrCount = (segmentId: string, reservationId: number) =>
  (testDb.prepare('SELECT COUNT(*) AS c FROM segment_shared_reservations WHERE segment_id = ? AND reservation_id = ?').get(segmentId, reservationId) as { c: number }).c;
const ssfCount = (segmentId: string, fileId: number) =>
  (testDb.prepare('SELECT COUNT(*) AS c FROM segment_shared_files WHERE segment_id = ? AND file_id = ?').get(segmentId, fileId) as { c: number }).c;

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

// ─────────────────────────────────────────────────────────────────────────────
// Share a reservation
// ─────────────────────────────────────────────────────────────────────────────

describe('Share reservation into segment', () => {
  it('SHARE-001 — owner shares a reservation into a segment their trip belongs to', async () => {
    const { ownerA, tripA, seg, resv } = setupSharedSegment();
    const res = await request(app)
      .post(`/api/trips/${tripA.id}/reservations/${resv.id}/share`)
      .set('Cookie', authCookie(ownerA.id))
      .send({ segment_id: seg.id });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(ssrCount(seg.id, resv.id)).toBe(1);
  });

  it('SHARE-002 — cannot share into a segment the trip is not part of', async () => {
    const { ownerA, tripA, resv } = setupSharedSegment();
    const res = await request(app)
      .post(`/api/trips/${tripA.id}/reservations/${resv.id}/share`)
      .set('Cookie', authCookie(ownerA.id))
      .send({ segment_id: 'no-such-segment' });
    expect(res.status).toBe(403);
    expect(ssrCount('no-such-segment', resv.id)).toBe(0);
  });

  it('SHARE-003 — a non-member of the owning trip cannot share its reservation', async () => {
    const { ownerB, tripA, seg, resv } = setupSharedSegment();
    // ownerB is in the segment via trip B, but is NOT a member of trip A.
    const res = await request(app)
      .post(`/api/trips/${tripA.id}/reservations/${resv.id}/share`)
      .set('Cookie', authCookie(ownerB.id))
      .send({ segment_id: seg.id });
    expect(res.status).toBe(404); // trip A not accessible to owner B
    expect(ssrCount(seg.id, resv.id)).toBe(0);
  });

  it('SHARE-004 — cannot share a reservation that belongs to another trip', async () => {
    const { ownerB, tripB, seg, resv } = setupSharedSegment();
    // resv lives in trip A; owner B tries to share it via their own trip B.
    const res = await request(app)
      .post(`/api/trips/${tripB.id}/reservations/${resv.id}/share`)
      .set('Cookie', authCookie(ownerB.id))
      .send({ segment_id: seg.id });
    expect(res.status).toBe(404); // reservation not found in trip B
    expect(ssrCount(seg.id, resv.id)).toBe(0);
  });

  it('SHARE-005 — missing segment_id returns 400', async () => {
    const { ownerA, tripA, resv } = setupSharedSegment();
    const res = await request(app)
      .post(`/api/trips/${tripA.id}/reservations/${resv.id}/share`)
      .set('Cookie', authCookie(ownerA.id))
      .send({});
    expect(res.status).toBe(400);
  });

  it('SHARE-006 — un-share removes the share row', async () => {
    const { ownerA, tripA, seg, resv } = setupSharedSegment();
    await request(app)
      .post(`/api/trips/${tripA.id}/reservations/${resv.id}/share`)
      .set('Cookie', authCookie(ownerA.id))
      .send({ segment_id: seg.id });
    expect(ssrCount(seg.id, resv.id)).toBe(1);

    const del = await request(app)
      .delete(`/api/trips/${tripA.id}/reservations/${resv.id}/share`)
      .set('Cookie', authCookie(ownerA.id))
      .send({ segment_id: seg.id });
    expect(del.status).toBe(200);
    expect(ssrCount(seg.id, resv.id)).toBe(0);
  });

  it('SHARE-007 — sharing is idempotent (UNIQUE + global mutation cache)', async () => {
    const { ownerA, tripA, seg, resv } = setupSharedSegment();
    const send = () => request(app)
      .post(`/api/trips/${tripA.id}/reservations/${resv.id}/share`)
      .set('Cookie', authCookie(ownerA.id))
      .set('X-Client-Mutation-Id', 'share-resv-once')
      .send({ segment_id: seg.id });

    const r1 = await send();
    const r2 = await send();
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r2.body.replayed).toBe(true); // served from the idempotency cache
    expect(ssrCount(seg.id, resv.id)).toBe(1); // exactly one row
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Share a standalone file
// ─────────────────────────────────────────────────────────────────────────────

describe('Share file into segment', () => {
  it('SHARE-008 — owner shares a standalone file; un-share removes it', async () => {
    const { ownerA, tripA, seg, file } = setupSharedSegment();
    const res = await request(app)
      .post(`/api/trips/${tripA.id}/files/${file.id}/share`)
      .set('Cookie', authCookie(ownerA.id))
      .send({ segment_id: seg.id });
    expect(res.status).toBe(200);
    expect(ssfCount(seg.id, file.id)).toBe(1);

    const del = await request(app)
      .delete(`/api/trips/${tripA.id}/files/${file.id}/share`)
      .set('Cookie', authCookie(ownerA.id))
      .send({ segment_id: seg.id });
    expect(del.status).toBe(200);
    expect(ssfCount(seg.id, file.id)).toBe(0);
  });

  it('SHARE-009 — a non-member of the owning trip cannot share its file', async () => {
    const { ownerB, tripA, seg, file } = setupSharedSegment();
    const res = await request(app)
      .post(`/api/trips/${tripA.id}/files/${file.id}/share`)
      .set('Cookie', authCookie(ownerB.id))
      .send({ segment_id: seg.id });
    expect(res.status).toBe(404);
    expect(ssfCount(seg.id, file.id)).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Slice 2 — cross-household visibility + the leak guards
// ─────────────────────────────────────────────────────────────────────────────

/** Owner A shares `reservationId` into the segment. */
async function shareResv(ownerAId: number, tripAId: number, reservationId: number, segmentId: string) {
  return request(app)
    .post(`/api/trips/${tripAId}/reservations/${reservationId}/share`)
    .set('Cookie', authCookie(ownerAId))
    .send({ segment_id: segmentId });
}

describe('Shared reservations — cross-household reads/writes', () => {
  it('SHARE-101 — sibling sees a shared reservation; a non-shared one stays hidden', async () => {
    const { ownerA, ownerB, tripA, tripB, seg, resv } = setupSharedSegment();
    const secret = createReservation(testDb, tripA.id, { title: 'Private Flight', type: 'flight' });
    await shareResv(ownerA.id, tripA.id, resv.id, seg.id);

    const list = await request(app)
      .get(`/api/trips/${tripB.id}/reservations`)
      .set('Cookie', authCookie(ownerB.id));
    expect(list.status).toBe(200);
    const ids = list.body.reservations.map((r: any) => r.id);
    expect(ids).toContain(resv.id);        // shared → visible
    expect(ids).not.toContain(secret.id);  // NOT shared → hidden (leak guard)

    const row = list.body.reservations.find((r: any) => r.id === resv.id);
    expect(row.shared_into_segment).toBe(1);
    expect(row.owned_by_this_trip).toBe(0);
  });

  it('SHARE-102 — owner still sees their reservation as owned', async () => {
    const { ownerA, tripA, seg, resv } = setupSharedSegment();
    await shareResv(ownerA.id, tripA.id, resv.id, seg.id);
    const list = await request(app)
      .get(`/api/trips/${tripA.id}/reservations`)
      .set('Cookie', authCookie(ownerA.id));
    const row = list.body.reservations.find((r: any) => r.id === resv.id);
    expect(row.owned_by_this_trip).toBe(1);
    expect(row.shared_into_segment).toBe(0);
  });

  it('SHARE-103 — sibling can co-edit a shared reservation; it stays owned by trip A', async () => {
    const { ownerA, ownerB, tripA, tripB, seg, resv } = setupSharedSegment();
    await shareResv(ownerA.id, tripA.id, resv.id, seg.id);

    const put = await request(app)
      .put(`/api/trips/${tripB.id}/reservations/${resv.id}`)
      .set('Cookie', authCookie(ownerB.id))
      .send({ title: 'Co-edited Title' });
    expect(put.status).toBe(200);
    expect(put.body.reservation.title).toBe('Co-edited Title');

    // Ownership unchanged; the edit landed on trip A's row.
    const row = testDb.prepare('SELECT trip_id, title FROM reservations WHERE id = ?').get(resv.id) as { trip_id: number; title: string };
    expect(row.trip_id).toBe(tripA.id);
    expect(row.title).toBe('Co-edited Title');

    // Owner A sees the co-edit.
    const aList = await request(app)
      .get(`/api/trips/${tripA.id}/reservations`)
      .set('Cookie', authCookie(ownerA.id));
    expect(aList.body.reservations.find((r: any) => r.id === resv.id).title).toBe('Co-edited Title');
  });

  it('SHARE-104 — sibling CANNOT edit a non-shared reservation (write leak guard)', async () => {
    const { ownerB, tripA, tripB } = setupSharedSegment();
    const secret = createReservation(testDb, tripA.id, { title: 'Private Flight', type: 'flight' });
    const put = await request(app)
      .put(`/api/trips/${tripB.id}/reservations/${secret.id}`)
      .set('Cookie', authCookie(ownerB.id))
      .send({ title: 'Hijacked' });
    expect(put.status).toBe(404);
    const row = testDb.prepare('SELECT title FROM reservations WHERE id = ?').get(secret.id) as { title: string };
    expect(row.title).toBe('Private Flight'); // untouched
  });

  it('SHARE-105 — sibling CANNOT delete a shared reservation (delete is owner-only)', async () => {
    const { ownerA, ownerB, tripA, tripB, seg, resv } = setupSharedSegment();
    await shareResv(ownerA.id, tripA.id, resv.id, seg.id);

    const del = await request(app)
      .delete(`/api/trips/${tripB.id}/reservations/${resv.id}`)
      .set('Cookie', authCookie(ownerB.id));
    expect(del.status).toBe(404);
    expect(testDb.prepare('SELECT 1 FROM reservations WHERE id = ?').get(resv.id)).toBeTruthy(); // survives
  });

  it('SHARE-110 — sibling co-edit CANNOT inject an accommodation row into the owner trip', async () => {
    const { ownerA, ownerB, tripA, tripB, seg, resv } = setupSharedSegment();
    const place = createPlace(testDb, tripA.id);
    const d1 = createDay(testDb, tripA.id, { date: '2026-07-01' });
    const d2 = createDay(testDb, tripA.id, { date: '2026-07-02' });
    await shareResv(ownerA.id, tripA.id, resv.id, seg.id);

    // Sibling co-edits the shared booking, attempting to create an accommodation
    // in trip A. The booking-field edit succeeds, but the owner-scoped
    // accommodation side-effect must be stripped — no day_accommodations row.
    const put = await request(app)
      .put(`/api/trips/${tripB.id}/reservations/${resv.id}`)
      .set('Cookie', authCookie(ownerB.id))
      .send({ type: 'hotel', create_accommodation: { place_id: place.id, start_day_id: d1.id, end_day_id: d2.id } });
    expect(put.status).toBe(200);
    const accCount = (testDb.prepare('SELECT COUNT(*) AS c FROM day_accommodations WHERE trip_id = ?').get(tripA.id) as { c: number }).c;
    expect(accCount).toBe(0);
  });

  it('SHARE-111 — owner CAN create an accommodation on their own booking (control)', async () => {
    const { ownerA, tripA, resv } = setupSharedSegment();
    const place = createPlace(testDb, tripA.id);
    const d1 = createDay(testDb, tripA.id, { date: '2026-07-01' });
    const d2 = createDay(testDb, tripA.id, { date: '2026-07-02' });

    const put = await request(app)
      .put(`/api/trips/${tripA.id}/reservations/${resv.id}`)
      .set('Cookie', authCookie(ownerA.id))
      .send({ type: 'hotel', create_accommodation: { place_id: place.id, start_day_id: d1.id, end_day_id: d2.id } });
    expect(put.status).toBe(200);
    const accCount = (testDb.prepare('SELECT COUNT(*) AS c FROM day_accommodations WHERE trip_id = ?').get(tripA.id) as { c: number }).c;
    expect(accCount).toBe(1);
  });
});

describe('Shared files — cross-household reads + download auth', () => {
  it('SHARE-106 — sibling sees a directly-shared file; a non-shared one stays hidden', async () => {
    const { ownerA, ownerB, tripA, tripB, seg, file } = setupSharedSegment();
    const other = createFile(testDb, tripA.id, ownerA.id); // not shared
    await request(app)
      .post(`/api/trips/${tripA.id}/files/${file.id}/share`)
      .set('Cookie', authCookie(ownerA.id))
      .send({ segment_id: seg.id });

    const list = await request(app)
      .get(`/api/trips/${tripB.id}/files`)
      .set('Cookie', authCookie(ownerB.id));
    expect(list.status).toBe(200);
    const ids = list.body.files.map((f: any) => f.id);
    expect(ids).toContain(file.id);
    expect(ids).not.toContain(other.id); // leak guard

    const shared = list.body.files.find((f: any) => f.id === file.id);
    expect(shared.shared_into_segment).toBe(1);
    expect(shared.owned_by_this_trip).toBe(0);
    // Download URL points at the REQUESTING trip so the sibling can fetch it.
    expect(shared.url).toBe(`/api/trips/${tripB.id}/files/${file.id}/download`);
  });

  it('SHARE-107 — download auth: a shared file resolves for the sibling, a non-shared one does not', async () => {
    const { ownerA, tripA, tripB, seg, file } = setupSharedSegment();
    expect(getDownloadableFile(file.id, tripB.id)).toBeUndefined(); // before share
    await request(app)
      .post(`/api/trips/${tripA.id}/files/${file.id}/share`)
      .set('Cookie', authCookie(ownerA.id))
      .send({ segment_id: seg.id });
    expect(getDownloadableFile(file.id, tripB.id)).toBeTruthy(); // after share
  });

  it('SHARE-108 — sharing a reservation makes its attached PDF downloadable by the sibling', async () => {
    const { ownerA, tripA, tripB, seg, resv } = setupSharedSegment();
    const attached = createFile(testDb, tripA.id, ownerA.id, resv.id); // PDF attached to the booking
    const looseUnshared = createFile(testDb, tripA.id, ownerA.id);     // attached to nothing, not shared
    expect(getDownloadableFile(attached.id, tripB.id)).toBeUndefined();

    await shareResv(ownerA.id, tripA.id, resv.id, seg.id);

    expect(getDownloadableFile(attached.id, tripB.id)).toBeTruthy();        // rides along with the booking
    expect(getDownloadableFile(looseUnshared.id, tripB.id)).toBeUndefined(); // unrelated file stays private
  });
});
