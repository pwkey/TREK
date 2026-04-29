// [460-fork] Milestone 6 follow-up — batch import photos with auto-day-
// assignment + duplicate detection.
//
// Flow:
//   1. User multi-selects image files (or drops a folder).
//   2. For each, we read EXIF metadata up front (capture date, GPS,
//      camera). Files with no taken_at can still be imported but
//      need manual day assignment.
//   3. Match photo's taken_at (UTC date portion) to a trip day's
//      `date` column.
//   4. Flag duplicates: same original_name + taken_at as an existing
//      photo on the trip.
//   5. Show preview matrix; user confirms or adjusts per-row day
//      assignment.
//   6. Sequential upload (re-uses uploadDayPhoto on the slice) with
//      progress indicator.
//
// Out of scope here: videos (the user has one in their batch — we
// surface it as "skipped: video files not yet supported"; M6 §6 marks
// short-clip support as a future-consideration).
import { useEffect, useMemo, useState } from 'react'
import { Upload, X, AlertTriangle, CheckCircle, Image as ImageIcon } from 'lucide-react'
import { useTripStore } from '../../store/tripStore'
import { useToast } from '../shared/Toast'
import { extractMetadata, isHeic } from '../../lib/imageProcessing'
import { mapsApi } from '../../api/client'
import type { Day } from '../../types'
import type { DayPhoto } from '../../store/slices/dayPhotosSlice'

/** Run reverse-geocode against /api/maps/reverse for each prepared
 *  file with GPS, with a small concurrency cap so we don't hammer
 *  Nominatim. The server already proxies + UA-stamps the requests;
 *  the client just needs to be polite. */
const GEOCODE_CONCURRENCY = 3

interface BatchPhotoImportProps {
  tripId: number | string
  days: Day[]
  onClose: () => void
}

interface PreparedFile {
  file: File
  takenAt: string | null
  /** YYYY-MM-DD derived from takenAt for day matching. */
  dateKey: string | null
  /** Auto-assigned day id, or null if no match. */
  suggestedDayId: number | null
  /** User can override via the per-row dropdown. */
  selectedDayId: number | null
  /** True when an existing photo with same original_name + taken_at
   *  is already present on the trip. */
  isDuplicate: boolean
  /** True when the file is unsupported (video, non-image). */
  unsupported: string | null
  status: 'pending' | 'uploading' | 'done' | 'error' | 'skipped'
  errorMessage?: string
  thumbnailUrl?: string
  /** GPS lat/lng cached so we can fire reverse-geocode after the
   *  preview opens (keeps the analysing phase quick — geocoding
   *  happens in the background while the user is reviewing). */
  lat: number | null
  lng: number | null
  /** Auto-filled from reverse geocode when available; user can edit
   *  inline before confirming. */
  caption: string
  /** Tracks the geocode lookup state so we can show "Looking up
   *  location…" while in flight. */
  geocodeStatus: 'pending' | 'looking-up' | 'done' | 'no-gps' | 'failed'
}

export default function BatchPhotoImport({ tripId, days, onClose }: BatchPhotoImportProps) {
  const toast = useToast()
  const dayPhotosMap = useTripStore(s => s.dayPhotos)
  const loadDayPhotos = useTripStore(s => s.loadDayPhotos)
  const uploadDayPhoto = useTripStore(s => s.uploadDayPhoto)

  const [phase, setPhase] = useState<'pick' | 'preview' | 'uploading' | 'done'>('pick')
  const [items, setItems] = useState<PreparedFile[]>([])
  const [analysing, setAnalysing] = useState(false)
  const [progressIdx, setProgressIdx] = useState(0)

  // Make sure we have photos loaded for every day so duplicate
  // detection works even when the user hasn't visited each day.
  useEffect(() => {
    days.forEach(d => { void loadDayPhotos(tripId, d.id) })
  }, [tripId, days, loadDayPhotos])

  const existingPhotos: DayPhoto[] = useMemo(() => {
    return Object.values(dayPhotosMap).flat()
  }, [dayPhotosMap])

  const sortedDays = useMemo(() => {
    return [...days].sort((a, b) => {
      const ad = a.date ?? ''
      const bd = b.date ?? ''
      if (ad === bd) return a.day_number - b.day_number
      return ad.localeCompare(bd)
    })
  }, [days])

  const onPick = async (filesArg: FileList | File[] | null) => {
    if (!filesArg) return
    const files = Array.from(filesArg)
    if (files.length === 0) return
    setAnalysing(true)
    try {
      const prepared: PreparedFile[] = []
      for (const file of files) {
        // Filter out non-image files up front. HEIC files have
        // image/heic mime in some browsers and "" in others — match
        // by extension as fallback.
        const isImage = file.type.startsWith('image/') || isHeic(file)
        const isVideo = file.type.startsWith('video/') || /\.(mp4|mov|m4v|avi|mkv)$/i.test(file.name)
        if (isVideo) {
          prepared.push(makeRow(file, null, null, false, 'video files not yet supported'))
          continue
        }
        if (!isImage) {
          prepared.push(makeRow(file, null, null, false, 'not an image'))
          continue
        }
        const meta = await extractMetadata(file)
        const dateKey = meta.takenAt ? meta.takenAt.slice(0, 10) : null
        const matchingDay = dateKey ? sortedDays.find(d => d.date === dateKey) : undefined
        const suggestedDayId = matchingDay?.id ?? null
        const isDup = existingPhotos.some(p =>
          p.original_name === file.name && p.taken_at === meta.takenAt,
        )
        prepared.push({
          file,
          takenAt: meta.takenAt,
          dateKey,
          suggestedDayId,
          selectedDayId: suggestedDayId,
          isDuplicate: isDup,
          unsupported: null,
          status: isDup ? 'skipped' : 'pending',
          thumbnailUrl: URL.createObjectURL(file),
          lat: meta.lat,
          lng: meta.lng,
          caption: '',
          geocodeStatus: meta.lat !== null && meta.lng !== null ? 'pending' : 'no-gps',
        })
      }
      setItems(prepared)
      setPhase('preview')
      // Fire reverse-geocode in the background so the preview is
      // interactive immediately and captions populate as they
      // resolve. Skipped + duplicate rows are still geocoded — the
      // user can use the caption text as a hint when deciding
      // whether to override the skip.
      void runGeocodeQueue(prepared)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Could not read files'
      toast.error(msg)
    } finally {
      setAnalysing(false)
    }
  }

  /** Concurrency-capped reverse-geocode runner. Keeps up to
   *  GEOCODE_CONCURRENCY requests in flight at once and updates each
   *  row as the result lands. Rows without GPS are marked 'no-gps'
   *  immediately so the UI doesn't spin on them forever. */
  const runGeocodeQueue = async (prepared: PreparedFile[]) => {
    const queue = prepared
      .map((row, idx) => ({ row, idx }))
      .filter(({ row }) => row.lat !== null && row.lng !== null)
    let next = 0
    const worker = async () => {
      while (next < queue.length) {
        const cur = queue[next++]
        updateRow(cur.idx, { geocodeStatus: 'looking-up' })
        try {
          const result = await mapsApi.reverse(cur.row.lat as number, cur.row.lng as number)
          const cap = (result?.name || result?.address || '').toString().trim()
          updateRow(cur.idx, { caption: cap, geocodeStatus: 'done' })
        } catch {
          updateRow(cur.idx, { geocodeStatus: 'failed' })
        }
      }
    }
    await Promise.all(Array.from({ length: GEOCODE_CONCURRENCY }, worker))
  }

  const updateRow = (idx: number, patch: Partial<PreparedFile>) => {
    setItems(prev => prev.map((row, i) => i === idx ? { ...row, ...patch } : row))
  }

  const startUpload = async () => {
    setPhase('uploading')
    let i = 0
    for (const item of items) {
      setProgressIdx(i)
      if (item.unsupported) { updateRow(i, { status: 'skipped' }); i++; continue }
      if (item.isDuplicate) { updateRow(i, { status: 'skipped' }); i++; continue }
      if (item.selectedDayId == null) { updateRow(i, { status: 'skipped', errorMessage: 'no day assigned' }); i++; continue }
      updateRow(i, { status: 'uploading' })
      try {
        await uploadDayPhoto(tripId, item.selectedDayId, item.file, { caption: item.caption.trim() || undefined })
        updateRow(i, { status: 'done' })
      } catch (err: unknown) {
        updateRow(i, { status: 'error', errorMessage: err instanceof Error ? err.message : 'upload failed' })
      }
      i++
    }
    setPhase('done')
  }

  const closeAndCleanup = () => {
    items.forEach(it => { if (it.thumbnailUrl) URL.revokeObjectURL(it.thumbnailUrl) })
    onClose()
  }

  const summary = useMemo(() => {
    const total = items.length
    const matched = items.filter(i => !i.unsupported && !i.isDuplicate && i.selectedDayId != null).length
    const unmatched = items.filter(i => !i.unsupported && !i.isDuplicate && i.selectedDayId == null).length
    const dup = items.filter(i => i.isDuplicate).length
    const unsupported = items.filter(i => !!i.unsupported).length
    return { total, matched, unmatched, dup, unsupported }
  }, [items])

  return (
    <div onClick={closeAndCleanup} style={{ position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div onClick={e => e.stopPropagation()} style={{ width: '100%', maxWidth: 760, maxHeight: '90vh', background: 'var(--bg-card)', borderRadius: 14, padding: 20, display: 'flex', flexDirection: 'column' }}>
        <header style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
          <Upload size={18} strokeWidth={1.8} />
          <h2 style={{ fontSize: 16, fontWeight: 700, margin: 0, flex: 1 }}>Batch import photos</h2>
          <button type="button" onClick={closeAndCleanup} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: 4 }}>
            <X size={16} />
          </button>
        </header>

        {phase === 'pick' && (
          <PickPhase analysing={analysing} onPick={onPick} />
        )}

        {(phase === 'preview' || phase === 'uploading' || phase === 'done') && (
          <>
            <div style={{ marginBottom: 12, padding: 10, borderRadius: 8, background: 'var(--bg-secondary)', fontSize: 12, color: 'var(--text-secondary)' }}>
              <strong>{summary.total}</strong> file{summary.total === 1 ? '' : 's'} selected · <span style={{ color: '#16a34a' }}>{summary.matched} will import</span>
              {summary.unmatched > 0 && <> · <span style={{ color: '#ca8a04' }}>{summary.unmatched} need a day</span></>}
              {summary.dup > 0 && <> · <span style={{ color: 'var(--text-faint)' }}>{summary.dup} duplicates skipped</span></>}
              {summary.unsupported > 0 && <> · <span style={{ color: 'var(--text-faint)' }}>{summary.unsupported} unsupported</span></>}
            </div>

            <div style={{ overflowY: 'auto', flex: 1, marginBottom: 12, paddingRight: 4 }}>
              {items.map((it, idx) => (
                <div key={idx} style={{ display: 'grid', gridTemplateColumns: '44px 1fr auto', gap: 10, padding: '8px 10px', borderRadius: 8, background: 'var(--bg-secondary)', marginBottom: 6, alignItems: 'center' }}>
                  {it.thumbnailUrl ? (
                    <img src={it.thumbnailUrl} alt="" style={{ width: 44, height: 44, objectFit: 'cover', borderRadius: 6 }} />
                  ) : (
                    <div style={{ width: 44, height: 44, borderRadius: 6, background: 'var(--bg-tertiary)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <ImageIcon size={16} style={{ color: 'var(--text-faint)' }} />
                    </div>
                  )}
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.file.name}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                      {it.takenAt ? new Date(it.takenAt).toLocaleString() : 'no capture date'}
                      {' · '}
                      {(it.file.size / (1024 * 1024)).toFixed(1)} MB
                    </div>
                    {/* Caption row — only meaningful when the upload will
                        actually run, so hidden for unsupported / duplicate. */}
                    {!it.unsupported && !it.isDuplicate && (
                      <input
                        type="text"
                        value={it.caption}
                        onChange={e => updateRow(idx, { caption: e.target.value })}
                        placeholder={
                          it.geocodeStatus === 'looking-up' ? 'Looking up location…' :
                          it.geocodeStatus === 'no-gps' ? 'Caption (no GPS — manual only)' :
                          it.geocodeStatus === 'failed' ? 'Caption (location lookup failed — type your own)' :
                          'Caption'
                        }
                        disabled={phase !== 'preview'}
                        style={{ marginTop: 4, width: '100%', padding: '4px 6px', borderRadius: 6, border: '1px solid var(--border-primary)', background: 'var(--bg-input)', color: 'var(--text-primary)', fontSize: 11, fontFamily: 'inherit', boxSizing: 'border-box' }}
                      />
                    )}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11 }}>
                    {it.unsupported ? (
                      <span style={{ color: 'var(--text-faint)', fontStyle: 'italic' }}>{it.unsupported}</span>
                    ) : it.isDuplicate ? (
                      <span style={{ color: 'var(--text-faint)' }}>already imported · skip</span>
                    ) : (
                      <select
                        value={it.selectedDayId ?? ''}
                        onChange={e => updateRow(idx, { selectedDayId: e.target.value ? Number(e.target.value) : null })}
                        disabled={phase !== 'preview'}
                        style={{ padding: '4px 6px', borderRadius: 6, border: '1px solid var(--border-primary)', background: 'var(--bg-input)', color: 'var(--text-primary)', fontSize: 11, fontFamily: 'inherit' }}
                      >
                        <option value="">— pick a day —</option>
                        {sortedDays.map(d => (
                          <option key={d.id} value={d.id}>
                            Day {d.day_number}{d.date ? ` · ${d.date}` : ''}{d.title ? ` · ${d.title}` : ''}
                          </option>
                        ))}
                      </select>
                    )}
                    <StatusIcon status={it.status} />
                  </div>
                </div>
              ))}
            </div>

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', borderTop: '1px solid var(--border-faint)', paddingTop: 12 }}>
              {phase === 'preview' && (
                <>
                  <button type="button" onClick={closeAndCleanup} style={btnSecondary}>Cancel</button>
                  <button type="button" onClick={startUpload} disabled={summary.matched === 0} style={btnPrimary}>Import {summary.matched} photo{summary.matched === 1 ? '' : 's'}</button>
                </>
              )}
              {phase === 'uploading' && (
                <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Uploading {progressIdx + 1} of {items.length}…</span>
              )}
              {phase === 'done' && (
                <button type="button" onClick={closeAndCleanup} style={btnPrimary}>Done</button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function PickPhase({ onPick, analysing }: { onPick: (files: FileList | null) => void; analysing: boolean }) {
  return (
    <label
      onDragOver={e => e.preventDefault()}
      onDrop={e => { e.preventDefault(); onPick(e.dataTransfer.files) }}
      style={{ display: 'block', padding: 32, borderRadius: 10, border: '1.5px dashed var(--border-primary)', textAlign: 'center', cursor: 'pointer' }}
    >
      <input
        type="file"
        accept="image/*"
        multiple
        style={{ display: 'none' }}
        disabled={analysing}
        onChange={e => { onPick(e.target.files); if (e.target) e.target.value = '' }}
      />
      <Upload size={32} strokeWidth={1.5} style={{ color: 'var(--text-faint)', marginBottom: 12 }} />
      <div style={{ fontSize: 14, color: 'var(--text-primary)', marginBottom: 4 }}>
        {analysing ? 'Reading EXIF metadata…' : 'Click or drop image files here'}
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-faint)' }}>
        Photos are matched to days by capture date. Duplicates (same name + capture timestamp) are detected and skipped automatically.
      </div>
    </label>
  )
}

function StatusIcon({ status }: { status: PreparedFile['status'] }) {
  if (status === 'done') return <CheckCircle size={14} style={{ color: '#16a34a' }} />
  if (status === 'error') return <AlertTriangle size={14} style={{ color: '#dc2626' }} />
  if (status === 'uploading') return <span style={{ width: 12, height: 12, border: '2px solid var(--border-primary)', borderTopColor: 'var(--accent)', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
  return null
}

function makeRow(file: File, takenAt: string | null, dayId: number | null, isDup: boolean, unsupported: string | null): PreparedFile {
  return {
    file, takenAt,
    dateKey: takenAt ? takenAt.slice(0, 10) : null,
    suggestedDayId: dayId,
    selectedDayId: dayId,
    isDuplicate: isDup,
    unsupported,
    status: unsupported || isDup ? 'skipped' : 'pending',
    lat: null,
    lng: null,
    caption: '',
    geocodeStatus: 'no-gps',
  }
}

const btnSecondary: React.CSSProperties = { padding: '8px 16px', borderRadius: 8, border: '1px solid var(--border-primary)', background: 'transparent', color: 'var(--text-primary)', cursor: 'pointer', fontSize: 13, fontFamily: 'inherit' }
const btnPrimary: React.CSSProperties = { padding: '8px 16px', borderRadius: 8, border: 'none', background: 'var(--accent)', color: 'var(--accent-text)', cursor: 'pointer', fontSize: 13, fontWeight: 600, fontFamily: 'inherit' }
