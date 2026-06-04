// [460-fork] Milestone 6 slice 3 — read-only memoir timeline.
//
// Renders a trip's days in date order as a vertical scrollable timeline:
//   - day header (date + day_number + title)
//   - journal markdown
//   - photo grid (thumbnails open in a lightbox)
//   - quiet inline summary of the day's place assignments
//
// No new server endpoints — reuses the per-day journal + photos APIs the
// editor uses. Loading is dispatched lazily as each day card mounts so
// scrolling a long trip doesn't fan out N requests up front.
import { useEffect, useState } from 'react'
import ReactDOM from 'react-dom'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { BookOpen, Calendar, MapPin, X } from 'lucide-react'
import { useTripStore } from '../../store/tripStore'
import { useTranslation } from '../../i18n'
import PhotoImg from './PhotoImg'
import DayPhotoMap from './DayPhotoMap'
import type { Day, AssignmentsMap } from '../../types'
import type { DayPhoto } from '../../store/slices/dayPhotosSlice'

interface MemoirViewProps {
  tripId: number | string
  days: Day[]
  assignments: AssignmentsMap
}

export default function MemoirView({ tripId, days, assignments }: MemoirViewProps) {
  const { locale } = useTranslation()
  // Lightbox state lives at the top so the portal renders once per
  // memoir, not once per day card.
  const [lightbox, setLightbox] = useState<{ dayId: number; index: number } | null>(null)

  const sortedDays = [...days].sort((a, b) => {
    const ad = a.date ?? ''
    const bd = b.date ?? ''
    if (ad === bd) return a.day_number - b.day_number
    return ad.localeCompare(bd)
  })

  if (sortedDays.length === 0) {
    return (
      <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-faint)' }}>
        No days in this trip yet.
      </div>
    )
  }

  const dayPhotosMap = useTripStore(s => s.dayPhotos)
  const lightboxPhotos: DayPhoto[] = lightbox ? (dayPhotosMap[String(lightbox.dayId)] ?? []) : []
  const currentLightboxPhoto = lightbox && lightboxPhotos[lightbox.index]

  return (
    <div style={{ maxWidth: 880, margin: '0 auto', padding: '24px 16px 64px' }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 24, color: 'var(--text-secondary)' }}>
        <BookOpen size={18} strokeWidth={1.8} />
        <h2 style={{ fontSize: 18, fontWeight: 700, margin: 0, color: 'var(--text-primary)' }}>Memoir</h2>
        <span style={{ fontSize: 12, color: 'var(--text-faint)' }}>
          {sortedDays.length} day{sortedDays.length === 1 ? '' : 's'}
        </span>
      </header>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 32 }}>
        {sortedDays.map((day) => (
          <DayCard
            key={day.id}
            tripId={tripId}
            day={day}
            assignments={assignments[String(day.id)] ?? []}
            locale={locale}
            onPhotoClick={(idx) => setLightbox({ dayId: day.id, index: idx })}
          />
        ))}
      </div>

      {/* Single shared lightbox — portaled to body to escape the tab
          container's stacking context. */}
      {lightbox && currentLightboxPhoto && ReactDOM.createPortal(
        <div
          onClick={() => setLightbox(null)}
          style={{ position: 'fixed', inset: 0, zIndex: 100000, background: 'rgba(0,0,0,0.88)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}
        >
          <PhotoImg
            tripId={tripId}
            uploadId={currentLightboxPhoto.upload_id}
            alt={currentLightboxPhoto.caption ?? ''}
            variant="full"
            onClick={(e) => e.stopPropagation()}
            style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', display: 'block' }}
          />
          <button
            type="button"
            onClick={() => setLightbox(null)}
            style={{ position: 'absolute', top: 16, right: 16, background: 'rgba(255,255,255,0.15)', color: 'white', border: 'none', borderRadius: 999, width: 36, height: 36, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}
          >
            <X size={18} />
          </button>
        </div>,
        document.body,
      )}
    </div>
  )
}

interface DayCardProps {
  tripId: number | string
  day: Day
  assignments: AssignmentsMap[string]
  locale: string
  onPhotoClick: (index: number) => void
}

function DayCard({ tripId, day, assignments, locale, onPhotoClick }: DayCardProps) {
  const journal = useTripStore(s => s.dayJournals[String(day.id)] ?? null)
  const photos = useTripStore(s => s.dayPhotos[String(day.id)] ?? [])
  const loadJournal = useTripStore(s => s.loadJournal)
  const loadDayPhotos = useTripStore(s => s.loadDayPhotos)

  useEffect(() => {
    void loadJournal(tripId, day.id)
    void loadDayPhotos(tripId, day.id)
  }, [tripId, day.id, loadJournal, loadDayPhotos])

  const hasJournal = journal && journal.content_markdown.trim().length > 0
  const hasPhotos = photos.length > 0
  const hasPlaces = assignments.length > 0

  const dateLabel = day.date
    ? new Date(day.date + 'T00:00:00').toLocaleDateString(locale || 'en', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })
    : `Day ${day.day_number}`

  return (
    <article style={{ borderRadius: 12, background: 'var(--bg-card)', border: '1px solid var(--border-faint)', overflow: 'hidden' }}>
      <header style={{ padding: '14px 18px', borderBottom: '1px solid var(--border-faint)', background: 'var(--bg-secondary)', display: 'flex', alignItems: 'baseline', gap: 12 }}>
        <Calendar size={14} strokeWidth={1.8} style={{ color: 'var(--text-faint)', flexShrink: 0, alignSelf: 'center' }} />
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            Day {day.day_number}
          </span>
          <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{dateLabel}</span>
        </div>
        {day.title && (
          <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', marginLeft: 'auto', textAlign: 'right' }}>
            {day.title}
          </span>
        )}
      </header>

      <div style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 16 }}>
        {/* Journal */}
        {hasJournal ? (
          <div className="collab-note-md-full" style={{ fontSize: 13, lineHeight: 1.55, color: 'var(--text-primary)' }}>
            <Markdown remarkPlugins={[remarkGfm]}>{journal!.content_markdown}</Markdown>
          </div>
        ) : (
          <div style={{ fontSize: 12, color: 'var(--text-faint)', fontStyle: 'italic' }}>
            No journal entry for this day.
          </div>
        )}

        {/* Per-day map of geotagged photos. Only renders when at least
            one photo on this day has EXIF GPS — silently absent otherwise
            so non-geotagged days stay compact. */}
        {hasPhotos && photos.some(p => p.lat !== null && p.lng !== null) && (
          <DayPhotoMap photos={photos} onMarkerClick={onPhotoClick} />
        )}

        {/* Photos */}
        {hasPhotos && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: 6 }}>
            {photos.map((p, idx) => (
              <figure key={p.id} style={{ margin: 0, position: 'relative', borderRadius: 8, overflow: 'hidden', background: 'var(--bg-tertiary)' }}>
                <PhotoImg
                  tripId={tripId}
                  uploadId={p.upload_id}
                  alt={p.caption ?? 'Day photo'}
                  onClick={() => onPhotoClick(idx)}
                  style={{ width: '100%', height: 110, objectFit: 'cover', display: 'block', cursor: 'zoom-in' }}
                />
                {p.lat !== null && p.lng !== null && (
                  <span
                    title={[
                      `Geotagged: ${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}`,
                      p.altitude !== null ? `Altitude: ${Math.round(p.altitude)} m` : null,
                      p.camera ? `Camera: ${p.camera}` : null,
                    ].filter(Boolean).join('\n')}
                    style={{ position: 'absolute', top: 4, left: 4, width: 22, height: 22, borderRadius: 6, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.55)', color: 'white' }}
                  >
                    <MapPin size={12} />
                  </span>
                )}
                {p.caption && (
                  <figcaption style={{ padding: '4px 6px', fontSize: 10, lineHeight: 1.3, color: 'var(--text-primary)', background: 'var(--bg-card)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={p.caption}>
                    {p.caption}
                  </figcaption>
                )}
              </figure>
            ))}
          </div>
        )}

        {/* Place assignments — quiet inline list */}
        {hasPlaces && (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: 'var(--text-muted)' }}>
            {assignments.map((a) => (
              <li key={a.id} style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
                {a.place?.place_time && (
                  <span style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--text-faint)', minWidth: 44 }}>
                    {a.place.place_time}
                  </span>
                )}
                <span>{a.place?.name ?? 'Unnamed place'}</span>
              </li>
            ))}
          </ul>
        )}

        {!hasJournal && !hasPhotos && !hasPlaces && (
          <div style={{ fontSize: 12, color: 'var(--text-faint)', fontStyle: 'italic' }}>
            Nothing recorded for this day yet.
          </div>
        )}
      </div>
    </article>
  )
}
