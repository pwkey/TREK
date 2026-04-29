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
//                 INDEPENDENTLY. Snapped legs render solid green;
//                 legs OSRM can't route (e.g. flying to an island,
//                 ferry crossings) render dashed amber straight
//                 lines so a mostly-driving trip with one flight
//                 leg still shows the rest of the road network.
//
// Per-segment results are cached at module scope keyed by
// `${fromId}-${toId}` so flipping modes back and forth, or
// re-mounting the component, doesn't re-hit OSRM.
//
// Arrow markers always sit at *photo-to-photo* midpoints regardless
// of how curly the rendered geometry is — keeps the visual count
// aligned with the photo count.
import { useEffect, useMemo, useState } from 'react'
import { Polyline, Marker } from 'react-leaflet'
import L from 'leaflet'
import { calculateRoute } from './RouteCalculator'

export type PhotoRouteMode = 'off' | 'straight' | 'road'

export interface PhotoRoutePoint {
  id: number
  lat: number
  lng: number
  taken_at: string | null
}

export interface PhotoRouteSnapStatus {
  /** 'idle' = mode != 'road'; 'loading' = at least one segment in
   *  flight; 'ok' = every segment resolved (some may be non-road);
   *  'failed' = every segment failed to snap. */
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
}

const STRAIGHT_COLOR = '#f59e0b'  // amber — connotes "estimated / non-road"
const ROAD_COLOR = '#16a34a'      // green — connotes "real road"
const SNAP_CONCURRENCY = 3

// Module-level cache: persists across mounts during a session so
// toggling the toolbar doesn't re-hit OSRM. Keyed by ordered photo
// IDs (a→b is a different segment from b→a, but in practice the
// chronological sort fixes the order).
type CacheEntry =
  | { state: 'snapped'; coords: [number, number][] }
  | { state: 'no-route' }
const segmentCache = new Map<string, CacheEntry>()
const segmentKey = (a: PhotoRoutePoint, b: PhotoRoutePoint) => `${a.id}-${b.id}`

export function PhotoRouteLayer({ photos, mode, onRoadSnapStatus }: PhotoRouteLayerProps) {
  const ordered = useMemo<PhotoRoutePoint[]>(() => {
    return photos
      .filter(p => p.taken_at && !Number.isNaN(Date.parse(p.taken_at)))
      .slice()
      .sort((a, b) => Date.parse(a.taken_at as string) - Date.parse(b.taken_at as string))
  }, [photos])

  // Per-segment result, indexed by segment number (0 = ordered[0]→[1]).
  // null  = OSRM said no route (render straight as fallback)
  // undefined = pending (also renders straight as a placeholder)
  // [..] = snapped road geometry
  type SegResult = [number, number][] | null | undefined
  const [segments, setSegments] = useState<SegResult[]>([])

  const cacheKey = useMemo(() => ordered.map(p => p.id).join(','), [ordered])

  useEffect(() => {
    if (mode !== 'road' || ordered.length < 2) {
      setSegments([])
      onRoadSnapStatus?.({ state: 'idle', total: 0, snapped: 0, nonRoad: 0 })
      return
    }

    const total = ordered.length - 1

    // Seed from cache so already-resolved segments show up instantly.
    const initial: SegResult[] = []
    for (let i = 0; i < total; i++) {
      const cached = segmentCache.get(segmentKey(ordered[i], ordered[i + 1]))
      if (cached?.state === 'snapped') initial.push(cached.coords)
      else if (cached?.state === 'no-route') initial.push(null)
      else initial.push(undefined)
    }
    setSegments(initial)

    const allResolved = initial.every(r => r !== undefined)
    if (allResolved) {
      emitStatus(initial)
      return
    }

    const ctrl = new AbortController()
    onRoadSnapStatus?.({
      state: 'loading',
      total,
      snapped: initial.filter(r => Array.isArray(r)).length,
      nonRoad: initial.filter(r => r === null).length,
    })

    runSnapPool(ordered, initial, ctrl.signal, (idx, result) => {
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

  const polylines = ordered.slice(0, -1).map((from, i) => {
    const to = ordered[i + 1]
    const segResult = mode === 'road' ? segments[i] : undefined
    const snapped = Array.isArray(segResult)
    const positions: [number, number][] = snapped
      ? (segResult as [number, number][])
      : [[from.lat, from.lng], [to.lat, to.lng]]
    const color = snapped ? ROAD_COLOR : STRAIGHT_COLOR
    const dashArray = snapped ? undefined : '8, 6'
    return (
      <Polyline
        key={`seg-${from.id}-${to.id}-${snapped ? 'r' : 's'}`}
        positions={positions}
        color={color}
        weight={3}
        opacity={0.78}
        dashArray={dashArray}
      />
    )
  })

  // Arrows: one per segment, positioned at the photo-to-photo
  // midpoint (NOT the road-geometry midpoint) so each arrow
  // unambiguously corresponds to one photo→next-photo step.
  const arrows = ordered.slice(0, -1).map((from, i) => {
    const to = ordered[i + 1]
    const segResult = mode === 'road' ? segments[i] : undefined
    const snapped = Array.isArray(segResult)
    const mid: [number, number] = [(from.lat + to.lat) / 2, (from.lng + to.lng) / 2]
    const dx = to.lng - from.lng
    const dy = -(to.lat - from.lat)
    const rotation = (Math.atan2(dy, dx) * 180) / Math.PI
    const color = snapped ? ROAD_COLOR : STRAIGHT_COLOR
    return (
      <Marker
        key={`arr-${from.id}-${to.id}`}
        position={mid}
        icon={makeArrowIcon(rotation, color)}
        interactive={false}
      />
    )
  })

  return <>{polylines}{arrows}</>
}

/** Bounded worker pool that walks every consecutive pair, snapping
 *  each via OSRM. Skips pairs whose result is already in the seeded
 *  initial array (cache hit) so we only call OSRM for unknowns. */
async function runSnapPool(
  ordered: PhotoRoutePoint[],
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
      const key = segmentKey(from, to)
      try {
        const r = await calculateRoute(
          [{ lat: from.lat, lng: from.lng }, { lat: to.lat, lng: to.lng }],
          'driving',
          { signal },
        )
        if (signal.aborted) return
        segmentCache.set(key, { state: 'snapped', coords: r.coordinates })
        onResolved(idx, r.coordinates)
      } catch (err: unknown) {
        if ((err as { name?: string })?.name === 'AbortError') return
        // OSRM said no route — cache the negative answer so we don't
        // retry on every mode flip. Render as straight-line fallback.
        segmentCache.set(key, { state: 'no-route' })
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
