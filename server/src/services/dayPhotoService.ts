// [460-fork] Milestone 6 slice 2 — per-day photo association service.
//
// The actual file bytes live in trip_files (reused upload infrastructure);
// this service manages the day-side join table day_photos plus a few
// joined-row formatters so the route layer doesn't have to know SQL.
import { db, canAccessTrip } from '../db/database';

export interface DayPhotoRow {
  id: number;
  day_id: number;
  upload_id: number;
  caption: string | null;
  taken_at: string | null;
  lat: number | null;
  lng: number | null;
  altitude: number | null;
  camera: string | null;
  position: number;
  created_at: string;
}

/** What the API returns: a day_photos row hydrated with the underlying
 *  trip_files columns clients need to render thumbnails. */
export interface DayPhoto extends DayPhotoRow {
  filename: string;
  original_name: string;
  mime_type: string;
  file_size: number;
}

const PHOTO_SELECT = `
  SELECT
    dp.id, dp.day_id, dp.upload_id, dp.caption, dp.taken_at,
    dp.lat, dp.lng, dp.altitude, dp.camera,
    dp.position, dp.created_at,
    f.filename, f.original_name, f.mime_type, f.file_size
  FROM day_photos dp
  JOIN trip_files f ON f.id = dp.upload_id
`;

export function verifyTripAccess(tripId: string | number, userId: number) {
  return canAccessTrip(tripId, userId);
}

/** Day must belong to the trip OR a segment the trip is linked to. Mirrors
 *  the pattern used by journalService and dayService. */
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

export function listPhotos(dayId: number): DayPhoto[] {
  return db.prepare(`${PHOTO_SELECT} WHERE dp.day_id = ? ORDER BY dp.position ASC, dp.id ASC`).all(dayId) as DayPhoto[];
}

export function getPhoto(id: number): DayPhoto | null {
  const row = db.prepare(`${PHOTO_SELECT} WHERE dp.id = ?`).get(id) as DayPhoto | undefined;
  return row ?? null;
}

/** Append a new photo row to the END of the day's list. Caller must
 *  already have inserted the trip_files row and pass its upload_id. */
export function attachPhoto(input: {
  dayId: number;
  uploadId: number;
  caption?: string | null;
  takenAt?: string | null;
  lat?: number | null;
  lng?: number | null;
  altitude?: number | null;
  camera?: string | null;
}): DayPhoto {
  const max = db.prepare('SELECT COALESCE(MAX(position), -1) AS m FROM day_photos WHERE day_id = ?').get(input.dayId) as { m: number };
  const result = db.prepare(`
    INSERT INTO day_photos (day_id, upload_id, caption, taken_at, lat, lng, altitude, camera, position)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.dayId, input.uploadId,
    input.caption ?? null, input.takenAt ?? null,
    input.lat ?? null, input.lng ?? null,
    input.altitude ?? null, input.camera ?? null,
    max.m + 1,
  );
  return getPhoto(Number(result.lastInsertRowid))!;
}

export function updatePhoto(id: number, current: DayPhotoRow, fields: { caption?: string | null; position?: number; taken_at?: string | null }): DayPhoto {
  db.prepare(`
    UPDATE day_photos SET
      caption = ?,
      position = ?,
      taken_at = ?
    WHERE id = ?
  `).run(
    fields.caption !== undefined ? fields.caption : current.caption,
    fields.position !== undefined ? fields.position : current.position,
    fields.taken_at !== undefined ? fields.taken_at : current.taken_at,
    id,
  );
  return getPhoto(id)!;
}

/** Remove the day_photos row AND the underlying trip_files row (and disk
 *  file). Photos are 1-1 with their upload — there's no scenario today
 *  where the same trip_files row is used by another day_photos row, but
 *  if that ever changes this should switch to soft-delete. */
export function detachPhoto(photo: DayPhoto): { uploadFilename: string } {
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM day_photos WHERE id = ?').run(photo.id);
    db.prepare('DELETE FROM trip_files WHERE id = ?').run(photo.upload_id);
  });
  tx();
  return { uploadFilename: photo.filename };
}

/** Bulk re-set positions in one transaction. orderedIds are the day_photos
 *  ids in their new desired order. Ignores ids not currently in the day. */
export function reorderPhotos(dayId: number, orderedIds: number[]): DayPhoto[] {
  const tx = db.transaction((ids: number[]) => {
    const stmt = db.prepare('UPDATE day_photos SET position = ? WHERE id = ? AND day_id = ?');
    ids.forEach((id, idx) => stmt.run(idx, id, dayId));
  });
  tx(orderedIds);
  return listPhotos(dayId);
}
