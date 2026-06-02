// [460-fork] Milestone 6 slice 1 — per-day journal text.
//
// One row per day in `day_journals`. Free-form markdown content; the client
// keeps it as the source of truth (portable, diffable, exports cleanly per
// CLAUDE.md §6). Conflict precondition mirrors the day-edit pattern from
// M5 slice 4: callers pass the previously-observed updated_at as
// If-Unmodified-Since, the route compares to the current value and parks
// mismatches as conflicts via the existing parkAsConflict helper.
import { db, canAccessTrip } from '../db/database';

export interface DayJournal {
  day_id: number;
  trip_id: number;
  content_markdown: string;
  updated_at: string;
  updated_by: number | null;
}

export function verifyTripAccess(tripId: string | number, userId: number) {
  return canAccessTrip(tripId, userId);
}

/** Returns the day if it belongs to the trip OR a segment the trip is linked
 *  to (mirrors getAccessibleDay in dayService — keeps shared-segment journals
 *  editable by every linked-trip member). */
export function dayAccessible(dayId: string | number, tripId: string | number) {
  return db.prepare(`
    SELECT d.id
      FROM days d
     WHERE d.id = ?
       AND (
         d.trip_id = ?
         OR d.segment_id IN (SELECT segment_id FROM trip_segments WHERE trip_id = ?)
       )
  `).get(dayId, tripId, tripId);
}

// [460-fork] M13 slice 4 — journals are per (day, trip): each linked trip keeps
// its own journal on a shared-segment day.
export function getJournal(dayId: number, tripId: number): DayJournal | null {
  const row = db.prepare('SELECT * FROM day_journals WHERE day_id = ? AND trip_id = ?').get(dayId, tripId) as DayJournal | undefined;
  return row ?? null;
}

/** Insert or replace the journal row for a day. Bumps updated_at to
 *  CURRENT_TIMESTAMP so the conflict precondition currency moves forward
 *  on every successful write. */
export function upsertJournal(dayId: number, tripId: number, contentMarkdown: string, updatedBy: number): DayJournal {
  db.prepare(`
    INSERT INTO day_journals (day_id, trip_id, content_markdown, updated_at, updated_by)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP, ?)
    ON CONFLICT(day_id, trip_id) DO UPDATE SET
      content_markdown = excluded.content_markdown,
      updated_at = CURRENT_TIMESTAMP,
      updated_by = excluded.updated_by
  `).run(dayId, tripId, contentMarkdown, updatedBy);
  return getJournal(dayId, tripId)!;
}
