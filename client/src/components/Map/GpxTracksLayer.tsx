// [460-fork] M6 follow-up — uploaded GPS tracks rendered as map polylines.
//
// Each track is a separate polyline drawn in purple to distinguish from:
//   - the photo route (green road / amber straight)
//   - existing place routes (whatever colour the GPX-imported places use)
//
// Tracks are read-only on the map; the GpxTracksControl handles
// upload / rename / delete. Visibility is per-device (localStorage)
// and the parent passes only the visible subset here.
import { Polyline, Tooltip } from 'react-leaflet'
import type { GpxTrack } from '../../store/slices/gpxTracksSlice'

const TRACK_COLOR = '#7c3aed'  // violet — distinct from green/amber

interface GpxTracksLayerProps {
  tracks: GpxTrack[]
}

export function GpxTracksLayer({ tracks }: GpxTracksLayerProps) {
  if (tracks.length === 0) return null
  return (
    <>
      {tracks.map(t => (
        t.points.length < 2 ? null : (
          <Polyline
            key={`gpx-${t.id}`}
            positions={t.points}
            color={TRACK_COLOR}
            weight={3}
            opacity={0.85}
            // Don't claim pointer events — keeps photo-route clicks /
            // map context-menu working through the track polyline.
            interactive={true}
          >
            <Tooltip direction="top" offset={[0, -4]} opacity={0.9} sticky>
              <div style={{ fontFamily: '-apple-system, system-ui, sans-serif', fontSize: 12 }}>
                <div style={{ fontWeight: 600 }}>{t.name}</div>
                <div style={{ color: 'var(--text-muted, #6b7280)', fontSize: 11 }}>
                  {t.point_count.toLocaleString()} pts · {formatKm(t.distance_m)}
                </div>
              </div>
            </Tooltip>
          </Polyline>
        )
      ))}
    </>
  )
}

function formatKm(metres: number): string {
  if (!metres || metres < 1) return ''
  if (metres < 1000) return `${Math.round(metres)} m`
  return `${(metres / 1000).toFixed(1)} km`
}
