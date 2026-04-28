// [460-fork] Milestone 5 slice 4 — list and resolve queued-mutation conflicts.
import { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { AlertTriangle, Check, GitMerge, X, GitPullRequest } from 'lucide-react'
import { conflictsApi, type ConflictView, type ResolveChoice } from '../../api/conflicts'
import { useToast } from '../shared/Toast'
import { getApiErrorMessage } from '../../types'
import Section from './Section'

const TEXT_FIELDS_BY_RECORD: Record<string, string[]> = {
  day: ['notes', 'title'],
}

export default function ConflictsSection() {
  const toast = useToast()
  const [searchParams] = useSearchParams()
  const [conflicts, setConflicts] = useState<ConflictView[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [combineState, setCombineState] = useState<Record<string, Record<string, string>>>({})
  const sectionRef = useRef<HTMLDivElement | null>(null)

  const refresh = async () => {
    try {
      const r = await conflictsApi.list()
      setConflicts(r.conflicts)
    } catch (err) {
      toast.error(getApiErrorMessage(err, 'Could not load conflicts'))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void refresh() }, [])

  // When the SyncIndicator deep-links here (?tab=conflicts) scroll the section
  // into view so the user lands on it instead of the top of Settings.
  useEffect(() => {
    if (loading) return
    if (conflicts.length === 0) return
    if (searchParams.get('tab') !== 'conflicts') return
    const el = sectionRef.current
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [loading, conflicts.length, searchParams])

  const resolve = async (c: ConflictView, choice: ResolveChoice) => {
    setBusy(c.id)
    try {
      const merged = choice === 'combine' ? buildMergedPayload(c, combineState[c.id] || {}) : undefined
      await conflictsApi.resolve(c.id, choice, merged)
      toast.success(
        choice === 'mine' ? 'Your version applied' :
        choice === 'theirs' ? "Server's version kept" :
        'Combined version applied',
      )
      await refresh()
    } catch (err) {
      toast.error(getApiErrorMessage(err, 'Could not resolve conflict'))
    } finally {
      setBusy(null)
    }
  }

  if (loading) {
    return (
      <Section title="Pending sync conflicts" icon={GitPullRequest}>
        <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>Loading…</div>
      </Section>
    )
  }
  if (conflicts.length === 0) {
    return null // Don't clutter the settings page when nothing is pending.
  }

  return (
    <div ref={sectionRef}>
    <Section title="Pending sync conflicts" icon={GitPullRequest}>
      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
        {conflicts.length} change{conflicts.length === 1 ? '' : 's'} need your call — they were queued offline and the server has since moved on.
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {conflicts.map(c => {
          const textFields = TEXT_FIELDS_BY_RECORD[c.record_type] || []
          const mine = (c.mine || {}) as Record<string, unknown>
          const theirs = (c.theirs || {}) as Record<string, unknown>
          const fields = Object.keys({ ...mine, ...theirs }).filter(k => k !== 'id' && k !== 'updated_at')
          return (
            <div key={c.id} style={{ padding: 14, borderRadius: 10, border: '1px solid rgba(245, 158, 11, 0.35)', background: 'rgba(245, 158, 11, 0.06)', display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--text-muted)' }}>
                <AlertTriangle size={14} style={{ color: '#f59e0b' }} />
                <span>{c.record_type} #{c.record_id}</span>
                <span style={{ marginLeft: 'auto', fontSize: 10 }}>
                  yours: {new Date(c.observed_at).toLocaleTimeString()} · theirs: {new Date(c.server_at).toLocaleTimeString()}
                </span>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <div>
                  <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 4 }}>Yours</div>
                  {fields.map(f => (
                    <div key={f} style={{ fontSize: 12, marginBottom: 4 }}>
                      <span style={{ color: 'var(--text-muted)' }}>{f}: </span>
                      <span style={{ color: 'var(--text-primary)' }}>{formatValue(mine[f])}</span>
                    </div>
                  ))}
                </div>
                <div>
                  <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 4 }}>Server</div>
                  {fields.map(f => (
                    <div key={f} style={{ fontSize: 12, marginBottom: 4 }}>
                      <span style={{ color: 'var(--text-muted)' }}>{f}: </span>
                      <span style={{ color: 'var(--text-primary)' }}>{formatValue(theirs[f])}</span>
                    </div>
                  ))}
                </div>
              </div>

              {textFields.length > 0 && (
                <div style={{ fontSize: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <span style={{ color: 'var(--text-muted)' }}>
                    Combine — edit before applying. The Combine button below uses these values.
                  </span>
                  {textFields.map(f => {
                    const value = combineState[c.id]?.[f] ?? mergeText(mine[f], theirs[f])
                    return (
                      <label key={f} style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{f}</span>
                        <textarea
                          value={value}
                          onChange={e => setCombineState(s => ({ ...s, [c.id]: { ...(s[c.id] || {}), [f]: e.target.value } }))}
                          rows={3}
                          style={{ padding: 8, borderRadius: 8, border: '1px solid var(--border-primary)', background: 'var(--bg-input)', color: 'var(--text-primary)', fontSize: 12, fontFamily: 'inherit' }}
                        />
                      </label>
                    )
                  })}
                </div>
              )}

              <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                <button
                  type="button"
                  onClick={() => resolve(c, 'theirs')}
                  disabled={busy === c.id}
                  style={btnSecondaryStyle}
                >
                  <X size={11} /> Take theirs
                </button>
                {textFields.length > 0 && (
                  <button
                    type="button"
                    onClick={() => resolve(c, 'combine')}
                    disabled={busy === c.id}
                    style={btnSecondaryStyle}
                  >
                    <GitMerge size={11} /> Combine
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => resolve(c, 'mine')}
                  disabled={busy === c.id}
                  style={btnPrimaryStyle}
                >
                  <Check size={11} /> Keep mine
                </button>
              </div>
            </div>
          )
        })}
      </div>
    </Section>
    </div>
  )
}

function formatValue(v: unknown): string {
  if (v === null || v === undefined) return '—'
  if (typeof v === 'string') return v.length > 80 ? v.slice(0, 80) + '…' : v
  return JSON.stringify(v)
}

function mergeText(mine: unknown, theirs: unknown): string {
  const a = typeof mine === 'string' ? mine : ''
  const b = typeof theirs === 'string' ? theirs : ''
  if (!a) return b
  if (!b) return a
  return `${a}\n---\n${b}`
}

function buildMergedPayload(c: ConflictView, edited: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(edited)) out[k] = v
  // Backfill any text fields the user didn't touch with the auto-merged default.
  const textFields = TEXT_FIELDS_BY_RECORD[c.record_type] || []
  for (const f of textFields) {
    if (out[f] === undefined) out[f] = mergeText((c.mine || {})[f as keyof typeof c.mine], (c.theirs || {})[f as keyof typeof c.theirs])
  }
  return out
}

const btnSecondaryStyle: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 4,
  padding: '6px 10px', borderRadius: 6,
  border: '1px solid var(--border-primary)', background: 'var(--bg-card)',
  fontSize: 11, fontWeight: 500, color: 'var(--text-primary)',
  cursor: 'pointer', fontFamily: 'inherit',
}
const btnPrimaryStyle: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 4,
  padding: '6px 10px', borderRadius: 6,
  border: '1px solid var(--text-primary)', background: 'var(--text-primary)',
  fontSize: 11, fontWeight: 600, color: 'var(--bg-primary)',
  cursor: 'pointer', fontFamily: 'inherit',
}
