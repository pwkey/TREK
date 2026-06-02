// [460-fork] Milestone 13 — segment document-sharing service.
//
// Opt-in bridge over the otherwise-private reservation/file model: an owner
// explicitly shares one of their records into a segment, and every trip linked
// to that segment can then see it (read/write widening lands in slice 2). The
// default — nothing shared — stays fully private, so this only ever *adds*
// visibility on top of a safe baseline.
//
// Slice 1 is write-only: these helpers record and remove shares. No read path
// consults the junctions yet, so creating a share does not expose anything
// across households until slice 2 wires the widened reads + leak guards.
import { db } from '../db/database';

/**
 * True if `tripId` is one of the trips linked to `segmentId`. A trip may only
 * share a record into a segment it actually belongs to.
 */
export function isTripInSegment(tripId: string | number, segmentId: string): boolean {
  return !!db
    .prepare('SELECT 1 FROM trip_segments WHERE trip_id = ? AND segment_id = ?')
    .get(tripId, segmentId);
}

/**
 * Share a reservation into a segment. Idempotent: re-sharing the same
 * (segment, reservation) pair is a no-op thanks to the UNIQUE constraint.
 */
export function shareReservation(segmentId: string, reservationId: string | number, userId: number): void {
  db.prepare(
    'INSERT OR IGNORE INTO segment_shared_reservations (segment_id, reservation_id, shared_by) VALUES (?, ?, ?)'
  ).run(segmentId, reservationId, userId);
}

/** Remove a reservation share. No-op if it wasn't shared. */
export function unshareReservation(segmentId: string, reservationId: string | number): void {
  db.prepare(
    'DELETE FROM segment_shared_reservations WHERE segment_id = ? AND reservation_id = ?'
  ).run(segmentId, reservationId);
}

/**
 * Share a standalone file into a segment. Idempotent (UNIQUE on
 * (segment_id, file_id)).
 */
export function shareFile(segmentId: string, fileId: string | number, userId: number): void {
  db.prepare(
    'INSERT OR IGNORE INTO segment_shared_files (segment_id, file_id, shared_by) VALUES (?, ?, ?)'
  ).run(segmentId, fileId, userId);
}

/** Remove a file share. No-op if it wasn't shared. */
export function unshareFile(segmentId: string, fileId: string | number): void {
  db.prepare(
    'DELETE FROM segment_shared_files WHERE segment_id = ? AND file_id = ?'
  ).run(segmentId, fileId);
}
