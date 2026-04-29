// [460-fork] M6 follow-up — GPX track service.
//
// Parses uploaded .gpx files into a flat list of [lat, lng] pairs and
// stores them per-trip. Distinct from the existing `places.routegpx`
// import path (which creates Place rows with route_geometry); this
// table is purely for rendering recorded tracks alongside the photo
// route, with no place semantics.
import { XMLParser } from 'fast-xml-parser';
import { db, canAccessTrip } from '../db/database';

export interface GpxTrack {
  id: number;
  trip_id: number;
  name: string;
  points: [number, number][];
  point_count: number;
  distance_m: number;
  uploaded_by: number | null;
  uploaded_at: string;
}

interface GpxTrackRow {
  id: number;
  trip_id: number;
  name: string;
  points_json: string;
  point_count: number;
  distance_m: number;
  uploaded_by: number | null;
  uploaded_at: string;
}

const MAX_POINTS = 50_000;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  isArray: (name) => ['trk', 'trkseg', 'trkpt', 'rte', 'rtept'].includes(name),
});

export function verifyTripAccess(tripId: string | number, userId: number) {
  return canAccessTrip(tripId, userId);
}

/** Parse a GPX file's bytes into a flat polyline. Pulls trackpoints
 *  from <trk><trkseg><trkpt> first (most common — phones, watches,
 *  Strava), then falls back to <rte><rtept> (route plans). Returns
 *  `null` if neither yields any usable points. */
export function parseGpxBytes(buf: Buffer): { points: [number, number][]; trackName: string | null } | null {
  let parsed: any;
  try {
    parsed = parser.parse(buf.toString('utf-8'));
  } catch {
    return null;
  }
  const gpx = parsed?.gpx;
  if (!gpx) return null;

  const points: [number, number][] = [];
  let trackName: string | null = null;

  for (const trk of gpx.trk ?? []) {
    if (!trackName && trk.name) trackName = String(trk.name).trim() || null;
    for (const seg of trk.trkseg ?? []) {
      for (const pt of seg.trkpt ?? []) {
        const lat = Number(pt['@_lat']);
        const lng = Number(pt['@_lon']);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
        if (lat < -90 || lat > 90 || lng < -180 || lng > 180) continue;
        points.push([lat, lng]);
        if (points.length >= MAX_POINTS) break;
      }
      if (points.length >= MAX_POINTS) break;
    }
    if (points.length >= MAX_POINTS) break;
  }

  if (points.length === 0) {
    for (const rte of gpx.rte ?? []) {
      if (!trackName && rte.name) trackName = String(rte.name).trim() || null;
      for (const pt of rte.rtept ?? []) {
        const lat = Number(pt['@_lat']);
        const lng = Number(pt['@_lon']);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
        points.push([lat, lng]);
        if (points.length >= MAX_POINTS) break;
      }
      if (points.length >= MAX_POINTS) break;
    }
  }

  if (points.length === 0) return null;
  return { points, trackName };
}

/** Total distance along the polyline in metres, via haversine.
 *  Useful as a UI hint ("12.4 km") and for the rare track that
 *  amounts to a single jittery stationary point — distance ≈ 0
 *  signals "probably empty / debug capture". */
export function polylineDistanceMeters(points: [number, number][]): number {
  if (points.length < 2) return 0;
  const R = 6371000;
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const [lat1, lng1] = points[i - 1];
    const [lat2, lng2] = points[i];
    const φ1 = (lat1 * Math.PI) / 180;
    const φ2 = (lat2 * Math.PI) / 180;
    const Δφ = ((lat2 - lat1) * Math.PI) / 180;
    const Δλ = ((lng2 - lng1) * Math.PI) / 180;
    const a = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
    total += 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }
  return total;
}

export function listTracks(tripId: number): GpxTrack[] {
  const rows = db.prepare(`
    SELECT id, trip_id, name, points_json, point_count, distance_m, uploaded_by, uploaded_at
      FROM gpx_tracks
     WHERE trip_id = ?
     ORDER BY uploaded_at ASC
  `).all(tripId) as GpxTrackRow[];
  return rows.map(parseRow);
}

export function getTrack(id: number): GpxTrack | null {
  const row = db.prepare(`
    SELECT id, trip_id, name, points_json, point_count, distance_m, uploaded_by, uploaded_at
      FROM gpx_tracks
     WHERE id = ?
  `).get(id) as GpxTrackRow | undefined;
  return row ? parseRow(row) : null;
}

export function createTrack(
  tripId: number,
  name: string,
  points: [number, number][],
  uploadedBy: number,
): GpxTrack {
  const distance = polylineDistanceMeters(points);
  const json = JSON.stringify(points);
  const result = db.prepare(`
    INSERT INTO gpx_tracks (trip_id, name, points_json, point_count, distance_m, uploaded_by)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(tripId, name, json, points.length, distance, uploadedBy);
  return getTrack(Number(result.lastInsertRowid)) as GpxTrack;
}

export function renameTrack(tripId: number, id: number, name: string): GpxTrack | null {
  const result = db.prepare(`
    UPDATE gpx_tracks SET name = ? WHERE id = ? AND trip_id = ?
  `).run(name, id, tripId);
  if (result.changes === 0) return null;
  return getTrack(id);
}

export function deleteTrack(tripId: number, id: number): boolean {
  const result = db.prepare(`
    DELETE FROM gpx_tracks WHERE id = ? AND trip_id = ?
  `).run(id, tripId);
  return result.changes > 0;
}

function parseRow(row: GpxTrackRow): GpxTrack {
  let points: [number, number][] = [];
  try {
    const parsed = JSON.parse(row.points_json);
    if (Array.isArray(parsed)) {
      points = parsed.filter((p): p is [number, number] =>
        Array.isArray(p) && p.length === 2 &&
        typeof p[0] === 'number' && typeof p[1] === 'number',
      );
    }
  } catch {
    console.error('[gpxTracksService] malformed points_json for track', row.id);
  }
  return {
    id: row.id,
    trip_id: row.trip_id,
    name: row.name,
    points,
    point_count: row.point_count,
    distance_m: row.distance_m,
    uploaded_by: row.uploaded_by,
    uploaded_at: row.uploaded_at,
  };
}
