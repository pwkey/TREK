/**
 * Integration tests for the shared-segments HTTP surface (Milestone 4 slice 2).
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import type { Application } from 'express';

const { testDb, dbMock } = vi.hoisted(() => {
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  return {
    testDb: db,
    dbMock: {
      db,
      closeDb: () => {},
      reinitialize: () => {},
      canAccessTrip: (tripId: any, userId: number) =>
        db.prepare(`SELECT t.id, t.user_id FROM trips t LEFT JOIN trip_members m ON m.trip_id = t.id AND m.user_id = ? WHERE t.id = ? AND (t.user_id = ? OR m.user_id IS NOT NULL)`).get(userId, tripId, userId),
      isOwner: (tripId: any, userId: number) =>
        !!db.prepare('SELECT id FROM trips WHERE id = ? AND user_id = ?').get(tripId, userId),
    },
  };
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
import { createUser, createTrip } from '../helpers/factories';
import { authCookie } from '../helpers/auth';

const app: Application = createApp();

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

function dayIdsForDates(tripId: number, dates: string[]): number[] {
  const rows = testDb.prepare('SELECT id, date FROM days WHERE trip_id = ?').all(tripId) as Array<{ id: number; date: string }>;
  return dates.map((d) => rows.find((r) => r.date === d)!.id);
}

async function setupSegment(aliceId: number, bobId: number, bobTripId?: number) {
  const aTrip = createTrip(testDb, aliceId, { title: 'Europe 2027', start_date: '2027-06-10', end_date: '2027-06-15' });
  const bTrip = bobTripId ?? createTrip(testDb, bobId, { title: 'Bob EU', start_date: '2027-06-11', end_date: '2027-06-14' }).id;
  const dayIds = dayIdsForDates(aTrip.id, ['2027-06-11', '2027-06-12', '2027-06-13']);
  const created = await request(app)
    .post('/api/segments')
    .set('Cookie', authCookie(aliceId))
    .send({ trip_id: aTrip.id, day_ids: dayIds, title: 'Adventure with the Smiths' });
  const segmentId = created.body.segment.id;
  const invite = await request(app).post(`/api/segments/${segmentId}/invites`).set('Cookie', authCookie(aliceId));
  const accepted = await request(app)
    .post('/api/segments/accept')
    .set('Cookie', authCookie(bobId))
    .send({ token: invite.body.token, target_trip_id: bTrip });
  return { aTrip, bTrip, segmentId, created, invite, accepted };
}

describe('POST /api/segments', () => {
  it('creates a segment from contiguous days on the caller\'s trip', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id, { title: 'T', start_date: '2027-06-10', end_date: '2027-06-13' });
    const dayIds = dayIdsForDates(trip.id, ['2027-06-11', '2027-06-12']);
    const res = await request(app)
      .post('/api/segments')
      .set('Cookie', authCookie(user.id))
      .send({ trip_id: trip.id, day_ids: dayIds, title: 'Smiths' });
    expect(res.status).toBe(201);
    expect(res.body.segment.title).toBe('Smiths');
    expect(res.body.linked_trip_ids).toEqual([trip.id]);
    expect(res.body.home_trip_id).toBe(trip.id);
  });

  it('rejects a non-owner caller', async () => {
    const { user: alice } = createUser(testDb);
    const { user: bob } = createUser(testDb);
    const trip = createTrip(testDb, alice.id, { title: 'T', start_date: '2027-06-10', end_date: '2027-06-11' });
    const dayIds = dayIdsForDates(trip.id, ['2027-06-10']);
    const res = await request(app)
      .post('/api/segments')
      .set('Cookie', authCookie(bob.id))
      .send({ trip_id: trip.id, day_ids: dayIds, title: 'X' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('NOT_TRIP_OWNER');
  });

  it('400 on malformed input', async () => {
    const { user } = createUser(testDb);
    const res = await request(app)
      .post('/api/segments')
      .set('Cookie', authCookie(user.id))
      .send({ trip_id: 'nope', title: '' });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/segments/accept', () => {
  it('links the target trip and returns the segment', async () => {
    const { user: alice } = createUser(testDb);
    const { user: bob } = createUser(testDb);
    const { aTrip, bTrip, segmentId, accepted } = await setupSegment(alice.id, bob.id);
    expect(accepted.status).toBe(200);
    expect(accepted.body.segment.id).toBe(segmentId);
    expect(accepted.body.linked_trip_ids.sort()).toEqual([aTrip.id, bTrip].sort());
  });

  it('rejects a caller who does not own the target trip', async () => {
    const { user: alice } = createUser(testDb);
    const { user: bob } = createUser(testDb);
    const { user: carol } = createUser(testDb);
    const bTrip = createTrip(testDb, bob.id, { title: 'B', start_date: '2027-06-11', end_date: '2027-06-13' });
    const aTrip = createTrip(testDb, alice.id, { title: 'A', start_date: '2027-06-10', end_date: '2027-06-13' });
    const dayIds = dayIdsForDates(aTrip.id, ['2027-06-11']);
    const created = await request(app).post('/api/segments').set('Cookie', authCookie(alice.id)).send({ trip_id: aTrip.id, day_ids: dayIds, title: 'S' });
    const invite = await request(app).post(`/api/segments/${created.body.segment.id}/invites`).set('Cookie', authCookie(alice.id));
    const res = await request(app).post('/api/segments/accept').set('Cookie', authCookie(carol.id)).send({ token: invite.body.token, target_trip_id: bTrip.id });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('NOT_TRIP_OWNER');
  });
});

describe('GET /api/trips/:tripId/days (union with segment-linked days)', () => {
  it('returns the home trip\'s segment days alongside Bob\'s own days', async () => {
    const { user: alice } = createUser(testDb);
    const { user: bob } = createUser(testDb);
    const { aTrip, bTrip, segmentId } = await setupSegment(alice.id, bob.id);
    void segmentId;

    const res = await request(app).get(`/api/trips/${bTrip}/days`).set('Cookie', authCookie(bob.id));
    expect(res.status).toBe(200);

    // Bob's trip originally had 4 days (Jun 11-14). After accept, rows on 11/12/13
    // were dropped and he sees 3 segment days (hosted by Alice) + his own Jun 14.
    const dates = res.body.days.map((d: any) => d.date).sort();
    expect(dates).toEqual(['2027-06-11', '2027-06-12', '2027-06-13', '2027-06-14']);
    // Canonical segment days are owned by Alice's trip.
    const segmentDays = res.body.days.filter((d: any) => d.trip_id === aTrip.id);
    expect(segmentDays).toHaveLength(3);
  });

  it('the last sibling leaving auto-dissolves the segment and clears the chip on the home', async () => {
    const { user: alice } = createUser(testDb);
    const { user: bob } = createUser(testDb);
    const { aTrip, bTrip, segmentId } = await setupSegment(alice.id, bob.id);

    // While Bob is linked: Alice's shared days carry segment metadata.
    let aRes = await request(app).get(`/api/trips/${aTrip.id}/days`).set('Cookie', authCookie(alice.id));
    let withSegment = aRes.body.days.filter((d: any) => d.segment != null);
    expect(withSegment).toHaveLength(3);
    expect(withSegment[0].segment.id).toBe(segmentId);

    // Bob leaves → segment auto-dissolves.
    const leaveRes = await request(app).delete(`/api/segments/${segmentId}/trips/${bTrip}`).set('Cookie', authCookie(bob.id));
    expect(leaveRes.status).toBe(200);
    expect(leaveRes.body.dissolved).toBe(true);

    // Alice's days no longer have the segment hydrated (and the underlying
    // segment_id pointer was cleared by the cascade).
    aRes = await request(app).get(`/api/trips/${aTrip.id}/days`).set('Cookie', authCookie(alice.id));
    withSegment = aRes.body.days.filter((d: any) => d.segment != null);
    expect(withSegment).toHaveLength(0);

    // Segment record is gone.
    const segRow = testDb.prepare('SELECT id FROM segments WHERE id = ?').get(segmentId);
    expect(segRow).toBeUndefined();

    // It also disappears from the trip's manage list.
    const segListRes = await request(app).get(`/api/trips/${aTrip.id}/segments`).set('Cookie', authCookie(alice.id));
    expect(segListRes.body.segments).toHaveLength(0);
  });

  it('does not leak segment days to an unrelated caller', async () => {
    const { user: alice } = createUser(testDb);
    const { user: bob } = createUser(testDb);
    const { user: carol } = createUser(testDb);
    const { aTrip } = await setupSegment(alice.id, bob.id);
    const cTrip = createTrip(testDb, carol.id, { title: 'C', start_date: '2027-06-11', end_date: '2027-06-13' });

    const res = await request(app).get(`/api/trips/${cTrip.id}/days`).set('Cookie', authCookie(carol.id));
    // Carol sees exactly her own trip's rows — none from Alice's segment.
    for (const d of res.body.days) expect(d.trip_id).toBe(cTrip.id);
    void aTrip;
  });
});

describe('DELETE /api/trips/:id — blocked when hosting segment days', () => {
  it('returns 409 SEGMENT_REFERENCES_BLOCK_DELETE for the home trip of a shared segment', async () => {
    const { user: alice } = createUser(testDb);
    const { user: bob } = createUser(testDb);
    const { aTrip, segmentId } = await setupSegment(alice.id, bob.id);
    const res = await request(app).delete(`/api/trips/${aTrip.id}`).set('Cookie', authCookie(alice.id));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('SEGMENT_REFERENCES_BLOCK_DELETE');
    expect(res.body.blocking_segment_ids).toContain(segmentId);
  });

  it('permits deletion of the sibling (non-home) trip', async () => {
    const { user: alice } = createUser(testDb);
    const { user: bob } = createUser(testDb);
    const { bTrip } = await setupSegment(alice.id, bob.id);
    const res = await request(app).delete(`/api/trips/${bTrip}`).set('Cookie', authCookie(bob.id));
    expect(res.status).toBe(200);
  });
});

describe('DELETE /api/segments/:id (dissolve)', () => {
  it('home owner dissolves the segment; siblings receive memento days; trip can then be deleted', async () => {
    const { user: alice } = createUser(testDb);
    const { user: bob } = createUser(testDb);
    const { aTrip, bTrip, segmentId } = await setupSegment(alice.id, bob.id);

    // Pre-dissolve: trip delete on Alice is blocked.
    const blockRes = await request(app).delete(`/api/trips/${aTrip.id}`).set('Cookie', authCookie(alice.id));
    expect(blockRes.status).toBe(409);

    const res = await request(app).delete(`/api/segments/${segmentId}`).set('Cookie', authCookie(alice.id));
    expect(res.status).toBe(200);
    expect(Object.keys(res.body.cloned_by_trip)).toEqual([String(bTrip)]);

    // Segment record gone, Alice's trip can now be deleted.
    expect(testDb.prepare('SELECT id FROM segments WHERE id = ?').get(segmentId)).toBeUndefined();
    const okRes = await request(app).delete(`/api/trips/${aTrip.id}`).set('Cookie', authCookie(alice.id));
    expect(okRes.status).toBe(200);
  });

  it('rejects dissolve from a non-home caller', async () => {
    const { user: alice } = createUser(testDb);
    const { user: bob } = createUser(testDb);
    const { segmentId } = await setupSegment(alice.id, bob.id);
    const res = await request(app).delete(`/api/segments/${segmentId}`).set('Cookie', authCookie(bob.id));
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('NOT_TRIP_OWNER');
  });
});

describe('DELETE /api/segments/:id/trips/:tripId (leave)', () => {
  it('non-home leaves → clones memento days, trip_segments link gone', async () => {
    const { user: alice } = createUser(testDb);
    const { user: bob } = createUser(testDb);
    const { bTrip, segmentId } = await setupSegment(alice.id, bob.id);
    const res = await request(app).delete(`/api/segments/${segmentId}/trips/${bTrip}`).set('Cookie', authCookie(bob.id));
    expect(res.status).toBe(200);
    expect(res.body.cloned_day_ids.length).toBe(3);
    const link = testDb.prepare('SELECT 1 FROM trip_segments WHERE trip_id = ? AND segment_id = ?').get(bTrip, segmentId);
    expect(link).toBeUndefined();
  });

  it('home trip cannot leave', async () => {
    const { user: alice } = createUser(testDb);
    const { user: bob } = createUser(testDb);
    const { aTrip, segmentId } = await setupSegment(alice.id, bob.id);
    const res = await request(app).delete(`/api/segments/${segmentId}/trips/${aTrip.id}`).set('Cookie', authCookie(alice.id));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('HOME_TRIP_CANNOT_LEAVE');
  });
});

describe('GET /api/segments/invite/:token (preview)', () => {
  it('returns minimal segment metadata for a valid token', async () => {
    const { user: alice } = createUser(testDb);
    const { user: bob } = createUser(testDb);
    const { segmentId, invite } = await setupSegment(alice.id, bob.id);
    const res = await request(app).get(`/api/segments/invite/${invite.body.token}`).set('Cookie', authCookie(alice.id));
    expect(res.status).toBe(200);
    expect(res.body.segment.id).toBe(segmentId);
    expect(res.body.segment.title).toBe('Adventure with the Smiths');
    expect(res.body.accepted).toBe(true);
    expect(new Date(res.body.expires_at).getTime()).toBeGreaterThan(Date.now());
    expect(res.body.inviter.id).toBe(alice.id);
    expect(res.body.inviter.username).toBe(alice.username);
    expect(res.body.inviter.email).toBe(alice.email);
  });

  it('404 for unknown token', async () => {
    const { user: alice } = createUser(testDb);
    const res = await request(app).get('/api/segments/invite/nope').set('Cookie', authCookie(alice.id));
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('INVITE_NOT_FOUND');
  });

  it('410 for expired token', async () => {
    const { user: alice } = createUser(testDb);
    const trip = createTrip(testDb, alice.id, { title: 'T', start_date: '2027-06-10', end_date: '2027-06-11' });
    const dayIds = dayIdsForDates(trip.id, ['2027-06-10']);
    const seg = await request(app).post('/api/segments').set('Cookie', authCookie(alice.id)).send({ trip_id: trip.id, day_ids: dayIds, title: 'S' });
    const inv = await request(app).post(`/api/segments/${seg.body.segment.id}/invites`).set('Cookie', authCookie(alice.id));
    testDb.prepare("UPDATE segment_invites SET expires_at = datetime('now', '-1 day') WHERE token = ?").run(inv.body.token);
    const res = await request(app).get(`/api/segments/invite/${inv.body.token}`).set('Cookie', authCookie(alice.id));
    expect(res.status).toBe(410);
    expect(res.body.code).toBe('INVITE_EXPIRED');
  });
});

describe('Q13 — accept invite with guided trip creation', () => {
  it('Q13-001 — Bob accepts a segment invite without an existing trip; server creates a stub trip', async () => {
    const { user: alice } = createUser(testDb);
    const { user: bob } = createUser(testDb);
    // Alice creates a segment + invite.
    const aTrip = createTrip(testDb, alice.id, { title: 'Europe 2027', start_date: '2027-06-10', end_date: '2027-06-15' });
    const dayIds = dayIdsForDates(aTrip.id, ['2027-06-11', '2027-06-12', '2027-06-13']);
    const created = await request(app)
      .post('/api/segments')
      .set('Cookie', authCookie(alice.id))
      .send({ trip_id: aTrip.id, day_ids: dayIds, title: 'Adventure' });
    const segmentId = created.body.segment.id;
    const invite = await request(app).post(`/api/segments/${segmentId}/invites`).set('Cookie', authCookie(alice.id));

    // Bob has NO trips at all. Accept with new_trip_title.
    const bobTripsBefore = testDb.prepare('SELECT COUNT(*) AS c FROM trips WHERE user_id = ?').get(bob.id) as { c: number };
    expect(bobTripsBefore.c).toBe(0);

    const accept = await request(app)
      .post('/api/segments/accept')
      .set('Cookie', authCookie(bob.id))
      .send({ token: invite.body.token, new_trip_title: 'Bob\'s shared trip with Alice' });
    expect(accept.status).toBe(200);

    // Verify Bob now owns a trip with the segment's dates and the given title.
    const bobTrips = testDb.prepare('SELECT * FROM trips WHERE user_id = ?').all(bob.id) as Array<{ id: number; title: string; start_date: string; end_date: string }>;
    expect(bobTrips).toHaveLength(1);
    expect(bobTrips[0].title).toBe('Bob\'s shared trip with Alice');
    expect(bobTrips[0].start_date).toBe('2027-06-11');
    expect(bobTrips[0].end_date).toBe('2027-06-13');

    // Verify trip_segments row exists.
    const linked = testDb.prepare('SELECT trip_id FROM trip_segments WHERE segment_id = ? AND is_home = 0').get(segmentId) as { trip_id: number };
    expect(linked.trip_id).toBe(bobTrips[0].id);
  });

  it('Q13-002 — accept rejects when neither target_trip_id nor new_trip_title is provided', async () => {
    const { user: alice } = createUser(testDb);
    const { user: bob } = createUser(testDb);
    const aTrip = createTrip(testDb, alice.id, { title: 'T', start_date: '2027-06-10', end_date: '2027-06-13' });
    const dayIds = dayIdsForDates(aTrip.id, ['2027-06-11']);
    const created = await request(app).post('/api/segments').set('Cookie', authCookie(alice.id)).send({ trip_id: aTrip.id, day_ids: dayIds, title: 'X' });
    const invite = await request(app).post(`/api/segments/${created.body.segment.id}/invites`).set('Cookie', authCookie(alice.id));
    const res = await request(app).post('/api/segments/accept').set('Cookie', authCookie(bob.id)).send({ token: invite.body.token });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_INPUT');
  });
});

describe('Day edit on a shared day — cross-trip write via getAccessibleDay', () => {
  it('Bob can PUT a shared day (segment-linked) and the canonical row updates', async () => {
    const { user: alice } = createUser(testDb);
    const { user: bob } = createUser(testDb);
    const { aTrip, bTrip, segmentId } = await setupSegment(alice.id, bob.id);
    void segmentId;

    // Find the shared day (home-trip row) on 2027-06-12.
    const sharedDayId = (testDb.prepare('SELECT id FROM days WHERE trip_id = ? AND date = ?').get(aTrip.id, '2027-06-12') as { id: number }).id;
    const res = await request(app)
      .put(`/api/trips/${bTrip}/days/${sharedDayId}`)
      .set('Cookie', authCookie(bob.id))
      .send({ title: 'Bordeaux wine tour', notes: 'Book ahead' });
    expect(res.status).toBe(200);
    expect(res.body.day.title).toBe('Bordeaux wine tour');
    const updated = testDb.prepare('SELECT title FROM days WHERE id = ?').get(sharedDayId) as { title: string };
    expect(updated.title).toBe('Bordeaux wine tour');
  });
});
