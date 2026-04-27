/**
 * Unit tests for segmentService (Milestone 4 slice 1).
 * In-memory SQLite with real migrations applied.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';

const { testDb, dbMock } = vi.hoisted(() => {
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  return { testDb: db, dbMock: { db, closeDb: () => {}, reinitialize: () => {} } };
});

vi.mock('../../src/db/database', () => dbMock);
vi.mock('../../src/config', () => ({
  JWT_SECRET: 'test-jwt-secret-for-trek-testing-only',
  ENCRYPTION_KEY: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6a7b8c9d0e1f2a3b4c5d6a7b8c9d0e1f2',
  updateJwtSecret: () => {},
}));

import { createTables } from '../../src/db/schema';
import { runMigrations } from '../../src/db/migrations';
import { resetTestDb } from '../helpers/test-db';
import { createUser, createTrip } from '../helpers/factories';
import * as segmentService from '../../src/services/segmentService';

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

function dayIdsForTrip(tripId: number, dates: string[]): number[] {
  const rows = testDb.prepare(
    `SELECT id, date FROM days WHERE trip_id = ? ORDER BY date`,
  ).all(tripId) as Array<{ id: number; date: string }>;
  return dates.map((d) => {
    const row = rows.find((r) => r.date === d);
    if (!row) throw new Error(`No day row in trip ${tripId} for date ${d}`);
    return row.id;
  });
}

describe('segmentService.createSegment', () => {
  it('creates a segment over contiguous trip days and marks them segment_id', () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id, { title: 'Europe 2027', start_date: '2027-06-10', end_date: '2027-06-15' });
    const ids = dayIdsForTrip(trip.id, ['2027-06-11', '2027-06-12', '2027-06-13']);

    const result = segmentService.createSegment({
      userId: user.id, tripId: trip.id, dayIds: ids, title: 'Adventure with the Smiths',
    });
    expect('segment' in result).toBe(true);
    if (!('segment' in result)) return;
    expect(result.segment.start_date).toBe('2027-06-11');
    expect(result.segment.end_date).toBe('2027-06-13');
    expect(result.home_trip_id).toBe(trip.id);
    expect(result.day_ids).toHaveLength(3);

    const stamped = testDb.prepare('SELECT COUNT(*) AS c FROM days WHERE segment_id = ?').get(result.segment.id) as { c: number };
    expect(stamped.c).toBe(3);
  });

  it('rejects non-contiguous date selection', () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id, { title: 'Eu', start_date: '2027-06-10', end_date: '2027-06-15' });
    const ids = dayIdsForTrip(trip.id, ['2027-06-11', '2027-06-13']); // gap
    const result = segmentService.createSegment({ userId: user.id, tripId: trip.id, dayIds: ids, title: 'X' });
    expect('error' in result && result.code).toBe('DAYS_NOT_CONTIGUOUS');
  });

  it('rejects days from a different trip', () => {
    const { user } = createUser(testDb);
    const tripA = createTrip(testDb, user.id, { title: 'A', start_date: '2027-06-10', end_date: '2027-06-11' });
    const tripB = createTrip(testDb, user.id, { title: 'B', start_date: '2027-07-10', end_date: '2027-07-11' });
    const mixed = [...dayIdsForTrip(tripA.id, ['2027-06-10']), ...dayIdsForTrip(tripB.id, ['2027-07-10'])];
    const result = segmentService.createSegment({ userId: user.id, tripId: tripA.id, dayIds: mixed, title: 'X' });
    expect('error' in result && result.code).toBe('DAYS_NOT_IN_TRIP');
  });

  it('rejects a caller who is not the trip owner', () => {
    const { user: alice } = createUser(testDb);
    const { user: bob } = createUser(testDb);
    const trip = createTrip(testDb, alice.id, { title: 'A', start_date: '2027-06-10', end_date: '2027-06-11' });
    const ids = dayIdsForTrip(trip.id, ['2027-06-10']);
    const result = segmentService.createSegment({ userId: bob.id, tripId: trip.id, dayIds: ids, title: 'X' });
    expect('error' in result && result.code).toBe('NOT_TRIP_OWNER');
  });

  it('rejects days already in another segment', () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id, { title: 'A', start_date: '2027-06-10', end_date: '2027-06-12' });
    const ids = dayIdsForTrip(trip.id, ['2027-06-10', '2027-06-11']);
    const first = segmentService.createSegment({ userId: user.id, tripId: trip.id, dayIds: ids, title: 'One' });
    expect('segment' in first).toBe(true);
    const dup = segmentService.createSegment({ userId: user.id, tripId: trip.id, dayIds: ids, title: 'Two' });
    expect('error' in dup && dup.code).toBe('DAYS_ALREADY_IN_SEGMENT');
  });
});

describe('segmentService.createInvite', () => {
  it('creates a 7-day-expiring token for a linked-trip owner', () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id, { title: 'A', start_date: '2027-06-10', end_date: '2027-06-11' });
    const ids = dayIdsForTrip(trip.id, ['2027-06-10']);
    const seg = segmentService.createSegment({ userId: user.id, tripId: trip.id, dayIds: ids, title: 'X' });
    if (!('segment' in seg)) throw new Error('setup');

    const invite = segmentService.createInvite({ segmentId: seg.segment.id, userId: user.id });
    expect('token' in invite).toBe(true);
    if (!('token' in invite)) return;
    expect(invite.token.length).toBeGreaterThan(20);
    const expiresMs = new Date(invite.expires_at).getTime() - Date.now();
    expect(expiresMs).toBeGreaterThan(6 * 86_400_000);
    expect(expiresMs).toBeLessThan(8 * 86_400_000);
  });

  it('rejects non-owners (OQ-F)', () => {
    const { user: alice } = createUser(testDb);
    const { user: bob } = createUser(testDb);
    const trip = createTrip(testDb, alice.id, { title: 'A', start_date: '2027-06-10', end_date: '2027-06-11' });
    const ids = dayIdsForTrip(trip.id, ['2027-06-10']);
    const seg = segmentService.createSegment({ userId: alice.id, tripId: trip.id, dayIds: ids, title: 'X' });
    if (!('segment' in seg)) throw new Error('setup');
    const result = segmentService.createInvite({ segmentId: seg.segment.id, userId: bob.id });
    expect('error' in result && result.code).toBe('NOT_SEGMENT_MEMBER');
  });
});

describe('segmentService.acceptInvite (replace_own)', () => {
  it('links the target trip and drops overlapping day rows', () => {
    const { user: alice } = createUser(testDb);
    const { user: bob } = createUser(testDb);
    const aTrip = createTrip(testDb, alice.id, { title: 'A', start_date: '2027-06-10', end_date: '2027-06-13' });
    const bTrip = createTrip(testDb, bob.id, { title: 'B', start_date: '2027-06-11', end_date: '2027-06-12' });
    const aIds = dayIdsForTrip(aTrip.id, ['2027-06-11', '2027-06-12']);
    const seg = segmentService.createSegment({ userId: alice.id, tripId: aTrip.id, dayIds: aIds, title: 'Shared' });
    if (!('segment' in seg)) throw new Error('setup');
    const inv = segmentService.createInvite({ segmentId: seg.segment.id, userId: alice.id });
    if (!('token' in inv)) throw new Error('setup');

    const before = testDb.prepare('SELECT COUNT(*) AS c FROM days WHERE trip_id = ?').get(bTrip.id) as { c: number };
    expect(before.c).toBe(2);

    const accepted = segmentService.acceptInvite({ token: inv.token, userId: bob.id, targetTripId: bTrip.id });
    expect('segment' in accepted).toBe(true);
    if (!('segment' in accepted)) return;
    expect(accepted.linked_trip_ids.sort()).toEqual([aTrip.id, bTrip.id].sort());

    // Bob's own rows on those dates should be gone; the canonical days remain under Alice's trip.
    const bAfter = testDb.prepare('SELECT COUNT(*) AS c FROM days WHERE trip_id = ?').get(bTrip.id) as { c: number };
    expect(bAfter.c).toBe(0);
    const aStill = testDb.prepare('SELECT COUNT(*) AS c FROM days WHERE trip_id = ?').get(aTrip.id) as { c: number };
    expect(aStill.c).toBe(4);
  });

  it('rejects replay of an already-accepted token', () => {
    const { user: alice } = createUser(testDb);
    const { user: bob } = createUser(testDb);
    const aTrip = createTrip(testDb, alice.id, { title: 'A', start_date: '2027-06-10', end_date: '2027-06-11' });
    const bTrip = createTrip(testDb, bob.id, { title: 'B', start_date: '2027-06-10', end_date: '2027-06-11' });
    const aIds = dayIdsForTrip(aTrip.id, ['2027-06-10']);
    const seg = segmentService.createSegment({ userId: alice.id, tripId: aTrip.id, dayIds: aIds, title: 'S' });
    if (!('segment' in seg)) throw new Error('setup');
    const inv = segmentService.createInvite({ segmentId: seg.segment.id, userId: alice.id });
    if (!('token' in inv)) throw new Error('setup');

    segmentService.acceptInvite({ token: inv.token, userId: bob.id, targetTripId: bTrip.id });
    const replay = segmentService.acceptInvite({ token: inv.token, userId: bob.id, targetTripId: bTrip.id });
    expect('error' in replay && replay.code).toBe('INVITE_ALREADY_ACCEPTED');
  });

  it('rejects a token for a trip the caller does not own', () => {
    const { user: alice } = createUser(testDb);
    const { user: bob } = createUser(testDb);
    const { user: carol } = createUser(testDb);
    const aTrip = createTrip(testDb, alice.id, { title: 'A', start_date: '2027-06-10', end_date: '2027-06-11' });
    const bTrip = createTrip(testDb, bob.id, { title: 'B', start_date: '2027-06-10', end_date: '2027-06-11' });
    const aIds = dayIdsForTrip(aTrip.id, ['2027-06-10']);
    const seg = segmentService.createSegment({ userId: alice.id, tripId: aTrip.id, dayIds: aIds, title: 'S' });
    if (!('segment' in seg)) throw new Error('setup');
    const inv = segmentService.createInvite({ segmentId: seg.segment.id, userId: alice.id });
    if (!('token' in inv)) throw new Error('setup');

    const result = segmentService.acceptInvite({ token: inv.token, userId: carol.id, targetTripId: bTrip.id });
    expect('error' in result && result.code).toBe('NOT_TRIP_OWNER');
  });

  it('rejects expired tokens', () => {
    const { user: alice } = createUser(testDb);
    const { user: bob } = createUser(testDb);
    const aTrip = createTrip(testDb, alice.id, { title: 'A', start_date: '2027-06-10', end_date: '2027-06-11' });
    const bTrip = createTrip(testDb, bob.id, { title: 'B', start_date: '2027-06-10', end_date: '2027-06-11' });
    const aIds = dayIdsForTrip(aTrip.id, ['2027-06-10']);
    const seg = segmentService.createSegment({ userId: alice.id, tripId: aTrip.id, dayIds: aIds, title: 'S' });
    if (!('segment' in seg)) throw new Error('setup');
    const inv = segmentService.createInvite({ segmentId: seg.segment.id, userId: alice.id });
    if (!('token' in inv)) throw new Error('setup');

    testDb.prepare("UPDATE segment_invites SET expires_at = datetime('now', '-1 day') WHERE token = ?").run(inv.token);
    const result = segmentService.acceptInvite({ token: inv.token, userId: bob.id, targetTripId: bTrip.id });
    expect('error' in result && result.code).toBe('INVITE_EXPIRED');
  });
});

describe('segmentService.removeTripFromSegment', () => {
  it('last sibling leaves a 2-trip segment → segment auto-dissolves, leaver keeps memento clones', () => {
    const { user: alice } = createUser(testDb);
    const { user: bob } = createUser(testDb);
    const aTrip = createTrip(testDb, alice.id, { title: 'A', start_date: '2027-06-10', end_date: '2027-06-12' });
    const bTrip = createTrip(testDb, bob.id, { title: 'B', start_date: '2027-06-10', end_date: '2027-06-12' });
    const aIds = dayIdsForTrip(aTrip.id, ['2027-06-10', '2027-06-11']);
    const seg = segmentService.createSegment({ userId: alice.id, tripId: aTrip.id, dayIds: aIds, title: 'S' });
    if (!('segment' in seg)) throw new Error('setup');
    const inv = segmentService.createInvite({ segmentId: seg.segment.id, userId: alice.id });
    if (!('token' in inv)) throw new Error('setup');
    segmentService.acceptInvite({ token: inv.token, userId: bob.id, targetTripId: bTrip.id });

    const leave = segmentService.removeTripFromSegment({ segmentId: seg.segment.id, tripId: bTrip.id, userId: bob.id });
    if (!('cloned_day_ids' in leave)) throw new Error('expected success');
    expect(leave.cloned_day_ids).toHaveLength(2);
    expect(leave.dissolved).toBe(true);

    // Segment record is gone.
    const segRow = testDb.prepare('SELECT id FROM segments WHERE id = ?').get(seg.segment.id);
    expect(segRow).toBeUndefined();
    // Alice's day rows still exist, but their segment_id pointer was cleared
    // by the ON DELETE SET NULL cascade.
    const aliceRows = testDb.prepare('SELECT segment_id FROM days WHERE trip_id = ? AND date IN (?, ?)').all(aTrip.id, '2027-06-10', '2027-06-11') as Array<{ segment_id: string | null }>;
    expect(aliceRows).toHaveLength(2);
    for (const r of aliceRows) expect(r.segment_id).toBeNull();
    // Bob's trip has the plain memento copies.
    const bPlain = testDb.prepare('SELECT COUNT(*) AS c FROM days WHERE trip_id = ? AND segment_id IS NULL').get(bTrip.id) as { c: number };
    expect(bPlain.c).toBeGreaterThanOrEqual(2);
  });

  it('one of two siblings leaves a 3-trip segment → no dissolve', () => {
    const { user: alice } = createUser(testDb);
    const { user: bob } = createUser(testDb);
    const { user: carol } = createUser(testDb);
    const aTrip = createTrip(testDb, alice.id, { title: 'A', start_date: '2027-06-10', end_date: '2027-06-11' });
    const bTrip = createTrip(testDb, bob.id, { title: 'B', start_date: '2027-06-10', end_date: '2027-06-11' });
    const cTrip = createTrip(testDb, carol.id, { title: 'C', start_date: '2027-06-10', end_date: '2027-06-11' });
    const aIds = dayIdsForTrip(aTrip.id, ['2027-06-10']);
    const seg = segmentService.createSegment({ userId: alice.id, tripId: aTrip.id, dayIds: aIds, title: 'S' });
    if (!('segment' in seg)) throw new Error('setup');

    const inv1 = segmentService.createInvite({ segmentId: seg.segment.id, userId: alice.id });
    if (!('token' in inv1)) throw new Error('setup');
    segmentService.acceptInvite({ token: inv1.token, userId: bob.id, targetTripId: bTrip.id });
    const inv2 = segmentService.createInvite({ segmentId: seg.segment.id, userId: alice.id });
    if (!('token' in inv2)) throw new Error('setup');
    segmentService.acceptInvite({ token: inv2.token, userId: carol.id, targetTripId: cTrip.id });

    const leave = segmentService.removeTripFromSegment({ segmentId: seg.segment.id, tripId: bTrip.id, userId: bob.id });
    if (!('cloned_day_ids' in leave)) throw new Error('expected success');
    expect(leave.dissolved).toBe(false);

    // Segment still exists, Alice + Carol still linked.
    const segRow = testDb.prepare('SELECT id FROM segments WHERE id = ?').get(seg.segment.id);
    expect(segRow).toBeDefined();
    const remaining = testDb.prepare('SELECT trip_id FROM trip_segments WHERE segment_id = ?').all(seg.segment.id) as Array<{ trip_id: number }>;
    expect(remaining.map(r => r.trip_id).sort()).toEqual([aTrip.id, cTrip.id].sort());
  });

  it('home trip cannot leave — must dissolve or rehome first', () => {
    const { user: alice } = createUser(testDb);
    const trip = createTrip(testDb, alice.id, { title: 'A', start_date: '2027-06-10', end_date: '2027-06-11' });
    const ids = dayIdsForTrip(trip.id, ['2027-06-10']);
    const seg = segmentService.createSegment({ userId: alice.id, tripId: trip.id, dayIds: ids, title: 'S' });
    if (!('segment' in seg)) throw new Error('setup');
    const result = segmentService.removeTripFromSegment({ segmentId: seg.segment.id, tripId: trip.id, userId: alice.id });
    expect('error' in result && result.code).toBe('HOME_TRIP_CANNOT_LEAVE');
  });
});

describe('segmentService.canDeleteTrip', () => {
  it('permits deletion of a trip with no segments', () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id, { title: 'A' });
    expect(segmentService.canDeleteTrip(trip.id)).toEqual({ ok: true });
  });

  it('permits deletion of a segment home trip with no siblings (segment will cascade)', () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id, { title: 'A', start_date: '2027-06-10', end_date: '2027-06-11' });
    const ids = dayIdsForTrip(trip.id, ['2027-06-10']);
    const seg = segmentService.createSegment({ userId: user.id, tripId: trip.id, dayIds: ids, title: 'S' });
    expect('segment' in seg).toBe(true);
    expect(segmentService.canDeleteTrip(trip.id)).toEqual({ ok: true });
  });

  it('blocks deletion of a home trip when a sibling trip is linked', () => {
    const { user: alice } = createUser(testDb);
    const { user: bob } = createUser(testDb);
    const aTrip = createTrip(testDb, alice.id, { title: 'A', start_date: '2027-06-10', end_date: '2027-06-11' });
    const bTrip = createTrip(testDb, bob.id, { title: 'B', start_date: '2027-06-10', end_date: '2027-06-11' });
    const aIds = dayIdsForTrip(aTrip.id, ['2027-06-10']);
    const seg = segmentService.createSegment({ userId: alice.id, tripId: aTrip.id, dayIds: aIds, title: 'S' });
    if (!('segment' in seg)) throw new Error('setup');
    const inv = segmentService.createInvite({ segmentId: seg.segment.id, userId: alice.id });
    if (!('token' in inv)) throw new Error('setup');
    segmentService.acceptInvite({ token: inv.token, userId: bob.id, targetTripId: bTrip.id });

    const result = segmentService.canDeleteTrip(aTrip.id);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('SEGMENT_REFERENCES');
    expect(result.blocking_segment_ids).toContain(seg.segment.id);
  });

  it('does not block the non-home sibling from being deleted', () => {
    const { user: alice } = createUser(testDb);
    const { user: bob } = createUser(testDb);
    const aTrip = createTrip(testDb, alice.id, { title: 'A', start_date: '2027-06-10', end_date: '2027-06-11' });
    const bTrip = createTrip(testDb, bob.id, { title: 'B', start_date: '2027-06-10', end_date: '2027-06-11' });
    const aIds = dayIdsForTrip(aTrip.id, ['2027-06-10']);
    const seg = segmentService.createSegment({ userId: alice.id, tripId: aTrip.id, dayIds: aIds, title: 'S' });
    if (!('segment' in seg)) throw new Error('setup');
    const inv = segmentService.createInvite({ segmentId: seg.segment.id, userId: alice.id });
    if (!('token' in inv)) throw new Error('setup');
    segmentService.acceptInvite({ token: inv.token, userId: bob.id, targetTripId: bTrip.id });

    expect(segmentService.canDeleteTrip(bTrip.id)).toEqual({ ok: true });
  });
});

describe('segmentService.getSegment', () => {
  it('rejects callers with no linked-trip membership', () => {
    const { user: alice } = createUser(testDb);
    const { user: carol } = createUser(testDb);
    const trip = createTrip(testDb, alice.id, { title: 'A', start_date: '2027-06-10', end_date: '2027-06-11' });
    const ids = dayIdsForTrip(trip.id, ['2027-06-10']);
    const seg = segmentService.createSegment({ userId: alice.id, tripId: trip.id, dayIds: ids, title: 'S' });
    if (!('segment' in seg)) throw new Error('setup');
    const result = segmentService.getSegment(seg.segment.id, carol.id);
    expect('error' in result && result.code).toBe('NOT_SEGMENT_MEMBER');
  });
});
