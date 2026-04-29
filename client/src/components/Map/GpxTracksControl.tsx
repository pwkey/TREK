// [460-fork] M6 follow-up — floating GPS-tracks control for the trip
// planner map.
//
// Click the button → popover lists all uploaded tracks for the trip
// with eye-toggle / rename / delete, plus an Upload button. The
// visibility map is per-device (localStorage keyed by trip id) so
// two collaborators can each hide/show different tracks without
// stepping on each other's view.
import { useEffect, useRef, useState } from 'react'
import { Route, Eye, EyeOff, Pencil, Trash2, Upload, Check, X } from 'lucide-react'
import type { GpxTrack } from '../../store/slices/gpxTracksSlice'

interface GpxTracksControlProps {
  tripId: number | string
  tracks: GpxTrack[]
  visibleIds: Set<number>
  onToggleVisible: (id: number) => void
  onUpload: (file: File) => Promise<void>
  onRename: (id: number, name: string) => Promise<void>
  onDelete: (id: number) => Promise<void>
}

export function GpxTracksControl({
  tracks, visibleIds, onToggleVisible, onUpload, onRename, onDelete,
}: GpxTracksControlProps) {
  const [open, setOpen] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [renamingId, setRenamingId] = useState<number | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const wrapperRef = useRef<HTMLDivElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (!open) return
    const onDocClick = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const handleFile = async (file: File) => {
    setError(null)
    setUploading(true)
    try {
      await onUpload(file)
    } catch (err: unknown) {
      const apiMsg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error
      setError(apiMsg || (err instanceof Error ? err.message : 'Upload failed'))
    } finally {
      setUploading(false)
    }
  }

  const commitRename = async (id: number) => {
    const trimmed = renameDraft.trim()
    setRenamingId(null)
    if (!trimmed) return
    const current = tracks.find(t => t.id === id)
    if (current && current.name === trimmed) return
    try { await onRename(id, trimmed) } catch { /* slice keeps optimistic state */ }
  }

  return (
    <div
      ref={wrapperRef}
      style={{ position: 'absolute', right: 16, bottom: 64, zIndex: 30, fontFamily: 'inherit' }}
    >
      {open && (
        <div role="menu" style={{
          position: 'absolute', bottom: 48, right: 0,
          minWidth: 280, maxWidth: 340,
          background: 'var(--bg-card)',
          backdropFilter: 'blur(16px)', WebkitBackdropFilter: 'blur(16px)',
          border: '1px solid var(--border-primary)',
          borderRadius: 12, padding: 8,
          boxShadow: '0 6px 20px rgba(0,0,0,0.18)',
          fontSize: 12,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, padding: '0 6px', color: 'var(--text-muted)' }}>
            <Route size={14} />
            <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>GPS tracks</span>
            <span style={{ marginLeft: 'auto' }}>{tracks.length}</span>
          </div>

          {tracks.length === 0 && (
            <div style={{ padding: '10px 8px', color: 'var(--text-faint)', textAlign: 'center' }}>
              No tracks uploaded yet.
            </div>
          )}

          {tracks.map(t => {
            const visible = visibleIds.has(t.id)
            const isRenaming = renamingId === t.id
            return (
              <div key={t.id} style={{
                display: 'flex', alignItems: 'center', gap: 6,
                padding: '6px 6px', borderRadius: 8,
              }}>
                <button
                  type="button"
                  title={visible ? 'Hide' : 'Show'}
                  onClick={() => onToggleVisible(t.id)}
                  style={iconBtn}
                >
                  {visible ? <Eye size={14} /> : <EyeOff size={14} style={{ opacity: 0.5 }} />}
                </button>
                {isRenaming ? (
                  <>
                    <input
                      autoFocus
                      value={renameDraft}
                      onChange={e => setRenameDraft(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter') commitRename(t.id)
                        if (e.key === 'Escape') setRenamingId(null)
                      }}
                      onBlur={() => commitRename(t.id)}
                      style={{
                        flex: 1, minWidth: 0, padding: '4px 6px', borderRadius: 6,
                        border: '1px solid var(--border-primary)', fontSize: 12,
                        background: 'var(--bg-input)', color: 'var(--text-primary)',
                        fontFamily: 'inherit',
                      }}
                    />
                    <button type="button" title="Save" onMouseDown={e => e.preventDefault()} onClick={() => commitRename(t.id)} style={iconBtn}><Check size={13} /></button>
                  </>
                ) : (
                  <>
                    <div style={{ flex: 1, minWidth: 0, color: visible ? 'var(--text-primary)' : 'var(--text-faint)' }}>
                      <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 500 }}>{t.name}</div>
                      <div style={{ fontSize: 10, color: 'var(--text-faint)' }}>
                        {t.point_count.toLocaleString()} pts · {formatKm(t.distance_m)}
                      </div>
                    </div>
                    <button
                      type="button" title="Rename"
                      onClick={() => { setRenamingId(t.id); setRenameDraft(t.name) }}
                      style={iconBtn}
                    >
                      <Pencil size={12} />
                    </button>
                    <button
                      type="button" title="Delete"
                      onClick={() => { if (confirm(`Delete track "${t.name}"?`)) void onDelete(t.id) }}
                      style={{ ...iconBtn, color: '#dc2626' }}
                    >
                      <Trash2 size={12} />
                    </button>
                  </>
                )}
              </div>
            )
          })}

          {error && (
            <div style={{
              margin: '6px 6px 0', padding: '6px 8px', borderRadius: 6,
              background: '#fef2f2', border: '1px solid #fecaca', color: '#991b1b', fontSize: 11,
              display: 'flex', alignItems: 'center', gap: 6,
            }}>
              <X size={11} />
              <span style={{ flex: 1 }}>{error}</span>
              <button type="button" onClick={() => setError(null)} style={{ ...iconBtn, padding: 2 }}><X size={11} /></button>
            </div>
          )}

          <div style={{ borderTop: '1px solid var(--border-faint)', marginTop: 6, paddingTop: 8 }}>
            <input
              ref={fileInputRef}
              type="file"
              accept=".gpx,application/gpx+xml,application/xml,text/xml"
              style={{ display: 'none' }}
              onChange={async e => {
                const f = e.target.files?.[0]
                if (e.target) e.target.value = ''
                if (f) await handleFile(f)
              }}
            />
            <button
              type="button"
              disabled={uploading}
              onClick={() => fileInputRef.current?.click()}
              style={{
                width: '100%', padding: '8px 10px',
                background: 'var(--accent)', color: 'var(--accent-text)',
                border: 'none', borderRadius: 8, cursor: uploading ? 'wait' : 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                fontSize: 12, fontWeight: 600, fontFamily: 'inherit',
                opacity: uploading ? 0.6 : 1,
              }}
            >
              <Upload size={14} />
              {uploading ? 'Uploading…' : 'Upload .gpx file'}
            </button>
          </div>
        </div>
      )}
      <button
        type="button"
        title="GPS tracks"
        aria-label="GPS tracks"
        aria-expanded={open}
        onClick={() => setOpen(s => !s)}
        style={{
          width: 40, height: 40, borderRadius: '50%',
          background: 'var(--bg-card)',
          backdropFilter: 'blur(16px)', WebkitBackdropFilter: 'blur(16px)',
          border: '1px solid var(--border-primary)',
          boxShadow: '0 2px 12px rgba(0,0,0,0.14)',
          cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: 'var(--text-primary)',
          position: 'relative',
        }}
      >
        <Route size={18} strokeWidth={1.8} />
        {tracks.length > 0 && (
          <span style={{
            position: 'absolute', top: -2, right: -2,
            minWidth: 16, height: 16, padding: '0 4px',
            background: '#7c3aed', color: 'white',
            borderRadius: 8, fontSize: 10, fontWeight: 700,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            border: '1.5px solid var(--bg-card)',
          }}>{tracks.length}</span>
        )}
      </button>
    </div>
  )
}

const iconBtn: React.CSSProperties = {
  width: 24, height: 24, borderRadius: 6, border: 'none',
  background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  padding: 0, flexShrink: 0,
}

function formatKm(metres: number): string {
  if (!metres || metres < 1) return ''
  if (metres < 1000) return `${Math.round(metres)} m`
  return `${(metres / 1000).toFixed(1)} km`
}
