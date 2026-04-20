import { randomUUID } from 'node:crypto';
import { db } from '../db/database';

// Dispatch wrappers — broken out for testability and to keep the sync
// invite/accept paths from awaiting network / filesystem side effects.
// Both use lazy require so we don't tangle the partner <-> notification <->
// websocket import cycle.
function wsBroadcast(userId: number, message: Record<string, unknown>): void {
  try {
    const { broadcastToUser } = require('../websocket');
    broadcastToUser(userId, message);
  } catch { /* websocket not available in this context (e.g. tests) */ }
}

function dispatchNotification(event: string, actorId: number, targetUserId: number, params: Record<string, string>, inApp?: Record<string, unknown>): void {
  // Fire-and-forget; we never want notification failures to break the core
  // partner-pair transaction. Use dynamic import to avoid circular imports.
  import('./notificationService').then(({ send }) => {
    send({ event: event as any, actorId, scope: 'user', targetId: targetUserId, params, inApp: inApp as any }).catch(() => { /* swallow */ });
  }).catch(() => { /* swallow */ });
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PartnerSnapshot {
  id: number;
  username: string;
  email: string;
  avatar_url: string | null;
}

export interface PartnerInviteRow {
  id: string;
  inviter_user_id: number;
  target_user_id: number;
  status: 'pending' | 'accepted' | 'declined' | 'expired' | 'cancelled';
  message: string | null;
  expires_at: string;
  responded_at: string | null;
  client_mutation_id: string | null;
  created_at: string;
  updated_at: string;
  created_by: number;
  updated_by: number | null;
}

export interface PartnerInviteView {
  id: string;
  inviter: PartnerSnapshot;
  target: PartnerSnapshot;
  message: string | null;
  expires_at: string;
  created_at: string;
}

export interface PartnerServiceError {
  error: string;
  code:
    | 'SELF_INVITE'
    | 'USER_NOT_FOUND'
    | 'ALREADY_PAIRED'
    | 'TARGET_ALREADY_PAIRED'
    | 'PENDING_INVITE_EXISTS'
    | 'INVITE_NOT_FOUND'
    | 'INVITE_EXPIRED'
    | 'INVITE_ALREADY_RESOLVED'
    | 'NOT_INVITE_RECIPIENT'
    | 'NOT_PAIRED';
  status: number;
}

const INVITE_TTL_DAYS = 7;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function userSnapshot(id: number): PartnerSnapshot | null {
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

function findUserByIdentifier(identifier: string): { id: number } | null {
  const trimmed = identifier.trim();
  if (!trimmed) return null;
  const lowered = trimmed.toLowerCase();
  const row = db
    .prepare('SELECT id FROM users WHERE LOWER(email) = ? OR LOWER(username) = ?')
    .get(lowered, lowered) as { id: number } | undefined;
  return row ?? null;
}

function iso(d: Date): string {
  return d.toISOString().replace('T', ' ').replace('Z', '').slice(0, 19);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function getPartner(userId: number): PartnerSnapshot | null {
  const row = db
    .prepare('SELECT partner_user_id FROM users WHERE id = ?')
    .get(userId) as { partner_user_id: number | null } | undefined;
  if (!row?.partner_user_id) return null;
  return userSnapshot(row.partner_user_id);
}

export function listIncomingInvites(userId: number): PartnerInviteView[] {
  const rows = db
    .prepare(`
      SELECT * FROM partner_invites
      WHERE target_user_id = ? AND status = 'pending' AND expires_at > CURRENT_TIMESTAMP
      ORDER BY created_at DESC
    `)
    .all(userId) as PartnerInviteRow[];
  return rows.map(rowToView).filter((v): v is PartnerInviteView => v !== null);
}

export function listOutgoingInvites(userId: number): PartnerInviteView[] {
  const rows = db
    .prepare(`
      SELECT * FROM partner_invites
      WHERE inviter_user_id = ? AND status = 'pending' AND expires_at > CURRENT_TIMESTAMP
      ORDER BY created_at DESC
    `)
    .all(userId) as PartnerInviteRow[];
  return rows.map(rowToView).filter((v): v is PartnerInviteView => v !== null);
}

function rowToView(row: PartnerInviteRow): PartnerInviteView | null {
  const inviter = userSnapshot(row.inviter_user_id);
  const target = userSnapshot(row.target_user_id);
  if (!inviter || !target) return null;
  return {
    id: row.id,
    inviter,
    target,
    message: row.message,
    expires_at: row.expires_at,
    created_at: row.created_at,
  };
}

export function sendInvite(params: {
  inviterId: number;
  targetIdentifier: string;
  message?: string | null;
  clientMutationId?: string | null;
}): { invite: PartnerInviteView } | PartnerServiceError {
  const { inviterId, targetIdentifier, message, clientMutationId } = params;

  const target = findUserByIdentifier(targetIdentifier);
  if (!target) {
    return { error: 'No user found with that email or username', code: 'USER_NOT_FOUND', status: 404 };
  }
  if (target.id === inviterId) {
    return { error: 'Cannot pair with yourself', code: 'SELF_INVITE', status: 400 };
  }

  const inviter = db
    .prepare('SELECT partner_user_id FROM users WHERE id = ?')
    .get(inviterId) as { partner_user_id: number | null } | undefined;
  if (inviter?.partner_user_id) {
    return { error: 'You already have a partner. Unpair first.', code: 'ALREADY_PAIRED', status: 409 };
  }

  const targetRow = db
    .prepare('SELECT partner_user_id FROM users WHERE id = ?')
    .get(target.id) as { partner_user_id: number | null } | undefined;
  if (targetRow?.partner_user_id) {
    return { error: 'That user is already paired with someone else', code: 'TARGET_ALREADY_PAIRED', status: 409 };
  }

  // Idempotent: replay with same client_mutation_id returns the cached invite if one exists.
  if (clientMutationId) {
    const existing = db
      .prepare('SELECT * FROM partner_invites WHERE client_mutation_id = ?')
      .get(clientMutationId) as PartnerInviteRow | undefined;
    if (existing) {
      const view = rowToView(existing);
      if (view) return { invite: view };
    }
  }

  const pending = db
    .prepare(`
      SELECT id FROM partner_invites
      WHERE status = 'pending' AND expires_at > CURRENT_TIMESTAMP
        AND ((inviter_user_id = ? AND target_user_id = ?) OR (inviter_user_id = ? AND target_user_id = ?))
    `)
    .get(inviterId, target.id, target.id, inviterId) as { id: string } | undefined;
  if (pending) {
    return { error: 'A pending invite already exists between these users', code: 'PENDING_INVITE_EXISTS', status: 409 };
  }

  const inviteId = randomUUID();
  const expiresAt = iso(new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000));
  const trimmedMessage = message?.trim().slice(0, 200) || null;

  db.prepare(`
    INSERT INTO partner_invites (
      id, inviter_user_id, target_user_id, status, message, expires_at,
      client_mutation_id, created_by, updated_by
    ) VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?)
  `).run(inviteId, inviterId, target.id, trimmedMessage, expiresAt, clientMutationId ?? null, inviterId, inviterId);

  const created = db
    .prepare('SELECT * FROM partner_invites WHERE id = ?')
    .get(inviteId) as PartnerInviteRow;
  const view = rowToView(created);
  if (!view) {
    // Should never happen — both users existed microseconds ago.
    return { error: 'Invite could not be rendered', code: 'USER_NOT_FOUND', status: 500 };
  }

  // Notify the target via WebSocket + in-app boolean notification with callbacks.
  wsBroadcast(target.id, { type: 'partner:invite', from: view.inviter, inviteId });
  dispatchNotification('partner_invite', inviterId, target.id, { actor: view.inviter.username }, {
    type: 'boolean',
    positiveCallback: { action: 'partner_invite_accept', payload: { inviteId } },
    negativeCallback: { action: 'partner_invite_decline', payload: { inviteId } },
  });

  return { invite: view };
}

export function cancelInvite(params: {
  userId: number;
  inviteId: string;
}): { ok: true } | PartnerServiceError {
  const invite = db
    .prepare('SELECT * FROM partner_invites WHERE id = ?')
    .get(params.inviteId) as PartnerInviteRow | undefined;
  if (!invite || invite.inviter_user_id !== params.userId) {
    return { error: 'Invite not found', code: 'INVITE_NOT_FOUND', status: 404 };
  }
  if (invite.status !== 'pending') {
    // Idempotent: cancelling an already-resolved invite is a no-op success.
    return { ok: true };
  }
  db.prepare(`
    UPDATE partner_invites
    SET status = 'cancelled', responded_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP, updated_by = ?
    WHERE id = ? AND status = 'pending'
  `).run(params.userId, params.inviteId);
  return { ok: true };
}

export function acceptInvite(params: {
  userId: number;
  inviteId: string;
}): { partner: PartnerSnapshot } | PartnerServiceError {
  const { userId, inviteId } = params;

  const invite = db
    .prepare('SELECT * FROM partner_invites WHERE id = ?')
    .get(inviteId) as PartnerInviteRow | undefined;
  if (!invite) return { error: 'Invite not found', code: 'INVITE_NOT_FOUND', status: 404 };
  if (invite.target_user_id !== userId) {
    return { error: 'This invite is not for you', code: 'NOT_INVITE_RECIPIENT', status: 403 };
  }
  if (invite.status !== 'pending') {
    return { error: `Invite already ${invite.status}`, code: 'INVITE_ALREADY_RESOLVED', status: 410 };
  }
  if (new Date(invite.expires_at.replace(' ', 'T') + 'Z') < new Date()) {
    db.prepare("UPDATE partner_invites SET status = 'expired', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'pending'")
      .run(inviteId);
    return { error: 'Invite has expired', code: 'INVITE_EXPIRED', status: 410 };
  }

  // Atomic symmetric pair. The UPDATE-with-guard on partner_invites prevents
  // concurrent accepts from both succeeding (second sees `.changes === 0`).
  let success = false;
  let alreadyResolved = false;
  db.transaction(() => {
    const res = db
      .prepare("UPDATE partner_invites SET status = 'accepted', responded_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP, updated_by = ? WHERE id = ? AND status = 'pending'")
      .run(userId, inviteId);
    if (res.changes !== 1) {
      alreadyResolved = true;
      return;
    }
    const inviterStill = db
      .prepare('SELECT partner_user_id FROM users WHERE id = ?')
      .get(invite.inviter_user_id) as { partner_user_id: number | null } | undefined;
    const targetStill = db
      .prepare('SELECT partner_user_id FROM users WHERE id = ?')
      .get(invite.target_user_id) as { partner_user_id: number | null } | undefined;
    if (inviterStill?.partner_user_id || targetStill?.partner_user_id) {
      // Either user got paired between the invite and this accept. Roll back.
      throw new Error('RACE_PAIRED');
    }
    db.prepare('UPDATE users SET partner_user_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(invite.inviter_user_id, invite.target_user_id);
    db.prepare('UPDATE users SET partner_user_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(invite.target_user_id, invite.inviter_user_id);
    success = true;
  })();

  if (alreadyResolved) {
    return { error: 'Invite already resolved', code: 'INVITE_ALREADY_RESOLVED', status: 410 };
  }
  if (!success) {
    return { error: 'Either user was paired before this invite could be accepted', code: 'ALREADY_PAIRED', status: 409 };
  }

  const partner = userSnapshot(invite.inviter_user_id)!;
  // Tell the inviter the pairing completed, real-time and in-app.
  wsBroadcast(invite.inviter_user_id, { type: 'partner:response', inviteId, status: 'accepted' });
  return { partner };
}

export function declineInvite(params: {
  userId: number;
  inviteId: string;
}): { ok: true } | PartnerServiceError {
  const invite = db
    .prepare('SELECT * FROM partner_invites WHERE id = ?')
    .get(params.inviteId) as PartnerInviteRow | undefined;
  if (!invite || invite.target_user_id !== params.userId) {
    return { error: 'Invite not found', code: 'INVITE_NOT_FOUND', status: 404 };
  }
  if (invite.status !== 'pending') {
    return { ok: true };
  }
  db.prepare(`
    UPDATE partner_invites
    SET status = 'declined', responded_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP, updated_by = ?
    WHERE id = ? AND status = 'pending'
  `).run(params.userId, params.inviteId);
  wsBroadcast(invite.inviter_user_id, { type: 'partner:response', inviteId: params.inviteId, status: 'declined' });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Trip auto-add + backfill (slice 4)
// ---------------------------------------------------------------------------

/**
 * On trip creation by `ownerId`, if that user has a partner, insert a
 * trip_members row for the partner so they automatically see the trip
 * without a manual invite. Safe to call from both the create and copy
 * paths — ON CONFLICT DO NOTHING guards against duplicates. Fire-and-
 * forget notification + websocket dispatch via the existing trip_invite
 * event type (partner auto-adds are semantically a lightweight invite).
 */
export function autoAddPartnerToTrip(ownerId: number, tripId: number, tripTitle: string): { added: boolean; partnerId: number | null } {
  const row = db.prepare('SELECT partner_user_id FROM users WHERE id = ?').get(ownerId) as { partner_user_id: number | null } | undefined;
  const partnerId = row?.partner_user_id ?? null;
  if (!partnerId) return { added: false, partnerId: null };

  const result = db
    .prepare('INSERT INTO trip_members (trip_id, user_id, invited_by) VALUES (?, ?, ?) ON CONFLICT DO NOTHING')
    .run(tripId, partnerId, ownerId);
  const added = result.changes > 0;

  if (added) {
    const owner = db.prepare('SELECT username, email FROM users WHERE id = ?').get(ownerId) as { username: string; email: string } | undefined;
    wsBroadcast(partnerId, { type: 'trip:member_added', tripId, tripTitle });
    dispatchNotification('trip_invite', ownerId, partnerId, {
      actor: owner?.email ?? 'Your partner',
      trip: tripTitle,
      tripId: String(tripId),
    });
  }

  return { added, partnerId };
}

/**
 * Opt-in one-time backfill: after pairing, add the partner as a trip_member
 * on every trip the caller currently owns. Idempotent — re-running adds
 * zero rows. Notification volume per user decision: aggregate if > 5 new
 * trips, per-trip otherwise.
 */
export function backfillTrips(userId: number): { added: number; skipped: number; trip_ids: number[] } | PartnerServiceError {
  const row = db.prepare('SELECT partner_user_id FROM users WHERE id = ?').get(userId) as { partner_user_id: number | null } | undefined;
  const partnerId = row?.partner_user_id ?? null;
  if (!partnerId) {
    return { error: 'Not paired', code: 'NOT_PAIRED', status: 409 };
  }

  const trips = db
    .prepare('SELECT id, title FROM trips WHERE user_id = ?')
    .all(userId) as Array<{ id: number; title: string }>;

  const addedTrips: Array<{ id: number; title: string }> = [];
  let skipped = 0;

  const txn = db.transaction(() => {
    for (const trip of trips) {
      const res = db
        .prepare('INSERT INTO trip_members (trip_id, user_id, invited_by) VALUES (?, ?, ?) ON CONFLICT DO NOTHING')
        .run(trip.id, partnerId, userId);
      if (res.changes > 0) addedTrips.push(trip);
      else skipped++;
    }
    db.prepare(`
      INSERT INTO settings (user_id, key, value) VALUES (?, 'partner_backfill_done', 'true')
      ON CONFLICT(user_id, key) DO UPDATE SET value = 'true'
    `).run(userId);
  });
  txn();

  // Notify partner. ≤ 5: one notification per trip (preserves per-trip
  // context). > 5: one aggregate notification (avoids spam).
  if (addedTrips.length > 0) {
    const owner = db.prepare('SELECT email FROM users WHERE id = ?').get(userId) as { email: string } | undefined;
    const actor = owner?.email ?? 'Your partner';
    if (addedTrips.length > 5) {
      dispatchNotification('trip_invite', userId, partnerId, {
        actor,
        trip: `${addedTrips.length} trips`,
      });
    } else {
      for (const trip of addedTrips) {
        dispatchNotification('trip_invite', userId, partnerId, {
          actor,
          trip: trip.title,
          tripId: String(trip.id),
        });
      }
    }
  }

  return { added: addedTrips.length, skipped, trip_ids: addedTrips.map(t => t.id) };
}

export function hasBackfilledTrips(userId: number): boolean {
  const row = db
    .prepare("SELECT value FROM settings WHERE user_id = ? AND key = 'partner_backfill_done'")
    .get(userId) as { value: string } | undefined;
  return row?.value === 'true';
}

export function unpair(userId: number): { ok: true } | PartnerServiceError {
  const row = db
    .prepare('SELECT partner_user_id FROM users WHERE id = ?')
    .get(userId) as { partner_user_id: number | null } | undefined;
  if (!row?.partner_user_id) {
    // Idempotent: unpairing when not paired is success.
    return { ok: true };
  }
  const partnerId = row.partner_user_id;
  db.transaction(() => {
    db.prepare('UPDATE users SET partner_user_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(userId);
    db.prepare('UPDATE users SET partner_user_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(partnerId);
  })();
  return { ok: true };
}
