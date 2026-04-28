// [460-fork] Milestone 6 polish — compact per-day map of geotagged photos.
//
// Rendered inside each Memoir DayCard when the day has ≥1 photo with
// EXIF GPS. Markers cluster geographically, auto-fit-bounds zooms to
// show all of them. Clicking a marker dispatches the same lightbox
// flow as clicking the thumbnail.
import { useEffect, useMemo } from 'react'
import { MapContainer, TileLayer, Marker, useMap, Tooltip } from 'react-leaflet'
import L from 'leaflet'
import type { DayPhoto } from '../../store/slices/dayPhotosSlice'

interface DayPhotoMapProps {
  photos: DayPhoto[]
  onMarkerClick: (idx: number) => void
}

/** Small dot marker — keeps the mini-map readable when several photos
 *  pile up at the same location (e.g. multiple shots at one viewpoint). */
const dotIcon = L.divIcon({
  className: '',
  html: '<div style="width:14px;height:14px;border-radius:50%;background:#ef4444;border:2px solid white;box-shadow:0 1px 3px rgba(0,0,0,0.4);"></div>',
  iconSize: [14, 14],
  iconAnchor: [7, 7],
})

/** Helper child that uses useMap to call fitBounds once on mount and
 *  whenever the photo set changes. Without this the map opens at world
 *  zoom and the user has to manually pan to find the markers. */
function FitBounds({ photos }: { photos: DayPhoto[] }) {
  const map = useMap()
  useEffect(() => {
    const pts = photos
      .filter(p => p.lat !== null && p.lng !== null)
      .map(p => [p.lat as number, p.lng as number] as [number, number])
    if (pts.length === 0) return
    if (pts.length === 1) {
      map.setView(pts[0], 15)
    } else {
      map.fitBounds(pts, { padding: [20, 20], maxZoom: 16 })
    }
  }, [photos, map])
  return null
}

export default function DayPhotoMap({ photos, onMarkerClick }: DayPhotoMapProps) {
  const geotagged = useMemo(
    () => photos
      .map((p, originalIdx) => ({ photo: p, originalIdx }))
      .filter(({ photo }) => photo.lat !== null && photo.lng !== null),
    [photos],
  )

  if (geotagged.length === 0) return null

  return (
    <div style={{ height: 200, borderRadius: 8, overflow: 'hidden', border: '1px solid var(--border-faint)' }}>
      <MapContainer
        center={[geotagged[0].photo.lat as number, geotagged[0].photo.lng as number]}
        zoom={13}
        zoomControl={true}
        style={{ height: '100%', width: '100%', background: '#e5e7eb' }}
        // Scroll-wheel zoom off so scrolling the memoir doesn't trap the
        // page on the map. Drag + zoom controls still work.
        scrollWheelZoom={false}
      >
        <TileLayer
          url='https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png'
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>'
          maxZoom={19}
        />
        <FitBounds photos={photos} />
        {geotagged.map(({ photo, originalIdx }) => (
          <Marker
            key={photo.id}
            position={[photo.lat as number, photo.lng as number]}
            icon={dotIcon}
            eventHandlers={{ click: () => onMarkerClick(originalIdx) }}
          >
            <Tooltip direction="top" offset={[0, -8]} opacity={0.95}>
              {photo.caption || photo.original_name}
            </Tooltip>
          </Marker>
        ))}
      </MapContainer>
    </div>
  )
}
