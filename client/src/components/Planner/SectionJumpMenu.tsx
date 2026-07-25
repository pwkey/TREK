// [460-fork] Quick-jump sections.
//
// A single on-demand overlay for navigating a long trip without scrolling the
// day list. Nothing is added to the list itself (the deliberate "no visual
// complexity" constraint) — this button lives in the toolbar strip and opens a
// compact index that scrolls the list to a chosen leg, then dismisses.
//
// Sections are sourced hybrid: the trip's user-named sections (days with a
// `section_label`) if any exist, otherwise auto-derived from accommodation
// stays so the menu is useful before anyone has named a thing.
import { useEffect, useMemo, useRef, useState } from 'react'
import { Bookmark } from 'lucide-react'
import { useTranslation } from '../../i18n'
import type { Day, Assignment } from '../../types'
import { deriveSections } from './sectionJump'

interface Props {
  days: Day[]
  accommodations: Assignment[]
  locale: string
  onJump: (dayId: number) => void
}

export default function SectionJumpMenu({ days, accommodations, locale, onJump }: Props) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const sections = useMemo(() => deriveSections(days, accommodations), [days, accommodations])

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const fmtDate = (iso: string | null): string => {
    if (!iso) return ''
    try {
      return new Date(iso + 'T00:00:00').toLocaleDateString(locale, { day: 'numeric', month: 'short' })
    } catch { return iso }
  }

  const jump = (dayId: number): void => {
    setOpen(false)
    onJump(dayId)
  }

  return (
    <div ref={wrapRef} style={{ position: 'relative', flexShrink: 0 }}>
      <button
        onClick={() => setOpen((o) => !o)}
        title={t('dayplan.jumpTooltip')}
        aria-label={t('dayplan.jumpTooltip')}
        aria-haspopup="menu"
        aria-expanded={open}
        style={{
          display: 'flex', alignItems: 'center', gap: 5,
          padding: '5px 10px', borderRadius: 8,
          border: '1px solid var(--border-primary)', background: 'none',
          color: 'var(--text-primary)', fontSize: 11, fontWeight: 500,
          cursor: 'pointer', fontFamily: 'inherit',
        }}
      >
        <Bookmark size={13} strokeWidth={2} />
        {t('dayplan.jump')}
      </button>
      {open && (
        <div
          role="menu"
          style={{
            position: 'absolute', top: 'calc(100% + 6px)', left: 0, zIndex: 300,
            minWidth: 200, maxWidth: 280, maxHeight: 340, overflowY: 'auto',
            background: 'var(--bg-card, white)', color: 'var(--text-primary)',
            borderRadius: 10, boxShadow: '0 8px 30px rgba(0,0,0,0.25)',
            border: '1px solid var(--border-faint, #e5e7eb)', padding: 4,
          }}
        >
          {sections.length === 0 ? (
            <div style={{ padding: '10px 12px', fontSize: 12, color: 'var(--text-faint)' }}>
              {t('dayplan.jumpEmpty')}
            </div>
          ) : (
            sections.map((s) => (
              <button
                key={s.dayId}
                role="menuitem"
                onClick={() => jump(s.dayId)}
                style={{
                  display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10,
                  width: '100%', minHeight: 44, padding: '8px 10px', borderRadius: 7,
                  background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left',
                  color: 'var(--text-primary)', fontFamily: 'inherit', fontSize: 13,
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-secondary)')}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'none')}
              >
                <span style={{ fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.label}</span>
                <span style={{ flexShrink: 0, fontSize: 11, color: 'var(--text-faint)' }}>{fmtDate(s.date)}</span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  )
}
