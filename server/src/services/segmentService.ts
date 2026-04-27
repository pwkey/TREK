// [460-fork] Shared segments (Milestone 4) — service layer.
//
// A segment is a set of days (one canonical day row per date) that appears in
// two or more trips. Every segment has exactly one "home" trip — the trip the
// day rows belong to via `days.trip_id`. Sibling trips see those days via
// `trip_segments` + the UNION read in `dayService.listDays` (wired in slice 2).
//
// Slice 1 scope: service API only, no routes, no WebSocket fan-out. The accept
// flow supports the `replace_own` strategy; `keep_own` is deferred until we
// add the per-date exclusion mechanism in slice 2.

import { randomBytes, randomUUID } from 'node:crypto';
import { db } from '../db/database';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SegmentServiceErrorCode =
  | 'TRIP_NOT_FOUND'
  | 'NOT_TRIP_OWNER'
  | 'DAYS_NOT_IN_TRIP'
  | 'DAYS_NOT_CONTIGUOUS'
  | 'DAYS_MISSING_DATE'
  | 'DAYS_ALREADY_IN_SEGMENT'
  | 'SEGMENT_NOT_FOUND'
  | 'NOT_SEGMENT_MEMBER'
  | 'INVITE_NOT_FOUND'
  | 'INVITE_EXPIRED'
  | 'INVITE_ALREADY_ACCEPTED'
  | 'HOME_TRIP_CANNOT_LEAVE'
  | 'TRIP_ALREADY_IN_SEGMENT';

export interface SegmentServiceError {
  error: string;
  code: SegmentServiceErrorCode;
  status: number;
}

export interface SegmentRow {
  id: string;
  title: string;
  start_date: string | null;
  end_date: string | null;
  created_at: string;
  updated_at: string;
  created_by: number;
  updated_by: number | null;
}

export interface SegmentView {
  segment: SegmentRow;
  linked_trip_ids: number[];
  home_trip_id: number;
  day_ids: number[];
}

export interface CreateSegmentParams {
  userId: number;
  tripId: number;
  dayIds: number[];
  title: string;
}

export interface CreateInviteResult {
  id: string;
  token: string;
  expires_at: string;
}

export type OverlapStrategy = 'replace_own';

export interface AcceptInviteParams {
  token: string;
  userId: number;
  targetTripId: number;
  strategy?: OverlapStrategy;
}

export interface LeaveResult {
  segment_id: string;
  cloned_day_ids: number[];
  /** True when this leave dropped the linked-trip count to 1 and the segment
   *  was auto-dissolved as a result. Tells the caller to clean up its UI. */
  dissolved: boolean;
}

export interface DeleteBlockInfo {
  ok: false;
  reason: 'SEGMENT_REFERENCES';
  blocking_segment_ids: string[];
}

export type CanDeleteTripResult = { ok: true } | DeleteBlockInfo;

const INVITE_TTL_DAYS = 7;

// ---------------------------------------------------------------------------
// Authorisation helpers
// ---------------------------------------------------------------------------

function isTripOwner(tripId: number, userId: number): boolean {
  const row = db.prepare('SELECT 1 FROM trips WHERE id = ? AND user_id = ?').get(tripId, userId) as unknown;
  return !!row;
}

function tripExists(tripId: number): boolean {
  return !!db.prepare('SELECT 1 FROM trips WHERE id = ?').get(tripId);
}

function isLinkedTripMember(segmentId: string, userId: number): boolean {
  // Member = owner or trip_members row on any trip linked to the segment.
  const row = db.prepare(`
    SELECT 1
      FROM trip_segments ts
      JOIN trips t ON t.id = ts.trip_id
      LEFT JOIN trip_members m ON m.trip_id = t.id AND m.user_id = ?
     WHERE ts.segment_id = ?
       AND (t.user_id = ? OR m.user_id IS NOT NULL)
     LIMIT 1
  `).get(userId, segmentId, userId);
  return !!row;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export function getSegment(segmentId: string, userId: number): SegmentView | SegmentServiceError {
  const segment = db.prepare('SELECT * FROM segments WHERE id = ?').get(segmentId) as SegmentRow | undefined;
  if (!segment) return { error: 'Segment not found', code: 'SEGMENT_NOT_FOUND', status: 404 };
  if (!isLinkedTripMember(segmentId, userId)) {
    return { error: 'Not a member of any linked trip', code: 'NOT_SEGMENT_MEMBER', status: 403 };
  }
  const links = db.prepare('SELECT trip_id, is_home FROM trip_segments WHERE segment_id = ?').all(segmentId) as Array<{ trip_id: number; is_home: number }>;
  const home = links.find((l) => l.is_home === 1);
  const days = db.prepare('SELECT id FROM days WHERE segment_id = ? ORDER BY date, day_number').all(segmentId) as Array<{ id: number }>;
  return {
    segment,
    linked_trip_ids: links.map((l) => l.trip_id),
    home_trip_id: home ? home.trip_id : 0,
    day_ids: days.map((d) => d.id),
  };
}

export function listSegmentsForTrip(tripId: number): SegmentRow[] {
  return db.prepare(`
    SELECT s.*
      FROM segments s
      JOIN trip_segments ts ON ts.segment_id = s.id
     WHERE ts.trip_id = ?
     ORDER BY s.start_date, s.created_at
  `).all(tripId) as SegmentRow[];
}

export function listTripIdsForSegment(segmentId: string): number[] {
  return (db.prepare('SELECT trip_id FROM trip_segments WHERE segment_id = ?').all(segmentId) as Array<{ trip_id: number }>).map((r) => r.trip_id);
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export function createSegment(params: CreateSegmentParams): SegmentView | SegmentServiceError {
  const { userId, tripId, dayIds, title } = params;

  if (!tripExists(tripId)) return { error: 'Trip not found', code: 'TRIP_NOT_FOUND', status: 404 };
  if (!isTripOwner(tripId, userId)) return { error: 'Only the trip owner can create a segment', code: 'NOT_TRIP_OWNER', status: 403 };

  // Validate: all days belong to this trip, none already in a segment, all have dates, contiguous.
  if (dayIds.length === 0) return { error: 'At least one day is required', code: 'DAYS_NOT_IN_TRIP', status: 400 };

  const placeholders = dayIds.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT id, trip_id, date, segment_id FROM days WHERE id IN (${placeholders})`,
  ).all(...dayIds) as Array<{ id: number; trip_id: number; date: string | null; segment_id: string | null }>;

  if (rows.length !== dayIds.length) return { error: 'Some days do not exist', code: 'DAYS_NOT_IN_TRIP', status: 400 };
  if (rows.some((r) => r.trip_id !== tripId)) return { error: 'All days must belong to the source trip', code: 'DAYS_NOT_IN_TRIP', status: 400 };
  if (rows.some((r) => r.segment_id != null)) return { error: 'Some days are already part of another segment', code: 'DAYS_ALREADY_IN_SEGMENT', status: 409 };
  if (rows.some((r) => !r.date)) return { error: 'Shared days must have a date', code: 'DAYS_MISSING_DATE', status: 400 };

  const dates = rows.map((r) => r.date!).sort();
  if (!areDatesContiguous(dates)) {
    return { error: 'Segment days must be a contiguous date range', code: 'DAYS_NOT_CONTIGUOUS', status: 400 };
  }

  const segmentId = randomUUID();
  const start = dates[0];
  const end = dates[dates.length - 1];

  const txn = db.transaction(() => {
    db.prepare(`
      INSERT INTO segments (id, title, start_date, end_date, created_by, updated_by)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(segmentId, title, start, end, userId, userId);

    db.prepare(`
      INSERT INTO trip_segments (trip_id, segment_id, is_home, joined_by)
      VALUES (?, ?, 1, ?)
    `).run(tripId, segmentId, userId);

    const stmt = db.prepare('UPDATE days SET segment_id = ? WHERE id = ?');
    for (const r of rows) stmt.run(segmentId, r.id);
  });
  txn();

  return getSegment(segmentId, userId) as SegmentView;
}

function areDatesContiguous(sortedDates: string[]): boolean {
  for (let i = 1; i < sortedDates.length; i++) {
    const prev = new Date(sortedDates[i - 1] + 'T00:00:00Z').getTime();
    const curr = new Date(sortedDates[i] + 'T00:00:00Z').getTime();
    if (curr - prev !== 86_400_000) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Invites
// ---------------------------------------------------------------------------

export function createInvite(params: { segmentId: string; userId: number }): CreateInviteResult | SegmentServiceError {
  const { segmentId, userId } = params;
  const segment = db.prepare('SELECT 1 FROM segments WHERE id = ?').get(segmentId);
  if (!segment) return { error: 'Segment not found', code: 'SEGMENT_NOT_FOUND', status: 404 };

  // OQ-F: only a linked-trip owner may mint invites.
  const ownerCheck = db.prepare(`
    SELECT 1
      FROM trip_segments ts
      JOIN trips t ON t.id = ts.trip_id
     WHERE ts.segment_id = ? AND t.user_id = ?
     LIMIT 1
  `).get(segmentId, userId);
  if (!ownerCheck) return { error: 'Only a linked-trip owner can create invites', code: 'NOT_SEGMENT_MEMBER', status: 403 };

  const id = randomUUID();
  const token = randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + INVITE_TTL_DAYS * 86_400_000).toISOString();

  db.prepare(`
    INSERT INTO segment_invites (id, segment_id, token, expires_at, created_by)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, segmentId, token, expires, userId);

  return { id, token, expires_at: expires };
}

export interface InviterSnapshot {
  id: number;
  username: string;
  email: string;
}

export interface InvitePreview {
  segment: Pick<SegmentRow, 'id' | 'title' | 'start_date' | 'end_date'>;
  inviter: InviterSnapshot;
  expires_at: string;
  accepted: boolean;
}

/**
 * Look up a segment invite by its bearer token and return the minimal preview
 * the accepter needs to decide — title, date range, expiry, AND who sent it
 * so the accepter can verify they recognise the inviter before linking a
 * trip. Does NOT leak sibling-trip titles or member lists. Any authenticated
 * user can call this with a valid token; bad/expired tokens produce the usual
 * error codes.
 */
export function getInvitePreview(token: string): InvitePreview | SegmentServiceError {
  const invite = db.prepare(
    'SELECT segment_id, expires_at, accepted_at, created_by FROM segment_invites WHERE token = ?',
  ).get(token) as { segment_id: string; expires_at: string; accepted_at: string | null; created_by: number } | undefined;
  if (!invite) return { error: 'Invite not found', code: 'INVITE_NOT_FOUND', status: 404 };
  if (new Date(invite.expires_at).getTime() < Date.now()) {
    return { error: 'Invite has expired', code: 'INVITE_EXPIRED', status: 410 };
  }
  const seg = db.prepare(
    'SELECT id, title, start_date, end_date FROM segments WHERE id = ?',
  ).get(invite.segment_id) as Pick<SegmentRow, 'id' | 'title' | 'start_date' | 'end_date'> | undefined;
  if (!seg) return { error: 'Segment not found', code: 'SEGMENT_NOT_FOUND', status: 404 };
  const inviter = db.prepare(
    'SELECT id, username, email FROM users WHERE id = ?',
  ).get(invite.created_by) as InviterSnapshot | undefined;
  if (!inviter) return { error: 'Inviter no longer exists', code: 'INVITE_NOT_FOUND', status: 404 };
  return { segment: seg, inviter, expires_at: invite.expires_at, accepted: invite.accepted_at != null };
}

export function acceptInvite(params: AcceptInviteParams): SegmentView | SegmentServiceError {
  const { token, userId, targetTripId } = params;
  // Slice 1 supports replace_own only; keep_own is deferred.
  const strategy: OverlapStrategy = 'replace_own';

  if (!tripExists(targetTripId)) return { error: 'Target trip not found', code: 'TRIP_NOT_FOUND', status: 404 };
  if (!isTripOwner(targetTripId, userId)) return { error: 'Only the target trip owner can accept', code: 'NOT_TRIP_OWNER', status: 403 };

  const invite = db.prepare('SELECT * FROM segment_invites WHERE token = ?').get(token) as {
    id: string; segment_id: string; expires_at: string; accepted_at: string | null;
  } | undefined;
  if (!invite) return { error: 'Invite not found', code: 'INVITE_NOT_FOUND', status: 404 };
  if (invite.accepted_at) return { error: 'Invite already accepted', code: 'INVITE_ALREADY_ACCEPTED', status: 409 };
  if (new Date(invite.expires_at).getTime() < Date.now()) {
    return { error: 'Invite has expired', code: 'INVITE_EXPIRED', status: 410 };
  }

  const already = db.prepare('SELECT 1 FROM trip_segments WHERE trip_id = ? AND segment_id = ?').get(targetTripId, invite.segment_id);
  if (already) return { error: 'Trip is already part of this segment', code: 'TRIP_ALREADY_IN_SEGMENT', status: 409 };

  // Segment's canonical dates are stamped on the home trip's day rows.
  const segmentDates = (db.prepare('SELECT date FROM days WHERE segment_id = ? AND date IS NOT NULL ORDER BY date').all(invite.segment_id) as Array<{ date: string }>).map((r) => r.date);

  const txn = db.transaction(() => {
    // replace_own: drop any existing day rows in the target trip on the segment's
    // dates. The segment's canonical days live on the home trip; once the target is
    // linked, those days surface via the UNION read (wired in slice 2), so there's
    // no need to create local stand-ins for uncovered dates.
    if (segmentDates.length > 0) {
      const placeholders = segmentDates.map(() => '?').join(',');
      db.prepare(`DELETE FROM days WHERE trip_id = ? AND date IN (${placeholders})`).run(targetTripId, ...segmentDates);
    }

    db.prepare(`
      INSERT INTO trip_segments (trip_id, segment_id, is_home, joined_by)
      VALUES (?, ?, 0, ?)
    `).run(targetTripId, invite.segment_id, userId);

    db.prepare('UPDATE segment_invites SET accepted_at = CURRENT_TIMESTAMP, accepted_by = ? WHERE id = ?').run(userId, invite.id);
  });
  txn();

  return getSegment(invite.segment_id, userId) as SegmentView;
}

// ---------------------------------------------------------------------------
// Leave
// ---------------------------------------------------------------------------

export function removeTripFromSegment(params: { segmentId: string; tripId: number; userId: number }): LeaveResult | SegmentServiceError {
  const { segmentId, tripId, userId } = params;
  if (!isTripOwner(tripId, userId)) return { error: 'Only the trip owner can leave a segment', code: 'NOT_TRIP_OWNER', status: 403 };

  const link = db.prepare('SELECT is_home FROM trip_segments WHERE trip_id = ? AND segment_id = ?').get(tripId, segmentId) as { is_home: number } | undefined;
  if (!link) return { error: 'Trip is not in this segment', code: 'NOT_SEGMENT_MEMBER', status: 404 };
  if (link.is_home === 1) {
    return { error: 'The home trip cannot leave a segment — dissolve or rehome first', code: 'HOME_TRIP_CANNOT_LEAVE', status: 409 };
  }

  // Clone the segment's canonical days into plain trip-owned rows for this trip so
  // the leaver keeps a memento. Day_numbers are appended after the trip's current max.
  const segmentDays = db.prepare('SELECT id, date, notes, title FROM days WHERE segment_id = ? ORDER BY date').all(segmentId) as Array<{ id: number; date: string | null; notes: string | null; title: string | null }>;
  const maxRow = db.prepare('SELECT MAX(day_number) AS max FROM days WHERE trip_id = ?').get(tripId) as { max: number | null };
  let nextDayNumber = (maxRow?.max ?? 0) + 1;

  const cloned: number[] = [];
  let dissolved = false;
  const txn = db.transaction(() => {
    const ins = db.prepare('INSERT INTO days (trip_id, day_number, date, notes, title) VALUES (?, ?, ?, ?, ?)');
    for (const d of segmentDays) {
      const r = ins.run(tripId, nextDayNumber++, d.date, d.notes, d.title);
      cloned.push(Number(r.lastInsertRowid));
    }
    db.prepare('DELETE FROM trip_segments WHERE trip_id = ? AND segment_id = ?').run(tripId, segmentId);

    // [460-fork] Auto-dissolve when the leaver was the last sibling. The home
    // trip cannot leave, so what remains is at most the home trip itself; if
    // that's the only link left, the segment is no longer being shared with
    // anyone and is just clutter on the home owner's manage list. Deleting
    // the segment row cascades trip_segments + segment_invites and triggers
    // ON DELETE SET NULL on every days.segment_id pointer, so the home
    // owner's day rows revert cleanly to ordinary trip-local days.
    const remaining = (db.prepare('SELECT COUNT(*) AS c FROM trip_segments WHERE segment_id = ?').get(segmentId) as { c: number }).c;
    if (remaining <= 1) {
      db.prepare('DELETE FROM segments WHERE id = ?').run(segmentId);
      dissolved = true;
    }
  });
  txn();

  return { segment_id: segmentId, cloned_day_ids: cloned, dissolved };
}

// ---------------------------------------------------------------------------
// Dissolve (home-owner one-click teardown)
// ---------------------------------------------------------------------------

export interface DissolveResult {
  segment_id: string;
  /** Map of sibling trip_id -> the day_ids cloned into it as memento. */
  cloned_by_trip: Record<number, number[]>;
}

/**
 * Home-owner escape hatch when siblings won't leave on their own. Clones the
 * segment days into each sibling trip as plain trip-owned rows (so each side
 * keeps a memento), then deletes the segment row — the FK cascades clear
 * trip_segments + segment_invites and the ON DELETE SET NULL on
 * days.segment_id reverts the home's day rows back to ordinary trip-local.
 */
export function dissolveSegment(params: { segmentId: string; userId: number }): DissolveResult | SegmentServiceError {
  const { segmentId, userId } = params;
  const home = db.prepare('SELECT trip_id FROM trip_segments WHERE segment_id = ? AND is_home = 1').get(segmentId) as { trip_id: number } | undefined;
  if (!home) return { error: 'Segment not found', code: 'SEGMENT_NOT_FOUND', status: 404 };
  if (!isTripOwner(home.trip_id, userId)) {
    return { error: 'Only the home trip owner can dissolve a segment', code: 'NOT_TRIP_OWNER', status: 403 };
  }

  const siblings = (db.prepare('SELECT trip_id FROM trip_segments WHERE segment_id = ? AND is_home = 0').all(segmentId) as Array<{ trip_id: number }>).map(r => r.trip_id);
  const segmentDays = db.prepare('SELECT date, notes, title FROM days WHERE segment_id = ? ORDER BY date').all(segmentId) as Array<{ date: string | null; notes: string | null; title: string | null }>;

  const clonedByTrip: Record<number, number[]> = {};
  const txn = db.transaction(() => {
    const ins = db.prepare('INSERT INTO days (trip_id, day_number, date, notes, title) VALUES (?, ?, ?, ?, ?)');
    for (const tripId of siblings) {
      const maxRow = db.prepare('SELECT MAX(day_number) AS max FROM days WHERE trip_id = ?').get(tripId) as { max: number | null };
      let nextDayNumber = (maxRow?.max ?? 0) + 1;
      const ids: number[] = [];
      for (const d of segmentDays) {
        const r = ins.run(tripId, nextDayNumber++, d.date, d.notes, d.title);
        ids.push(Number(r.lastInsertRowid));
      }
      clonedByTrip[tripId] = ids;
    }
    db.prepare('DELETE FROM segments WHERE id = ?').run(segmentId);
  });
  txn();

  return { segment_id: segmentId, cloned_by_trip: clonedByTrip };
}

// ---------------------------------------------------------------------------
// Delete-trip safety gate
// ---------------------------------------------------------------------------

export function canDeleteTrip(tripId: number): CanDeleteTripResult {
  // Blocked if this trip is the home of any segment that other trips are linked to.
  const blocking = db.prepare(`
    SELECT ts.segment_id
      FROM trip_segments ts
     WHERE ts.trip_id = ?
       AND ts.is_home = 1
       AND EXISTS (
         SELECT 1 FROM trip_segments o
          WHERE o.segment_id = ts.segment_id AND o.trip_id != ts.trip_id
       )
  `).all(tripId) as Array<{ segment_id: string }>;
  if (blocking.length === 0) return { ok: true };
  return { ok: false, reason: 'SEGMENT_REFERENCES', blocking_segment_ids: blocking.map((r) => r.segment_id) };
}
