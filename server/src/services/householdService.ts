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
import { randomUUID, randomBytes } from 'node:crypto';
import { db } from '../db/database';

// Dispatch wrappers for invite notifications. Lazy require avoids the
// service ↔ notification ↔ websocket import cycle.
function wsBroadcast(userId: number, message: Record<string, unknown>): void {
  try {
    const { broadcastToUser } = require('../websocket');
    broadcastToUser(userId, message);
  } catch { /* websocket unavailable (tests) */ }
}

function dispatchNotification(event: string, actorId: number, targetUserId: number, params: Record<string, string>, inApp?: Record<string, unknown>): void {
  import('./notificationService').then(({ send }) => {
    send({ event: event as any, actorId, scope: 'user', targetId: targetUserId, params, inApp: inApp as any }).catch(() => { /* swallow */ });
  }).catch(() => { /* swallow */ });
}

const INVITE_TTL_DAYS = 7;

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
    | 'INVALID_INPUT'
    | 'INVITE_NOT_FOUND'
    | 'INVITE_EXPIRED'
    | 'INVITE_ALREADY_RESOLVED'
    | 'INVITE_NOT_FOR_YOU'
    | 'PENDING_INVITE_EXISTS'
    | 'SELF_INVITE';
  status: number;
}

export interface InviteRow {
  id: string;
  household_id: number;
  invitee_email: string;
  invited_by: number;
  token: string;
  status: 'pending' | 'accepted' | 'declined' | 'expired' | 'cancelled';
  message: string | null;
  expires_at: string;
  responded_at: string | null;
  client_mutation_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface InviteView {
  id: string;
  household_id: number;
  household_name: string | null;
  invitee_email: string;
  invited_by: UserSnapshot | null;
  token: string;
  status: InviteRow['status'];
  message: string | null;
  expires_at: string;
  created_at: string;
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
// Invites (Milestone 11 slice 2)
// ---------------------------------------------------------------------------

function isoTimestamp(d: Date): string {
  return d.toISOString().replace('T', ' ').replace('Z', '').slice(0, 19);
}

function inviteRowToView(row: InviteRow): InviteView {
  const household = householdRow(row.household_id);
  const inviter = userSnapshot(row.invited_by);
  return {
    id: row.id,
    household_id: row.household_id,
    household_name: household?.name ?? null,
    invitee_email: row.invitee_email,
    invited_by: inviter,
    token: row.token,
    status: row.status,
    message: row.message,
    expires_at: row.expires_at,
    created_at: row.created_at,
  };
}

function findUserByEmail(email: string): { id: number; email: string } | null {
  const lowered = email.trim().toLowerCase();
  const row = db
    .prepare('SELECT id, email FROM users WHERE LOWER(email) = ?')
    .get(lowered) as { id: number; email: string } | undefined;
  return row ?? null;
}

export function sendInvite(params: {
  userId: number;
  inviteeEmail: string;
  message?: string | null;
  clientMutationId?: string | null;
}): { invite: InviteView } | HouseholdServiceError {
  const { userId, inviteeEmail, message, clientMutationId } = params;
  const email = inviteeEmail?.trim();
  if (!email || !email.includes('@')) {
    return { error: 'A valid email is required', code: 'INVALID_INPUT', status: 400 };
  }
  const snap = getHouseholdForUser(userId);
  if (!snap) return { error: 'Create a household first', code: 'NOT_IN_HOUSEHOLD', status: 404 };

  const inviter = userSnapshot(userId);
  if (inviter && inviter.email.toLowerCase() === email.toLowerCase()) {
    return { error: 'Cannot invite yourself', code: 'SELF_INVITE', status: 400 };
  }

  // If the invitee already exists AND is already in a household (this one or
  // another), surface a clear error.
  const existingUser = findUserByEmail(email);
  if (existingUser) {
    const userHh = db
      .prepare('SELECT household_id FROM users WHERE id = ?')
      .get(existingUser.id) as { household_id: number | null } | undefined;
    if (userHh?.household_id === snap.id) {
      return { error: 'That user is already in your household', code: 'ALREADY_IN_HOUSEHOLD', status: 409 };
    }
    if (userHh?.household_id) {
      return { error: 'That user is already in another household', code: 'ALREADY_IN_HOUSEHOLD', status: 409 };
    }
  }

  // [460-fork] Notify dispatch, shared by the fresh-insert path AND the
  // re-send path below. Real-time WS ping + a persisted in-app (bell)
  // notification with accept/decline callbacks. Only meaningful when the
  // invitee already has an account — otherwise there is no one to notify.
  const notifyInvitee = (inviteeUserId: number, theInviteId: string, theToken: string): void => {
    wsBroadcast(inviteeUserId, { type: 'household:invite', from: inviter, inviteId: theInviteId, token: theToken, householdName: snap.name });
    dispatchNotification('household_invite', userId, inviteeUserId,
      { actor: inviter?.username ?? 'A household', household: snap.name ?? 'household' },
      {
        type: 'boolean',
        positiveCallback: { action: 'household_invite_accept', payload: { token: theToken } },
        negativeCallback: { action: 'household_invite_decline', payload: { token: theToken } },
      });
  };

  // Idempotency: replaying with the same client_mutation_id returns the
  // already-stored invite.
  if (clientMutationId) {
    const existing = db
      .prepare('SELECT * FROM household_invites WHERE client_mutation_id = ?')
      .get(clientMutationId) as InviteRow | undefined;
    if (existing) {
      return { invite: inviteRowToView(existing) };
    }
  }

  // No more than one outstanding pending invite for the same (household, email).
  const pending = db
    .prepare(`
      SELECT * FROM household_invites
      WHERE household_id = ? AND LOWER(invitee_email) = ?
        AND status = 'pending' AND expires_at > CURRENT_TIMESTAMP
    `)
    .get(snap.id, email.toLowerCase()) as InviteRow | undefined;
  if (pending) {
    // [460-fork] A pending invite already exists. The common real-world case
    // is "invited before they had an account, then they registered, then I
    // re-sent": the original invite never produced a notification (there was
    // no account to notify at the time). So on a re-send, if the invitee NOW
    // has an account, re-fire the notification against the existing invite
    // rather than erroring — that's exactly what the user expects a re-send to
    // do. If they still have no account there's no one to ping; the pending
    // invite will surface in their Household settings + home-screen banner the
    // moment they register (matched by email).
    if (existingUser) {
      notifyInvitee(existingUser.id, pending.id, pending.token);
      return { invite: inviteRowToView(pending) };
    }
    return { error: 'A pending invite already exists for that email', code: 'PENDING_INVITE_EXISTS', status: 409 };
  }

  const inviteId = randomUUID();
  const token = randomBytes(24).toString('base64url');
  const expiresAt = isoTimestamp(new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000));
  const trimmedMessage = message?.trim().slice(0, 200) || null;

  db.prepare(`
    INSERT INTO household_invites (
      id, household_id, invitee_email, invited_by, token, status,
      message, expires_at, client_mutation_id
    ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)
  `).run(inviteId, snap.id, email, userId, token, trimmedMessage, expiresAt, clientMutationId ?? null);

  const created = db
    .prepare('SELECT * FROM household_invites WHERE id = ?')
    .get(inviteId) as InviteRow;
  const view = inviteRowToView(created);

  // Notify the invitee if they already have an account.
  if (existingUser) {
    notifyInvitee(existingUser.id, inviteId, token);
  }

  return { invite: view };
}

export function cancelInvite(params: { userId: number; inviteId: string }): { ok: true } | HouseholdServiceError {
  const snap = getHouseholdForUser(params.userId);
  if (!snap) return { error: 'Not in a household', code: 'NOT_IN_HOUSEHOLD', status: 404 };
  const invite = db
    .prepare('SELECT * FROM household_invites WHERE id = ?')
    .get(params.inviteId) as InviteRow | undefined;
  if (!invite || invite.household_id !== snap.id) {
    return { error: 'Invite not found', code: 'INVITE_NOT_FOUND', status: 404 };
  }
  if (invite.status !== 'pending') {
    // Idempotent.
    return { ok: true };
  }
  db.prepare(`
    UPDATE household_invites
       SET status = 'cancelled', responded_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND status = 'pending'
  `).run(params.inviteId);
  return { ok: true };
}

export function acceptInvite(params: {
  userId: number;
  token: string;
}): { household: HouseholdSnapshot } | HouseholdServiceError {
  const { userId, token } = params;
  const invite = db
    .prepare('SELECT * FROM household_invites WHERE token = ?')
    .get(token) as InviteRow | undefined;
  if (!invite) return { error: 'Invite not found', code: 'INVITE_NOT_FOUND', status: 404 };
  if (invite.status !== 'pending') {
    return { error: `Invite already ${invite.status}`, code: 'INVITE_ALREADY_RESOLVED', status: 410 };
  }
  if (new Date(invite.expires_at.replace(' ', 'T') + 'Z') < new Date()) {
    db.prepare("UPDATE household_invites SET status = 'expired', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'pending'")
      .run(invite.id);
    return { error: 'Invite has expired', code: 'INVITE_EXPIRED', status: 410 };
  }

  // Confirm the acting user's email matches the invite's invitee_email.
  // We accept either an exact match OR the user is logged in (the email is
  // who the invite was for — defence against guessed tokens).
  const user = db
    .prepare('SELECT id, email, household_id FROM users WHERE id = ?')
    .get(userId) as { id: number; email: string; household_id: number | null } | undefined;
  if (!user) return { error: 'User not found', code: 'INVITE_NOT_FOUND', status: 404 };
  if (user.email.toLowerCase() !== invite.invitee_email.toLowerCase()) {
    return { error: 'This invite is for a different email', code: 'INVITE_NOT_FOR_YOU', status: 403 };
  }

  let leftPreviousHousehold = false;
  db.transaction(() => {
    const res = db
      .prepare("UPDATE household_invites SET status = 'accepted', responded_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'pending'")
      .run(invite.id);
    if (res.changes !== 1) {
      throw new Error('RACE_RESOLVED');
    }
    // If the user is already in another household, leave it first.
    if (user.household_id && user.household_id !== invite.household_id) {
      const remaining = db
        .prepare('SELECT COUNT(*) AS c FROM users WHERE household_id = ? AND id != ?')
        .get(user.household_id, user.id) as { c: number };
      db.prepare('UPDATE users SET household_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(user.id);
      if (remaining.c === 0) {
        db.prepare('DELETE FROM households WHERE id = ?').run(user.household_id);
      }
      leftPreviousHousehold = true;
    }
    db.prepare('UPDATE users SET household_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(invite.household_id, user.id);
  })();

  // Notify the inviter.
  wsBroadcast(invite.invited_by, { type: 'household:response', token: invite.token, status: 'accepted' });

  const snap = getHouseholdForUser(userId);
  if (!snap) {
    return { error: 'Household disappeared after accept', code: 'HOUSEHOLD_NOT_FOUND', status: 500 };
  }
  // Silence the unused warning — kept for clarity around what this method does.
  void leftPreviousHousehold;
  return { household: snap };
}

export function declineInvite(params: { userId: number; token: string }): { ok: true } | HouseholdServiceError {
  const invite = db
    .prepare('SELECT * FROM household_invites WHERE token = ?')
    .get(params.token) as InviteRow | undefined;
  if (!invite) return { error: 'Invite not found', code: 'INVITE_NOT_FOUND', status: 404 };
  if (invite.status !== 'pending') return { ok: true }; // idempotent
  const user = db
    .prepare('SELECT email FROM users WHERE id = ?')
    .get(params.userId) as { email: string } | undefined;
  if (!user || user.email.toLowerCase() !== invite.invitee_email.toLowerCase()) {
    return { error: 'This invite is for a different email', code: 'INVITE_NOT_FOR_YOU', status: 403 };
  }
  db.prepare(`
    UPDATE household_invites
       SET status = 'declined', responded_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND status = 'pending'
  `).run(invite.id);
  wsBroadcast(invite.invited_by, { type: 'household:response', token: invite.token, status: 'declined' });
  return { ok: true };
}

export function listOutgoingInvites(userId: number): InviteView[] {
  const snap = getHouseholdForUser(userId);
  if (!snap) return [];
  const rows = db
    .prepare(`
      SELECT * FROM household_invites
      WHERE household_id = ? AND status = 'pending' AND expires_at > CURRENT_TIMESTAMP
      ORDER BY created_at DESC
    `)
    .all(snap.id) as InviteRow[];
  return rows.map(inviteRowToView);
}

export function listIncomingInvites(userId: number): InviteView[] {
  const user = db
    .prepare('SELECT email FROM users WHERE id = ?')
    .get(userId) as { email: string } | undefined;
  if (!user) return [];
  const rows = db
    .prepare(`
      SELECT * FROM household_invites
      WHERE LOWER(invitee_email) = ? AND status = 'pending' AND expires_at > CURRENT_TIMESTAMP
      ORDER BY created_at DESC
    `)
    .all(user.email.toLowerCase()) as InviteRow[];
  return rows.map(inviteRowToView);
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
