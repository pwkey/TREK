// [460-fork] Milestone 5 slice 4 — conflict detection + review.
//
// When a queued mutation arrives at a route with an If-Unmodified-Since
// header, the route compares the header to the record's current updated_at.
// If they don't match, the mutation is parked here as a conflict instead of
// applied; the user reviews via Settings → Pending conflicts and chooses
// mine / theirs / combine.
//
// Slice 4 wires this into the day-update path. Other routes can adopt the
// same parkAsConflict() helper later.

import { randomUUID } from 'node:crypto';
import { db } from '../db/database';

export interface ConflictRow {
  id: string;
  user_id: number;
  client_mutation_id: string;
  endpoint: string;
  method: string;
  record_type: string;
  record_id: number;
  record_trip_id: number | null;
  mine_payload: string;
  theirs_snapshot: string;
  observed_updated_at: string;
  server_updated_at: string;
  created_at: string;
  resolved_at: string | null;
  resolved_choice: string | null;
}

export interface ConflictView {
  id: string;
  client_mutation_id: string;
  endpoint: string;
  method: string;
  record_type: string;
  record_id: number;
  mine: unknown;
  theirs: unknown;
  observed_at: string;
  server_at: string;
  created_at: string;
}

export type ResolveChoice = 'mine' | 'theirs' | 'combine';

export interface ConflictsServiceError {
  error: string;
  code: 'CONFLICT_NOT_FOUND' | 'INVALID_CHOICE' | 'COMBINE_REQUIRES_MERGED';
  status: number;
}

/**
 * Stash the mutation as a pending conflict and return the row id. The route
 * handler should respond with 409 + this id so the client can correlate.
 */
export function parkAsConflict(params: {
  userId: number;
  clientMutationId: string;
  endpoint: string;
  method: string;
  recordType: string;
  recordId: number;
  recordTripId?: number | null;
  minePayload: unknown;
  theirsSnapshot: unknown;
  observedUpdatedAt: string;
  serverUpdatedAt: string;
}): string {
  const id = randomUUID();
  db.prepare(`
    INSERT INTO client_mutation_conflicts (
      id, user_id, client_mutation_id, endpoint, method, record_type, record_id, record_trip_id,
      mine_payload, theirs_snapshot, observed_updated_at, server_updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    params.userId,
    params.clientMutationId,
    params.endpoint,
    params.method,
    params.recordType,
    params.recordId,
    params.recordTripId ?? null,
    JSON.stringify(params.minePayload ?? null),
    JSON.stringify(params.theirsSnapshot ?? null),
    params.observedUpdatedAt,
    params.serverUpdatedAt,
  );
  return id;
}

export function listConflicts(userId: number): ConflictView[] {
  const rows = db
    .prepare(
      `SELECT * FROM client_mutation_conflicts WHERE user_id = ? AND resolved_at IS NULL ORDER BY created_at DESC`,
    )
    .all(userId) as ConflictRow[];
  return rows.map((r) => ({
    id: r.id,
    client_mutation_id: r.client_mutation_id,
    endpoint: r.endpoint,
    method: r.method,
    record_type: r.record_type,
    record_id: r.record_id,
    mine: safeJsonParse(r.mine_payload),
    theirs: safeJsonParse(r.theirs_snapshot),
    observed_at: r.observed_updated_at,
    server_at: r.server_updated_at,
    created_at: r.created_at,
  }));
}

export function countConflicts(userId: number): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS c FROM client_mutation_conflicts WHERE user_id = ? AND resolved_at IS NULL`)
    .get(userId) as { c: number };
  return row.c;
}

export function getConflict(userId: number, conflictId: string): ConflictRow | null {
  const row = db
    .prepare(`SELECT * FROM client_mutation_conflicts WHERE id = ? AND user_id = ?`)
    .get(conflictId, userId) as ConflictRow | undefined;
  return row ?? null;
}

export function markResolved(conflictId: string, choice: ResolveChoice): void {
  db.prepare(`UPDATE client_mutation_conflicts SET resolved_at = CURRENT_TIMESTAMP, resolved_choice = ? WHERE id = ?`).run(choice, conflictId);
}

function safeJsonParse(s: string): unknown {
  try { return JSON.parse(s); } catch { return null; }
}
