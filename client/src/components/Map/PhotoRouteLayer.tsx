// [460-fork] M6 follow-up — chronological photo route overlay.
//
// Sorts geotagged photos by `taken_at` and draws a polyline through
// them in capture order, with a small arrow at each segment midpoint
// to indicate direction of travel. Three modes:
//
//   - 'off':      layer hidden.
//
//   - 'straight': every segment is a dashed amber straight line.
//                 Useful for journeys where roads aren't relevant
//                 (boats, hikes, flights).
//
//   - 'road':     each segment is snapped to roads via OSRM
//                 INDEPENDENTLY, optionally THROUGH user-supplied
//                 waypoints. Snapped legs render solid green; legs
//                 OSRM can't route render dashed amber straight
//                 lines (e.g. flights, ferries, ocean crossings).
//
// Waypoint editing (Road mode only):
//   - Right-click on a leg → "Add waypoint here" at the click point.
//     The leg re-snaps via OSRM through the new waypoint.
//   - Each existing waypoint is a draggable dot — drag to refine
//     position; drop fires a re-save and re-snap.
//   - Right-click on a waypoint → remove it from the leg. If that
//     was the last waypoint, the override is cleared entirely (back
//     to OSRM default).
//
// Per-segment results are cached at module scope keyed by photo IDs
// PLUS a waypoint-position hash, so different waypoint configs each
// get their own cache slot and toggling back doesn't re-hit OSRM.
//
// Arrow markers always sit at *photo-to-photo* midpoints regardless
// of how curly the rendered geometry is — keeps the visual count
// aligned with the photo count.
import { useEffect, useMemo, useState } from 'react'
import { Polyline, Marker, Tooltip } from 'react-leaflet'
import L from 'leaflet'
import { calculateRoute } from './RouteCalculator'

export type PhotoRouteMode = 'off' | 'straight' | 'road'

export interface PhotoRoutePoint {
  id: number
  lat: number
  lng: number
  taken_at: string | null
  /** Used by the segment-click handler to open the day-detail panel
   *  for whichever photo a route leg starts from. Optional so
   *  consumers without a click handler don't need to thread it. */
  day_id?: number
}

export interface PhotoRouteSnapStatus {
  state: 'idle' | 'loading' | 'ok' | 'failed'
  total: number
  snapped: number
  /** Count of legs OSRM could not route — rendered as dashed
   *  straight lines. The toolbar surfaces this when > 0. */
  nonRoad: number
}

interface PhotoRouteLayerProps {
  photos: PhotoRoutePoint[]
  mode: PhotoRouteMode
  onRoadSnapStatus?: (status: PhotoRouteSnapStatus) => void
  onSegmentClick?: (from: PhotoRoutePoint, to: PhotoRoutePoint) => void
  /** Waypoint overrides keyed by `${fromPhotoId}-${toPhotoId}`.
   *  Each value is an ordered list of `[lat, lng]` pairs that get
   *  spliced between the two photos when fetching the snapped leg. */
  overrides?: Record<string, [number, number][]>
  /** Called when the user drags an existing waypoint OR adds one via
   *  right-click. Receives the FULL new waypoints list for that leg
   *  (not a delta) — caller upserts to the server. */
  onSetOverride?: (fromId: number, toId: number, waypoints: [number, number][]) => void
  /** Called when the last waypoint on a leg is removed (right-click).
   *  Caller deletes the row server-side; the leg falls back to OSRM
   *  default. */
  onClearOverride?: (fromId: number, toId: number) => void
}

const STRAIGHT_COLOR = '#f59e0b'  // amber — connotes "estimated / non-road"
const ROAD_COLOR = '#16a34a'      // green — connotes "real road"
const SNAP_CONCURRENCY = 3

// Module-level cache keyed by photo IDs PLUS a waypoint hash so each
// distinct waypoint configuration gets its own cache slot. Persists
// across mounts during a session.
type CacheEntry =
  | { state: 'snapped'; coords: [number, number][] }
  | { state: 'no-route' }
const segmentCache = new Map<string, CacheEntry>()

function hashWaypoints(wp: [number, number][]): string {
  if (wp.length === 0) return ''
  // 5 decimal places ≈ 1.1m precision — enough to distinguish drags
  // without churning the cache on sub-pixel mouse jitter.
  return wp.map(([la, ln]) => `${la.toFixed(5)},${ln.toFixed(5)}`).join(';')
}

function segmentCacheKey(a: PhotoRoutePoint, b: PhotoRoutePoint, waypoints: [number, number][]): string {
  const wp = hashWaypoints(waypoints)
  return wp ? `${a.id}-${b.id}|${wp}` : `${a.id}-${b.id}`
}

const overrideKey = (fromId: number, toId: number) => `${fromId}-${toId}`

export function PhotoRouteLayer({
  photos, mode, onRoadSnapStatus, onSegmentClick,
  overrides = {}, onSetOverride, onClearOverride,
}: PhotoRouteLayerProps) {
  const ordered = useMemo<PhotoRoutePoint[]>(() => {
    return photos
      .filter(p => p.taken_at && !Number.isNaN(Date.parse(p.taken_at)))
      .slice()
      .sort((a, b) => Date.parse(a.taken_at as string) - Date.parse(b.taken_at as string))
  }, [photos])

  // Per-segment result. null = OSRM said no route (fallback to
  // straight). undefined = pending. [..] = snapped geometry.
  type SegResult = [number, number][] | null | undefined
  const [segments, setSegments] = useState<SegResult[]>([])

  // Cache key: includes the waypoint hash for every segment so the
  // effect re-runs when ANY override changes.
  const cacheKey = useMemo(() => {
    return ordered.map((p, i) => {
      if (i === 0) return String(p.id)
      const prev = ordered[i - 1]
      const wp = overrides[overrideKey(prev.id, p.id)] ?? []
      return `${p.id}|${hashWaypoints(wp)}`
    }).join(',')
  }, [ordered, overrides])

  useEffect(() => {
    if (mode !== 'road' || ordered.length < 2) {
      setSegments([])
      onRoadSnapStatus?.({ state: 'idle', total: 0, snapped: 0, nonRoad: 0 })
      return
    }

    const total = ordered.length - 1
    const initial: SegResult[] = []
    for (let i = 0; i < total; i++) {
      const from = ordered[i]
      const to = ordered[i + 1]
      const wp = overrides[overrideKey(from.id, to.id)] ?? []
      const cached = segmentCache.get(segmentCacheKey(from, to, wp))
      if (cached?.state === 'snapped') initial.push(cached.coords)
      else if (cached?.state === 'no-route') initial.push(null)
      else initial.push(undefined)
    }
    setSegments(initial)

    const allResolved = initial.every(r => r !== undefined)
    if (allResolved) { emitStatus(initial); return }

    const ctrl = new AbortController()
    onRoadSnapStatus?.({
      state: 'loading',
      total,
      snapped: initial.filter(r => Array.isArray(r)).length,
      nonRoad: initial.filter(r => r === null).length,
    })

    runSnapPool(ordered, overrides, initial, ctrl.signal, (idx, result) => {
      setSegments(prev => {
        if (prev.length !== total) return prev
        const next = prev.slice()
        next[idx] = result
        if (next.every(r => r !== undefined)) emitStatus(next)
        return next
      })
    })

    return () => ctrl.abort()

    function emitStatus(arr: SegResult[]) {
      const snapped = arr.filter(r => Array.isArray(r)).length
      const nonRoad = arr.filter(r => r === null).length
      onRoadSnapStatus?.({
        state: snapped === 0 ? 'failed' : 'ok',
        total: arr.length,
        snapped,
        nonRoad,
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cacheKey, mode])

  if (mode === 'off' || ordered.length < 2) return null

  const editable = mode === 'road' && !!onSetOverride
  const polylines: React.ReactElement[] = []
  const arrows: React.ReactElement[] = []
  const waypointMarkers: React.ReactElement[] = []
  const overriddenBadges: React.ReactElement[] = []

  ordered.slice(0, -1).forEach((from, i) => {
    const to = ordered[i + 1]
    const segWaypoints = overrides[overrideKey(from.id, to.id)] ?? []
    const segResult = mode === 'road' ? segments[i] : undefined
    const snapped = Array.isArray(segResult)
    const positions: [number, number][] = snapped
      ? (segResult as [number, number][])
      : [[from.lat, from.lng], [to.lat, to.lng]]
    const color = snapped ? ROAD_COLOR : STRAIGHT_COLOR
    const dashArray = snapped ? undefined : '8, 6'

    const handlers: Record<string, (e: L.LeafletMouseEvent) => void> = {}
    if (onSegmentClick) handlers.click = () => onSegmentClick(from, to)
    if (editable) {
      handlers.contextmenu = (e: L.LeafletMouseEvent) => {
        // Insert the new waypoint at the position whose nearest
        // existing-waypoint is closest — simplest stable insertion
        // rule. With no existing waypoints, append.
        const click: [number, number] = [e.latlng.lat, e.latlng.lng]
        const next = insertWaypoint(segWaypoints, click, [from.lat, from.lng], [to.lat, to.lng])
        onSetOverride?.(from.id, to.id, next)
        ;(L.DomEvent as any).preventDefault?.(e.originalEvent)
      }
    }

    polylines.push(
      <Polyline
        key={`seg-${from.id}-${to.id}-${snapped ? 'r' : 's'}-${segWaypoints.length}`}
        positions={positions}
        color={color}
        weight={3}
        opacity={0.78}
        dashArray={dashArray}
        interactive={!!onSegmentClick || editable}
        eventHandlers={Object.keys(handlers).length ? handlers : undefined}
      />,
    )

    const mid: [number, number] = [(from.lat + to.lat) / 2, (from.lng + to.lng) / 2]
    const dx = to.lng - from.lng
    const dy = -(to.lat - from.lat)
    const rotation = (Math.atan2(dy, dx) * 180) / Math.PI
    arrows.push(
      <Marker
        key={`arr-${from.id}-${to.id}`}
        position={mid}
        icon={makeArrowIcon(rotation, color)}
        interactive={false}
      />,
    )

    if (segWaypoints.length > 0) {
      // ✏️ badge sits slightly offset from the photo-to-photo midpoint
      // so it doesn't overlap the directional arrow. Tooltip explains.
      overriddenBadges.push(
        <Marker
          key={`edit-${from.id}-${to.id}`}
          position={mid}
          icon={makeOverrideBadgeIcon()}
          interactive={false}
        />,
      )
      segWaypoints.forEach((wp, wpIdx) => {
        waypointMarkers.push(
          <Marker
            key={`wp-${from.id}-${to.id}-${wpIdx}`}
            position={wp}
            icon={makeWaypointIcon()}
            draggable={editable}
            eventHandlers={editable ? {
              dragend: (e: L.LeafletEvent) => {
                const ll = (e.target as L.Marker).getLatLng()
                const next = segWaypoints.slice()
                next[wpIdx] = [ll.lat, ll.lng]
                onSetOverride?.(from.id, to.id, next)
              },
              contextmenu: (e: L.LeafletMouseEvent) => {
                const next = segWaypoints.slice()
                next.splice(wpIdx, 1)
                if (next.length === 0) onClearOverride?.(from.id, to.id)
                else onSetOverride?.(from.id, to.id, next)
                ;(L.DomEvent as any).preventDefault?.(e.originalEvent)
              },
            } : undefined}
          >
            <Tooltip direction="top" offset={[0, -8]} opacity={0.9}>
              {editable ? 'Drag to move · right-click to remove' : 'Custom waypoint'}
            </Tooltip>
          </Marker>,
        )
      })
    }
  })

  return <>{polylines}{arrows}{waypointMarkers}{overriddenBadges}</>
}

/** Insert a new waypoint into an existing list. Picks the insertion
 *  index that puts the new point closest to the segment endpoint
 *  before/after it. With zero waypoints we just append. */
function insertWaypoint(
  current: [number, number][],
  newWp: [number, number],
  from: [number, number],
  to: [number, number],
): [number, number][] {
  if (current.length === 0) return [newWp]
  // Build the candidate sequence boundaries: from → wp[0] → wp[1] → ... → to
  const points: [number, number][] = [from, ...current, to]
  let bestIdx = 0
  let bestDist = Infinity
  for (let i = 0; i < points.length - 1; i++) {
    const d = pointToSegmentDistance(newWp, points[i], points[i + 1])
    if (d < bestDist) { bestDist = d; bestIdx = i }
  }
  // bestIdx is the segment AFTER which to insert: equivalent to
  // splicing at index bestIdx into `current`.
  const next = current.slice()
  next.splice(bestIdx, 0, newWp)
  return next
}

/** Squared distance from p to the segment a-b — cheap proxy for the
 *  "which segment is the new waypoint closest to" insertion choice.
 *  Treats lat/lng as planar (fine for this geometric heuristic). */
function pointToSegmentDistance(p: [number, number], a: [number, number], b: [number, number]): number {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  if (dx === 0 && dy === 0) {
    const d0 = p[0] - a[0]
    const d1 = p[1] - a[1]
    return d0 * d0 + d1 * d1
  }
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy)))
  const px = a[0] + t * dx
  const py = a[1] + t * dy
  const ddx = p[0] - px
  const ddy = p[1] - py
  return ddx * ddx + ddy * ddy
}

async function runSnapPool(
  ordered: PhotoRoutePoint[],
  overrides: Record<string, [number, number][]>,
  initial: ([number, number][] | null | undefined)[],
  signal: AbortSignal,
  onResolved: (idx: number, result: [number, number][] | null) => void,
): Promise<void> {
  const todo: number[] = []
  for (let i = 0; i < initial.length; i++) {
    if (initial[i] === undefined) todo.push(i)
  }
  let next = 0
  const worker = async () => {
    while (next < todo.length) {
      if (signal.aborted) return
      const idx = todo[next++]
      const from = ordered[idx]
      const to = ordered[idx + 1]
      const wp = overrides[overrideKey(from.id, to.id)] ?? []
      const cacheK = segmentCacheKey(from, to, wp)
      try {
        const r = await calculateRoute(
          [
            { lat: from.lat, lng: from.lng },
            ...wp.map(([lat, lng]) => ({ lat, lng })),
            { lat: to.lat, lng: to.lng },
          ],
          'driving',
          { signal },
        )
        if (signal.aborted) return
        segmentCache.set(cacheK, { state: 'snapped', coords: r.coordinates })
        onResolved(idx, r.coordinates)
      } catch (err: unknown) {
        if ((err as { name?: string })?.name === 'AbortError') return
        segmentCache.set(cacheK, { state: 'no-route' })
        onResolved(idx, null)
      }
    }
  }
  await Promise.all(Array.from({ length: SNAP_CONCURRENCY }, worker))
}

function makeArrowIcon(rotation: number, color: string) {
  return L.divIcon({
    className: '',
    html: `<div style="
      transform: rotate(${rotation}deg);
      color: ${color};
      font-size: 16px;
      line-height: 1;
      font-weight: 900;
      text-shadow: 0 0 3px white, 0 0 3px white;
      user-select: none;
    ">▶</div>`,
    iconSize: [16, 16],
    iconAnchor: [8, 8],
  })
}

function makeWaypointIcon() {
  return L.divIcon({
    className: '',
    html: `<div style="
      width: 12px; height: 12px; border-radius: 50%;
      background: ${ROAD_COLOR};
      border: 2px solid white;
      box-shadow: 0 1px 4px rgba(0,0,0,0.35);
      cursor: grab;
    "></div>`,
    iconSize: [12, 12],
    iconAnchor: [6, 6],
  })
}

function makeOverrideBadgeIcon() {
  return L.divIcon({
    className: '',
    html: `<div title="Custom route via waypoints" style="
      transform: translate(10px, -10px);
      font-size: 12px;
      line-height: 1;
      filter: drop-shadow(0 0 2px white) drop-shadow(0 0 2px white);
      user-select: none;
    ">✏️</div>`,
    iconSize: [16, 16],
    iconAnchor: [8, 8],
  })
}
