// [460-fork] Milestone 11 — Household service.
//
// Supersedes M3 partner pairing. A household groups:
//   - 0+ user-accounts (each with their own login; users.household_id FK)
//   - 0+ named non-account "household_members" (kids, pets, granny —
//     never log in, just exist on the trip's roster for data purposes:
//     reservations, photo tags, future expense splits)
//
// Single household per user (nullable users.household_id). Pairing /
// invite / accept lives in slice 2 of M11 (see ours-milestone-11-plan.md).
// This slice 1 service covers everything else: create, read, leave, and
// CRUD on named members.
import { db } from '../db/database';

export interface UserSnapshot {
  id: number;
  username: string;
  email: string;
  avatar_url: string | null;
}

export interface HouseholdMemberRow {
  id: number;
  household_id: number;
  name: string;
  dob: string | null;
  relationship: string | null;
  created_at: string;
  created_by: number;
  updated_at: string;
  updated_by: number | null;
}

export interface HouseholdSnapshot {
  id: number;
  name: string | null;
  created_at: string;
  created_by: number;
  users: UserSnapshot[];
  members: HouseholdMemberRow[];
}

export interface HouseholdServiceError {
  error: string;
  code:
    | 'NOT_IN_HOUSEHOLD'
    | 'ALREADY_IN_HOUSEHOLD'
    | 'HOUSEHOLD_NOT_FOUND'
    | 'MEMBER_NOT_FOUND'
    | 'NOT_AUTHORISED'
    | 'INVALID_INPUT';
  status: number;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function userSnapshot(id: number): UserSnapshot | null {
  const row = db
    .prepare('SELECT id, username, email, avatar FROM users WHERE id = ?')
    .get(id) as { id: number; username: string; email: string; avatar: string | null } | undefined;
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    avatar_url: row.avatar ? `/uploads/avatars/${row.avatar}` : null,
  };
}

function householdUsers(householdId: number): UserSnapshot[] {
  const rows = db
    .prepare('SELECT id, username, email, avatar FROM users WHERE household_id = ? ORDER BY id')
    .all(householdId) as Array<{ id: number; username: string; email: string; avatar: string | null }>;
  return rows.map(r => ({
    id: r.id,
    username: r.username,
    email: r.email,
    avatar_url: r.avatar ? `/uploads/avatars/${r.avatar}` : null,
  }));
}

function householdMembers(householdId: number): HouseholdMemberRow[] {
  return db
    .prepare('SELECT * FROM household_members WHERE household_id = ? ORDER BY id')
    .all(householdId) as HouseholdMemberRow[];
}

function householdRow(id: number): { id: number; name: string | null; created_at: string; created_by: number } | null {
  return (db
    .prepare('SELECT id, name, created_at, created_by FROM households WHERE id = ?')
    .get(id) as { id: number; name: string | null; created_at: string; created_by: number } | undefined) ?? null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function getHouseholdForUser(userId: number): HouseholdSnapshot | null {
  const row = db
    .prepare('SELECT household_id FROM users WHERE id = ?')
    .get(userId) as { household_id: number | null } | undefined;
  const hid = row?.household_id ?? null;
  if (!hid) return null;
  const hh = householdRow(hid);
  if (!hh) return null;
  return {
    id: hh.id,
    name: hh.name,
    created_at: hh.created_at,
    created_by: hh.created_by,
    users: householdUsers(hid),
    members: householdMembers(hid),
  };
}

/**
 * Returns every other user in the same household as `userId`. Used by
 * trip auto-add to fan out a new trip to the rest of the household.
 * Excludes the caller; returns empty array if not in a household.
 */
export function getOtherHouseholdUserIds(userId: number): number[] {
  const row = db
    .prepare('SELECT household_id FROM users WHERE id = ?')
    .get(userId) as { household_id: number | null } | undefined;
  if (!row?.household_id) return [];
  const others = db
    .prepare('SELECT id FROM users WHERE household_id = ? AND id != ? ORDER BY id')
    .all(row.household_id, userId) as Array<{ id: number }>;
  return others.map(r => r.id);
}

export function createHousehold(params: {
  userId: number;
  name?: string | null;
}): { household: HouseholdSnapshot } | HouseholdServiceError {
  const { userId, name } = params;
  const existing = db
    .prepare('SELECT household_id FROM users WHERE id = ?')
    .get(userId) as { household_id: number | null } | undefined;
  if (existing?.household_id) {
    return { error: 'You are already in a household. Leave first to create a new one.', code: 'ALREADY_IN_HOUSEHOLD', status: 409 };
  }
  const trimmed = name?.trim().slice(0, 100) || null;
  let hid = -1;
  db.transaction(() => {
    const res = db
      .prepare('INSERT INTO households (name, created_by) VALUES (?, ?)')
      .run(trimmed, userId);
    hid = Number(res.lastInsertRowid);
    db.prepare('UPDATE users SET household_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(hid, userId);
  })();
  const snap = getHouseholdForUser(userId);
  if (!snap) {
    // Should be unreachable — we just inserted.
    return { error: 'Household created but not readable', code: 'HOUSEHOLD_NOT_FOUND', status: 500 };
  }
  return { household: snap };
}

export function renameHousehold(params: {
  userId: number;
  name: string | null;
}): { household: HouseholdSnapshot } | HouseholdServiceError {
  const snap = getHouseholdForUser(params.userId);
  if (!snap) return { error: 'Not in a household', code: 'NOT_IN_HOUSEHOLD', status: 404 };
  const trimmed = params.name?.trim().slice(0, 100) || null;
  db.prepare('UPDATE households SET name = ?, updated_at = CURRENT_TIMESTAMP, updated_by = ? WHERE id = ?')
    .run(trimmed, params.userId, snap.id);
  const updated = getHouseholdForUser(params.userId);
  return { household: updated! };
}

/**
 * Leaves the current household. If the user was the last account in
 * the household, the household and all its named members are deleted
 * (FK cascade handles members). Otherwise the household persists for
 * the remaining users.
 *
 * No effect on existing trips — by design (CLAUDE.md Q6 default).
 */
export function leaveHousehold(userId: number): { ok: true } | HouseholdServiceError {
  const row = db
    .prepare('SELECT household_id FROM users WHERE id = ?')
    .get(userId) as { household_id: number | null } | undefined;
  const hid = row?.household_id ?? null;
  if (!hid) {
    // Idempotent: leaving when not in a household is a no-op success.
    return { ok: true };
  }
  db.transaction(() => {
    db.prepare('UPDATE users SET household_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(userId);
    const remaining = db
      .prepare('SELECT COUNT(*) AS c FROM users WHERE household_id = ?')
      .get(hid) as { c: number };
    if (remaining.c === 0) {
      db.prepare('DELETE FROM households WHERE id = ?').run(hid);
      // Named members cascade-delete via FK.
    }
  })();
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Named members (B from M11 plan)
// ---------------------------------------------------------------------------

export function addMember(params: {
  userId: number;
  name: string;
  dob?: string | null;
  relationship?: string | null;
}): { member: HouseholdMemberRow } | HouseholdServiceError {
  const snap = getHouseholdForUser(params.userId);
  if (!snap) return { error: 'Not in a household', code: 'NOT_IN_HOUSEHOLD', status: 404 };
  const name = params.name?.trim().slice(0, 100);
  if (!name) return { error: 'Name is required', code: 'INVALID_INPUT', status: 400 };
  const dob = params.dob?.trim() || null;
  const relationship = params.relationship?.trim().slice(0, 50) || null;
  const res = db
    .prepare(`
      INSERT INTO household_members (household_id, name, dob, relationship, created_by, updated_by)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
    .run(snap.id, name, dob, relationship, params.userId, params.userId);
  const member = db
    .prepare('SELECT * FROM household_members WHERE id = ?')
    .get(Number(res.lastInsertRowid)) as HouseholdMemberRow;
  return { member };
}

export function updateMember(params: {
  userId: number;
  memberId: number;
  name?: string;
  dob?: string | null;
  relationship?: string | null;
}): { member: HouseholdMemberRow } | HouseholdServiceError {
  const snap = getHouseholdForUser(params.userId);
  if (!snap) return { error: 'Not in a household', code: 'NOT_IN_HOUSEHOLD', status: 404 };
  const existing = db
    .prepare('SELECT * FROM household_members WHERE id = ?')
    .get(params.memberId) as HouseholdMemberRow | undefined;
  if (!existing) return { error: 'Member not found', code: 'MEMBER_NOT_FOUND', status: 404 };
  if (existing.household_id !== snap.id) {
    return { error: 'Member belongs to a different household', code: 'NOT_AUTHORISED', status: 403 };
  }
  const next = {
    name: params.name === undefined ? existing.name : (params.name?.trim().slice(0, 100) || existing.name),
    dob: params.dob === undefined ? existing.dob : (params.dob?.trim() || null),
    relationship: params.relationship === undefined ? existing.relationship : (params.relationship?.trim().slice(0, 50) || null),
  };
  if (!next.name) return { error: 'Name is required', code: 'INVALID_INPUT', status: 400 };
  db.prepare(`
    UPDATE household_members
       SET name = ?, dob = ?, relationship = ?,
           updated_at = CURRENT_TIMESTAMP, updated_by = ?
     WHERE id = ?
  `).run(next.name, next.dob, next.relationship, params.userId, params.memberId);
  const member = db
    .prepare('SELECT * FROM household_members WHERE id = ?')
    .get(params.memberId) as HouseholdMemberRow;
  return { member };
}

export function deleteMember(params: {
  userId: number;
  memberId: number;
}): { ok: true } | HouseholdServiceError {
  const snap = getHouseholdForUser(params.userId);
  if (!snap) return { error: 'Not in a household', code: 'NOT_IN_HOUSEHOLD', status: 404 };
  const existing = db
    .prepare('SELECT household_id FROM household_members WHERE id = ?')
    .get(params.memberId) as { household_id: number } | undefined;
  if (!existing) {
    // Idempotent — deleting an already-deleted member is success.
    return { ok: true };
  }
  if (existing.household_id !== snap.id) {
    return { error: 'Member belongs to a different household', code: 'NOT_AUTHORISED', status: 403 };
  }
  db.prepare('DELETE FROM household_members WHERE id = ?').run(params.memberId);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Trip auto-add (Milestone 11 slice 4 wires this into createTrip)
// ---------------------------------------------------------------------------

/**
 * When `ownerId` creates a trip, fan out trip_members rows to every
 * other user in their household. Returns the list of user IDs added.
 * Safe to call when the user has no household — returns an empty list.
 *
 * Note: only user-accounts auto-add. Named members are not trip_members
 * (they don't have accounts). They become relevant in Smart Import
 * passenger matching (M11 slice 5) and expense splitting (deferred).
 */
export function autoAddHouseholdToTrip(ownerId: number, tripId: number): { added: number[] } {
  const otherIds = getOtherHouseholdUserIds(ownerId);
  if (otherIds.length === 0) return { added: [] };
  const added: number[] = [];
  const insert = db.prepare('INSERT INTO trip_members (trip_id, user_id, invited_by) VALUES (?, ?, ?) ON CONFLICT DO NOTHING');
  db.transaction(() => {
    for (const uid of otherIds) {
      const res = insert.run(tripId, uid, ownerId);
      if (res.changes > 0) added.push(uid);
    }
  })();
  return { added };
}
