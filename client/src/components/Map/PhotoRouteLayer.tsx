// [460-fork] M6 follow-up — chronological photo route overlay.
//
// Sorts geotagged photos by `taken_at` and draws a polyline through
// them in capture order, with a small arrow at each segment midpoint
// to indicate direction of travel. Two modes:
//
//   - 'straight': polyline goes in straight lines from photo to
//     photo. Useful for non-road journeys (boats, hikes, flights),
//     and is also the immediate fallback while a road-snap request
//     is in flight or has failed.
//
//   - 'road': asks OSRM for a road-snapped route through every photo
//     and renders that geometry instead. Falls back to straight if
//     OSRM has no answer (e.g. waypoints in the ocean) — the
//     parent's `onRoadSnapStatus` callback fires so the toolbar can
//     surface a "couldn't snap" hint.
//
// Either way, arrow markers sit at the *photo-to-photo* midpoints
// (not at road-segment midpoints), so the visual ordering matches
// the photo timeline regardless of how curly the road geometry is.
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

interface PhotoRouteLayerProps {
  photos: PhotoRoutePoint[]
  mode: PhotoRouteMode
  /** Notifies the parent when the road-snap call finishes — so a
   *  toolbar can render "loading…", "snapped", or "fell back to
   *  straight" hints without having to re-derive that state. */
  onRoadSnapStatus?: (status: 'idle' | 'loading' | 'ok' | 'failed') => void
}

const STRAIGHT_COLOR = '#f59e0b'  // amber — connotes "estimated"
const ROAD_COLOR = '#16a34a'      // green — connotes "real"

export function PhotoRouteLayer({ photos, mode, onRoadSnapStatus }: PhotoRouteLayerProps) {
  const ordered = useMemo<PhotoRoutePoint[]>(() => {
    return photos
      .filter(p => p.taken_at && !Number.isNaN(Date.parse(p.taken_at)))
      .slice()
      .sort((a, b) => Date.parse(a.taken_at as string) - Date.parse(b.taken_at as string))
  }, [photos])

  const straightPath = useMemo<[number, number][]>(
    () => ordered.map(p => [p.lat, p.lng]),
    [ordered],
  )

  // Road-snapped geometry, keyed by photo IDs in order. Re-fetched
  // whenever the ordered set changes OR the mode flips to 'road'.
  const cacheKey = useMemo(() => ordered.map(p => p.id).join(','), [ordered])
  const [roadPath, setRoadPath] = useState<[number, number][] | null>(null)

  useEffect(() => {
    if (mode !== 'road' || ordered.length < 2) {
      setRoadPath(null)
      onRoadSnapStatus?.('idle')
      return
    }
    const ctrl = new AbortController()
    setRoadPath(null)
    onRoadSnapStatus?.('loading')
    calculateRoute(
      ordered.map(p => ({ lat: p.lat, lng: p.lng })),
      'driving',
      { signal: ctrl.signal },
    )
      .then(r => {
        setRoadPath(r.coordinates)
        onRoadSnapStatus?.('ok')
      })
      .catch(err => {
        if (err?.name === 'AbortError') return
        setRoadPath(null)
        onRoadSnapStatus?.('failed')
      })
    return () => ctrl.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cacheKey, mode])

  if (mode === 'off' || ordered.length < 2) return null

  const usingRoad = mode === 'road' && roadPath !== null
  const path = usingRoad ? (roadPath as [number, number][]) : straightPath
  const color = usingRoad ? ROAD_COLOR : STRAIGHT_COLOR
  // Dashed for straight (estimated), solid for road (real).
  const dashArray = usingRoad ? undefined : '8, 6'

  // Arrows always live at photo-to-photo midpoints regardless of how
  // curly the rendered geometry is — keeps the visual count aligned
  // with the photo count.
  const arrows = straightPath.slice(0, -1).map((from, i) => {
    const to = straightPath[i + 1]
    const mid: [number, number] = [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2]
    // Screen-space rotation: y-axis is inverted on screen vs lat.
    const dx = to[1] - from[1]
    const dy = -(to[0] - from[0])
    const rotation = (Math.atan2(dy, dx) * 180) / Math.PI
    return { mid, rotation, key: `${ordered[i].id}-${ordered[i + 1].id}` }
  })

  return (
    <>
      <Polyline positions={path} color={color} weight={3} opacity={0.75} dashArray={dashArray} />
      {arrows.map(a => (
        <Marker
          key={a.key}
          position={a.mid}
          icon={makeArrowIcon(a.rotation, color)}
          interactive={false}
        />
      ))}
    </>
  )
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
