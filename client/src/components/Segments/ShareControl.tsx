// [460-fork] Milestone 13 — segment document-sharing UI primitives.
//
// ShareControl: an owner-only toggle that shares a booking/file into one of the
// trip's shared segments, so the other household can see (and, for bookings,
// co-edit) it. Default-private; this is the deliberate opt-in. Renders nothing
// when the trip isn't part of any segment.
//
// SharedInBadge: a small green chip marking a record that ANOTHER household
// shared into a segment this trip is part of.
import { useState, useRef } from 'react'
import ReactDOM from 'react-dom'
import { Share2, Check, Link2 } from 'lucide-react'
import { useTranslation } from '../../i18n'
import type { SegmentSummaryForTrip } from '../../api/segments'

interface ShareControlProps {
  segments: SegmentSummaryForTrip[]
  sharedSegmentIds: string[]
  onToggle: (segmentId: string, share: boolean) => void
  /** Icon size; match the surrounding action buttons (11 in cards, 14 in lists). */
  size?: number
}

export function ShareControl({ segments, sharedSegmentIds, onToggle, size = 11 }: ShareControlProps) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState({ top: 0, left: 0 })
  const btnRef = useRef<HTMLButtonElement>(null)

  if (!segments || segments.length === 0) return null
  const active = sharedSegmentIds.length > 0

  const openMenu = () => {
    if (btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect()
      setPos({ top: rect.bottom + 4, left: rect.right })
    }
    setOpen(true)
  }

  return (
    <>
      <button
        ref={btnRef}
        onClick={(e) => { e.stopPropagation(); open ? setOpen(false) : openMenu() }}
        title={t('share.shareTooltip')}
        aria-label={t('share.shareTooltip')}
        style={{
          padding: 3, background: 'none', border: 'none', cursor: 'pointer',
          color: active ? '#0e7a5a' : 'var(--text-faint)', display: 'flex', flexShrink: 0,
        }}
        onMouseEnter={e => { if (!active) e.currentTarget.style.color = 'var(--text-primary)' }}
        onMouseLeave={e => { if (!active) e.currentTarget.style.color = 'var(--text-faint)' }}
      >
        <Share2 size={size} />
      </button>
      {open && ReactDOM.createPortal(
        <>
          <div onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 6000 }} />
          <div
            role="menu"
            style={{
              position: 'fixed', top: pos.top, left: pos.left, transform: 'translateX(-100%)',
              minWidth: 200, maxWidth: 280, zIndex: 6001,
              background: 'var(--bg-card)', border: '1px solid var(--border-primary)', borderRadius: 10,
              boxShadow: '0 10px 30px rgba(0,0,0,0.18)', padding: 6,
            }}
          >
            <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '0.04em', padding: '4px 8px 6px' }}>
              {t('share.menuTitle')}
            </div>
            {segments.map(seg => {
              const shared = sharedSegmentIds.includes(seg.id)
              return (
                <button
                  key={seg.id}
                  role="menuitemcheckbox"
                  aria-checked={shared}
                  onClick={() => onToggle(seg.id, !shared)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left',
                    padding: '7px 8px', borderRadius: 7, border: 'none', cursor: 'pointer',
                    background: shared ? 'rgba(16,185,129,0.10)' : 'transparent', fontFamily: 'inherit',
                    color: 'var(--text-primary)', fontSize: 12,
                  }}
                  onMouseEnter={e => { if (!shared) e.currentTarget.style.background = 'var(--bg-hover)' }}
                  onMouseLeave={e => { e.currentTarget.style.background = shared ? 'rgba(16,185,129,0.10)' : 'transparent' }}
                >
                  <Link2 size={12} style={{ flexShrink: 0, color: shared ? '#0e7a5a' : 'var(--text-faint)' }} />
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{seg.title}</span>
                  {shared && <Check size={14} style={{ flexShrink: 0, color: '#0e7a5a' }} />}
                </button>
              )
            })}
          </div>
        </>,
        document.body
      )}
    </>
  )
}

export function SharedInBadge({ label, tooltip }: { label: string; tooltip?: string }) {
  return (
    <span
      title={tooltip || label}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 4,
        padding: '1px 7px', borderRadius: 999,
        fontSize: 10, fontWeight: 600,
        background: 'rgba(16, 185, 129, 0.12)', color: '#0e7a5a',
        border: '1px solid rgba(16, 185, 129, 0.3)',
        whiteSpace: 'nowrap', flexShrink: 0,
      }}
    >
      <Link2 size={9} strokeWidth={2.5} />
      <span>{label}</span>
    </span>
  )
}
