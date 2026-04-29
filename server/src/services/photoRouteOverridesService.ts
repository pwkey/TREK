// [460-fork] M6 follow-up — per-segment photo-route waypoint overrides.
//
// One row per overridden segment; absence of a row means "use OSRM
// default for this leg". The waypoints column is JSON: an ordered list
// of `[lat, lng]` pairs that get spliced between the from-photo and
// to-photo waypoints when calculating the snapped route.
//
// FK cascades on day_photos delete drop the row automatically.
import { db, canAccessTrip } from '../db/database';

export interface PhotoRouteOverride {
  trip_id: number;
  from_photo_id: number;
  to_photo_id: number;
  /** Parsed waypoints as `[lat, lng]` pairs in route order. */
  waypoints: [number, number][];
  updated_at: string;
}

interface OverrideRow {
  trip_id: number;
  from_photo_id: number;
  to_photo_id: number;
  waypoints_json: string;
  updated_at: string;
}

export function verifyTripAccess(tripId: string | number, userId: number) {
  return canAccessTrip(tripId, userId);
}

/** Confirms both photos belong to days in the given trip (or in a
 *  segment linked to the trip — same accessibility rule used by
 *  journals + dayPhotos). Guards against cross-trip overrides. */
export function photosBelongToTrip(tripId: string | number, fromPhotoId: number, toPhotoId: number): boolean {
  const row = db.prepare(`
    SELECT COUNT(*) AS cnt
      FROM day_photos dp
      JOIN days d ON d.id = dp.day_id
     WHERE dp.id IN (?, ?)
       AND (d.trip_id = ?
            OR d.segment_id IN (SELECT segment_id FROM trip_segments WHERE trip_id = ?))
  `).get(fromPhotoId, toPhotoId, tripId, tripId) as { cnt: number };
  return row.cnt === 2;
}

export function listOverrides(tripId: number): PhotoRouteOverride[] {
  const rows = db.prepare(`
    SELECT trip_id, from_photo_id, to_photo_id, waypoints_json, updated_at
      FROM photo_route_overrides
     WHERE trip_id = ?
  `).all(tripId) as OverrideRow[];
  return rows.map(parseRow);
}

export function upsertOverride(
  tripId: number,
  fromPhotoId: number,
  toPhotoId: number,
  waypoints: [number, number][],
  userId: number,
): PhotoRouteOverride {
  const json = JSON.stringify(waypoints);
  db.prepare(`
    INSERT INTO photo_route_overrides
      (trip_id, from_photo_id, to_photo_id, waypoints_json, updated_at, updated_by)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, ?)
    ON CONFLICT(trip_id, from_photo_id, to_photo_id) DO UPDATE SET
      waypoints_json = excluded.waypoints_json,
      updated_at = CURRENT_TIMESTAMP,
      updated_by = excluded.updated_by
  `).run(tripId, fromPhotoId, toPhotoId, json, userId);

  const row = db.prepare(`
    SELECT trip_id, from_photo_id, to_photo_id, waypoints_json, updated_at
      FROM photo_route_overrides
     WHERE trip_id = ? AND from_photo_id = ? AND to_photo_id = ?
  `).get(tripId, fromPhotoId, toPhotoId) as OverrideRow;
  return parseRow(row);
}

export function deleteOverride(tripId: number, fromPhotoId: number, toPhotoId: number): boolean {
  const result = db.prepare(`
    DELETE FROM photo_route_overrides
     WHERE trip_id = ? AND from_photo_id = ? AND to_photo_id = ?
  `).run(tripId, fromPhotoId, toPhotoId);
  return result.changes > 0;
}

function parseRow(row: OverrideRow): PhotoRouteOverride {
  let waypoints: [number, number][] = [];
  try {
    const parsed = JSON.parse(row.waypoints_json);
    if (Array.isArray(parsed)) waypoints = parsed.filter(isLatLngPair);
  } catch {
    // Malformed row — log and treat as empty so the route falls back to
    // the OSRM default rather than crashing the GET.
    console.error('[photoRouteOverridesService] malformed waypoints_json:', row.waypoints_json);
  }
  return {
    trip_id: row.trip_id,
    from_photo_id: row.from_photo_id,
    to_photo_id: row.to_photo_id,
    waypoints,
    updated_at: row.updated_at,
  };
}

function isLatLngPair(v: unknown): v is [number, number] {
  return Array.isArray(v) && v.length === 2
    && typeof v[0] === 'number' && Number.isFinite(v[0]) && v[0] >= -90 && v[0] <= 90
    && typeof v[1] === 'number' && Number.isFinite(v[1]) && v[1] >= -180 && v[1] <= 180;
}

/** Validation helper exposed for the route handler. */
export function validateWaypoints(input: unknown): { ok: true; waypoints: [number, number][] } | { ok: false; error: string } {
  if (!Array.isArray(input)) return { ok: false, error: 'waypoints must be an array' };
  if (input.length > 50) return { ok: false, error: 'too many waypoints (max 50 per segment)' };
  const filtered: [number, number][] = [];
  for (const item of input) {
    if (!isLatLngPair(item)) return { ok: false, error: 'each waypoint must be [lat, lng] within valid bounds' };
    filtered.push(item);
  }
  return { ok: true, waypoints: filtered };
}
