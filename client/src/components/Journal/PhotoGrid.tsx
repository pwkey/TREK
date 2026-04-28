// [460-fork] Milestone 6 slice 2 — photo grid for the day-detail panel.
//
// Displays the day's photos as thumbnails, lets the user drop more files,
// edit captions, and delete. Reordering ships in a follow-up; the grid
// renders in `position` order from the slice. Native camera capture on
// mobile is exposed via the file input's `capture` attribute — works on
// iOS Safari + Android Chrome out of the box, and the Capacitor wrapper
// (M1) will swap to the camera plugin behind the same UI.
import { useEffect, useRef, useState } from 'react'
import ReactDOM from 'react-dom'
import { Camera, Upload, X, Trash2, MapPin } from 'lucide-react'
import { useTripStore } from '../../store/tripStore'
import PhotoImg from './PhotoImg'

interface PhotoGridProps {
  tripId: number | string
  dayId: number
}

export default function PhotoGrid({ tripId, dayId }: PhotoGridProps) {
  const photos = useTripStore(s => s.dayPhotos[String(dayId)] ?? [])
  const loadDayPhotos = useTripStore(s => s.loadDayPhotos)
  const uploadDayPhoto = useTripStore(s => s.uploadDayPhoto)
  const updateDayPhoto = useTripStore(s => s.updateDayPhoto)
  const deleteDayPhoto = useTripStore(s => s.deleteDayPhoto)

  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const cameraInputRef = useRef<HTMLInputElement | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editingCaption, setEditingCaption] = useState('')
  const [lightbox, setLightbox] = useState<number | null>(null)

  useEffect(() => {
    void loadDayPhotos(tripId, dayId)
  }, [tripId, dayId, loadDayPhotos])

  const handleFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return
    // Snapshot the FileList up front. The onChange handler resets
    // e.target.value = '' synchronously after calling us so the input is
    // ready for re-selection of the same file; that reset clears the
    // input's live FileList — including the reference we received here —
    // and would silently truncate this loop after the first await if we
    // kept iterating against it.
    const list = Array.from(files)
    setBusy(true)
    setError(null)
    const skipped: string[] = []
    let succeeded = 0
    let lastError: string | null = null
    // Sequential to keep memory usage sane when the user drops a large
    // batch, and so we can report which files succeeded vs failed
    // individually rather than aborting the whole batch on first error.
    for (const f of list) {
      // HEIC files are handled by imageProcessing.ts via heic2any; only
      // bail on truly non-image inputs.
      const isImageMime = f.type.startsWith('image/')
      const isHeicByExt = /\.hei[cf]$/i.test(f.name)
      if (!isImageMime && !isHeicByExt) {
        skipped.push(`${f.name} (not an image)`)
        continue
      }
      try {
        await uploadDayPhoto(tripId, dayId, f)
        succeeded++
      } catch (err: unknown) {
        lastError = err instanceof Error ? err.message : 'Upload failed'
        skipped.push(`${f.name} (${lastError})`)
      }
    }
    if (skipped.length > 0) {
      setError(`${succeeded} uploaded, ${skipped.length} skipped: ${skipped.join('; ')}`)
    }
    setBusy(false)
  }

  const startEdit = (id: number, caption: string | null) => {
    setEditingId(id)
    setEditingCaption(caption ?? '')
  }

  const commitEdit = async () => {
    if (editingId === null) return
    const id = editingId
    const next = editingCaption
    setEditingId(null)
    try {
      await updateDayPhoto(tripId, dayId, id, { caption: next.trim() === '' ? null : next.trim() })
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Caption update failed')
    }
  }

  const handleDelete = async (id: number) => {
    if (!window.confirm('Delete this photo? This cannot be undone.')) return
    try {
      await deleteDayPhoto(tripId, dayId, id)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Delete failed')
    }
  }

  return (
    <section style={{ marginTop: 16 }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <Camera size={15} strokeWidth={1.8} style={{ color: 'var(--text-secondary)' }} />
        <h3 style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', margin: 0 }}>
          Photos {photos.length > 0 && <span style={{ color: 'var(--text-faint)', fontWeight: 400 }}>· {photos.length}</span>}
        </h3>
        <div style={{ marginLeft: 'auto', display: 'inline-flex', gap: 6 }}>
          <button type="button" onClick={() => cameraInputRef.current?.click()} disabled={busy} style={chipBtn()} title="Take a photo">
            <Camera size={11} /> Camera
          </button>
          <button type="button" onClick={() => fileInputRef.current?.click()} disabled={busy} style={chipBtn()} title="Upload from this device">
            <Upload size={11} /> Upload
          </button>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          style={{ display: 'none' }}
          onChange={e => { void handleFiles(e.target.files); if (e.target) e.target.value = '' }}
        />
        <input
          ref={cameraInputRef}
          type="file"
          accept="image/*"
          capture="environment"
          style={{ display: 'none' }}
          onChange={e => { void handleFiles(e.target.files); if (e.target) e.target.value = '' }}
        />
      </header>

      {photos.length === 0 ? (
        <div
          onDragOver={e => e.preventDefault()}
          onDrop={e => { e.preventDefault(); void handleFiles(e.dataTransfer.files) }}
          style={{
            padding: 18, borderRadius: 8, border: '1.5px dashed var(--border-primary)',
            textAlign: 'center', fontSize: 12, color: 'var(--text-faint)',
          }}
        >
          {busy ? 'Uploading…' : 'No photos yet — drop image files here, or use Camera / Upload above.'}
        </div>
      ) : (
        <div
          onDragOver={e => e.preventDefault()}
          onDrop={e => { e.preventDefault(); void handleFiles(e.dataTransfer.files) }}
          style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(110px, 1fr))', gap: 6 }}
        >
          {photos.map((p, idx) => (
            <figure key={p.id} style={{ margin: 0, position: 'relative', borderRadius: 8, overflow: 'hidden', background: 'var(--bg-tertiary)' }}>
              <PhotoImg
                tripId={tripId}
                uploadId={p.upload_id}
                alt={p.caption ?? 'Day photo'}
                onClick={() => setLightbox(idx)}
                style={{ width: '100%', height: 96, objectFit: 'cover', display: 'block', cursor: 'zoom-in' }}
              />

              <button
                type="button"
                onClick={() => handleDelete(p.id)}
                title="Delete photo"
                style={{
                  position: 'absolute', top: 4, right: 4,
                  width: 22, height: 22, borderRadius: 6,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  background: 'rgba(0,0,0,0.55)', color: 'white',
                  border: 'none', cursor: 'pointer', padding: 0,
                }}
              >
                <Trash2 size={12} />
              </button>
              {p.lat !== null && p.lng !== null && (
                <span
                  title={[
                    `Geotagged: ${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}`,
                    p.altitude !== null ? `Altitude: ${Math.round(p.altitude)} m` : null,
                    p.camera ? `Camera: ${p.camera}` : null,
                  ].filter(Boolean).join('\n')}
                  style={{
                    position: 'absolute', top: 4, left: 4,
                    width: 22, height: 22, borderRadius: 6,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    background: 'rgba(0,0,0,0.55)', color: 'white',
                  }}
                >
                  <MapPin size={12} />
                </span>
              )}
              <figcaption
                onClick={() => startEdit(p.id, p.caption)}
                style={{
                  padding: '4px 6px', fontSize: 10, lineHeight: 1.3,
                  color: p.caption ? 'var(--text-primary)' : 'var(--text-faint)',
                  background: 'var(--bg-card)', cursor: 'text',
                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                }}
                title={p.caption ?? 'Click to add a caption'}
              >
                {editingId === p.id ? (
                  <input
                    autoFocus
                    value={editingCaption}
                    onChange={e => setEditingCaption(e.target.value)}
                    onBlur={commitEdit}
                    onKeyDown={e => { if (e.key === 'Enter') { (e.currentTarget as HTMLInputElement).blur() } if (e.key === 'Escape') { setEditingId(null) } }}
                    style={{ width: '100%', border: 'none', outline: 'none', background: 'transparent', fontSize: 10, padding: 0, fontFamily: 'inherit', color: 'var(--text-primary)' }}
                  />
                ) : (
                  p.caption ?? 'Add caption'
                )}
              </figcaption>
            </figure>
          ))}
        </div>
      )}

      {error && <div style={{ marginTop: 6, fontSize: 11, color: '#b91c1c' }}>{error}</div>}

      {/* Portal the lightbox to body so it escapes any transform / filter
          stacking context the day-detail panel sits inside (position:
          fixed becomes relative to the nearest transformed ancestor, so
          rendering inside the panel can place the image off-screen). */}
      {lightbox !== null && photos[lightbox] && ReactDOM.createPortal(
        <div
          onClick={() => setLightbox(null)}
          style={{ position: 'fixed', inset: 0, zIndex: 100000, background: 'rgba(0,0,0,0.88)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}
        >
          <PhotoImg
            tripId={tripId}
            uploadId={photos[lightbox].upload_id}
            alt={photos[lightbox].caption ?? ''}
            onClick={e => e.stopPropagation()}
            style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', display: 'block' }}
          />
          <button type="button" onClick={() => setLightbox(null)} style={{ position: 'absolute', top: 16, right: 16, background: 'rgba(255,255,255,0.15)', color: 'white', border: 'none', borderRadius: 999, width: 36, height: 36, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
            <X size={18} />
          </button>
        </div>,
        document.body,
      )}
    </section>
  )
}

function chipBtn(): React.CSSProperties {
  return {
    display: 'inline-flex', alignItems: 'center', gap: 4,
    padding: '4px 10px', fontSize: 11, fontWeight: 500,
    background: 'transparent', color: 'var(--text-muted)',
    border: '1px solid var(--border-primary)', borderRadius: 8,
    cursor: 'pointer', fontFamily: 'inherit',
  }
}
