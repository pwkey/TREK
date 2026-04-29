// [460-fork] M6 follow-up — floating base-layer switcher for the
// trip-planner map. Click the layers button → small popover lists
// the presets from `tilePresets.ts`. Selecting one calls back to
// the parent (which persists to `settings.map_tile_url` so the
// Settings → Map tab reflects the same value).
//
// Click-outside / Escape closes the popover; option-click also
// auto-closes.
import { useEffect, useRef, useState } from 'react'
import { Layers, Check } from 'lucide-react'
import { MAP_PRESETS } from './tilePresets'

interface MapLayersControlProps {
  currentTileUrl: string
  onPick: (url: string) => void
}

export function MapLayersControl({ currentTileUrl, onPick }: MapLayersControlProps) {
  const [open, setOpen] = useState(false)
  const wrapperRef = useRef<HTMLDivElement | null>(null)

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

  return (
    <div
      ref={wrapperRef}
      style={{ position: 'absolute', right: 16, bottom: 16, zIndex: 30, fontFamily: 'inherit' }}
    >
      {open && (
        <div
          role="menu"
          style={{
            position: 'absolute', bottom: 48, right: 0,
            minWidth: 180,
            background: 'var(--bg-card)',
            backdropFilter: 'blur(16px)', WebkitBackdropFilter: 'blur(16px)',
            border: '1px solid var(--border-primary)',
            borderRadius: 12, padding: 6,
            boxShadow: '0 6px 20px rgba(0,0,0,0.18)',
          }}
        >
          {MAP_PRESETS.map(p => {
            const active = currentTileUrl === p.url
            return (
              <button
                key={p.url}
                type="button"
                role="menuitemradio"
                aria-checked={active}
                onClick={() => { onPick(p.url); setOpen(false) }}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  width: '100%', padding: '8px 10px',
                  background: active ? 'var(--accent)' : 'transparent',
                  color: active ? 'var(--accent-text)' : 'var(--text-primary)',
                  border: 'none', borderRadius: 8, cursor: 'pointer',
                  fontSize: 12, fontWeight: active ? 600 : 500,
                  fontFamily: 'inherit', textAlign: 'left',
                }}
                onMouseEnter={e => { if (!active) e.currentTarget.style.background = 'var(--bg-hover)' }}
                onMouseLeave={e => { if (!active) e.currentTarget.style.background = 'transparent' }}
              >
                <Check size={12} style={{ opacity: active ? 1 : 0, flexShrink: 0 }} />
                <span>{p.name}</span>
              </button>
            )
          })}
        </div>
      )}
      <button
        type="button"
        title="Map layers"
        aria-label="Map layers"
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
        }}
      >
        <Layers size={18} strokeWidth={1.8} />
      </button>
    </div>
  )
}
