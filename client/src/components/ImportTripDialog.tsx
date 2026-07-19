// [460-fork] Milestone 7 slice 3 — import a previously-exported trip.
//
// Two-phase UX (matches CLAUDE.md §8.4): drop a .json / .zip file, see
// a dry-run preview ("would create 1 trip, 14 days, 87 places, 3 photo
// binaries; 5 photos missing binaries — see warnings"), then explicitly
// confirm to actually create the trip. The user is the new trip's
// owner; member rows are not restored.
//
// [460-fork] Milestone 15 — a second target: merge the file INTO an existing
// trip instead of creating a new one. Same two-phase flow, but the preview is a
// per-day diff and the merge is add-only (nothing existing is overwritten).
import { useEffect, useState } from 'react'
import { Upload, X, CheckCircle, AlertTriangle, FileWarning, CalendarPlus } from 'lucide-react'
import { tripsApi, type ImportReport, type MergeReport } from '../api/client'

interface ImportTripDialogProps {
  onClose: () => void
  onImported: (newTripId: number) => void
}

type Target = 'new' | 'merge'
interface TripOption { id: number; title: string }

export default function ImportTripDialog({ onClose, onImported }: ImportTripDialogProps) {
  const [file, setFile] = useState<File | null>(null)
  const [report, setReport] = useState<ImportReport | null>(null)
  const [mergeReport, setMergeReport] = useState<MergeReport | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [phase, setPhase] = useState<'pick' | 'preview'>('pick')
  const [target, setTarget] = useState<Target>('new')
  const [trips, setTrips] = useState<TripOption[]>([])
  const [targetTripId, setTargetTripId] = useState<number | ''>('')

  useEffect(() => {
    tripsApi.list()
      .then((data: unknown) => {
        const arr = (Array.isArray(data) ? data : (data as { trips?: unknown[] })?.trips ?? []) as TripOption[]
        setTrips(arr.filter(t => t && typeof t.id === 'number'))
      })
      .catch(() => { /* picker just stays empty */ })
  }, [])

  const onPickFile = async (f: File) => {
    setFile(f)
    setError(null)
    setBusy(true)
    try {
      if (target === 'merge') {
        if (!targetTripId) { setError('Choose which trip to add to first'); return }
        const resp = await tripsApi.mergeDryRun(f, targetTripId)
        setMergeReport(resp.report)
        setReport(null)
      } else {
        const resp = await tripsApi.importDryRun(f)
        setReport(resp.report)
        setMergeReport(null)
      }
      setPhase('preview')
    } catch (err: unknown) {
      const ax = err as { response?: { data?: { error?: string } }; message?: string }
      setError(ax.response?.data?.error ?? ax.message ?? 'Could not read file')
    } finally {
      setBusy(false)
    }
  }

  const onConfirm = async () => {
    if (!file) return
    setBusy(true)
    setError(null)
    try {
      if (target === 'merge' && targetTripId) {
        await tripsApi.mergeApply(file, targetTripId)
        onImported(Number(targetTripId))
      } else {
        const resp = await tripsApi.importApply(file)
        onImported(resp.result.trip_id)
      }
    } catch (err: unknown) {
      const ax = err as { response?: { data?: { error?: string } }; message?: string }
      setError(ax.response?.data?.error ?? ax.message ?? 'Import failed')
      setBusy(false)
    }
  }

  const reset = () => { setReport(null); setMergeReport(null); setFile(null); setPhase('pick'); setError(null) }

  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{ width: '100%', maxWidth: 540, maxHeight: '86vh', overflowY: 'auto', background: 'var(--bg-card)', borderRadius: 14, padding: 24, boxShadow: '0 20px 60px rgba(0,0,0,0.25)' }}
      >
        <header style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
          <Upload size={18} strokeWidth={1.8} style={{ color: 'var(--text-secondary)' }} />
          <h2 style={{ fontSize: 16, fontWeight: 700, margin: 0, color: 'var(--text-primary)', flex: 1 }}>Import a trip</h2>
          <button type="button" onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: 4 }}>
            <X size={16} />
          </button>
        </header>

        {phase === 'pick' && (
          <PickPhase
            onPick={onPickFile}
            busy={busy}
            error={error}
            target={target}
            setTarget={t => { setTarget(t); setError(null) }}
            trips={trips}
            targetTripId={targetTripId}
            setTargetTripId={setTargetTripId}
          />
        )}

        {phase === 'preview' && report && (
          <PreviewPhase report={report} file={file} busy={busy} error={error} onCancel={reset} onConfirm={onConfirm} />
        )}

        {phase === 'preview' && mergeReport && (
          <MergePreviewPhase report={mergeReport} file={file} busy={busy} error={error} onCancel={reset} onConfirm={onConfirm} />
        )}
      </div>
    </div>
  )
}

function PickPhase({
  onPick, busy, error, target, setTarget, trips, targetTripId, setTargetTripId,
}: {
  onPick: (f: File) => void
  busy: boolean
  error: string | null
  target: Target
  setTarget: (t: Target) => void
  trips: TripOption[]
  targetTripId: number | ''
  setTargetTripId: (id: number | '') => void
}) {
  const mergeBlocked = target === 'merge' && !targetTripId
  return (
    <>
      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 11, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '0.04em', fontWeight: 600, marginBottom: 6 }}>Import into</div>
        <div style={{ display: 'flex', gap: 8 }}>
          <TargetButton active={target === 'new'} onClick={() => setTarget('new')} icon={<Upload size={13} />} label="A new trip" />
          <TargetButton active={target === 'merge'} onClick={() => setTarget('merge')} icon={<CalendarPlus size={13} />} label="An existing trip" />
        </div>
        {target === 'merge' && (
          <select
            value={targetTripId}
            onChange={e => setTargetTripId(e.target.value ? Number(e.target.value) : '')}
            style={{ marginTop: 8, width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border-primary)', background: 'var(--bg-secondary)', color: 'var(--text-primary)', fontSize: 13, fontFamily: 'inherit' }}
          >
            <option value="">Choose a trip to add to…</option>
            {trips.map(t => <option key={t.id} value={t.id}>{t.title}</option>)}
          </select>
        )}
      </div>

      <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 0, marginBottom: 16, lineHeight: 1.5 }}>
        {target === 'new' ? (
          <>Select a <strong>.json</strong> or <strong>.zip</strong> file previously created via the Export buttons on a trip's planner. The file will create a new trip in your dashboard — no existing trips are touched.</>
        ) : (
          <>The file's detail is added to the days it covers, matched <strong>by date</strong>. It only ever <strong>adds</strong> — your titles, notes, journals and photos are never overwritten, and re-importing an updated file won't duplicate anything.</>
        )}
      </p>

      <label
        onDragOver={e => e.preventDefault()}
        onDrop={e => {
          e.preventDefault()
          if (mergeBlocked) return
          const f = e.dataTransfer.files?.[0]
          if (f) onPick(f)
        }}
        style={{
          display: 'block', padding: 24, borderRadius: 10,
          border: '1.5px dashed var(--border-primary)',
          textAlign: 'center', cursor: mergeBlocked ? 'not-allowed' : 'pointer',
          background: busy ? 'var(--bg-hover)' : 'transparent',
          opacity: mergeBlocked ? 0.55 : 1,
        }}
      >
        <input
          type="file"
          accept=".json,.zip,application/json,application/zip"
          style={{ display: 'none' }}
          disabled={busy || mergeBlocked}
          onChange={e => { const f = e.target.files?.[0]; if (f) onPick(f); if (e.target) e.target.value = '' }}
        />
        <Upload size={28} strokeWidth={1.5} style={{ color: 'var(--text-faint)', marginBottom: 8 }} />
        <div style={{ fontSize: 13, color: 'var(--text-primary)', marginBottom: 4 }}>
          {busy ? 'Reading file…' : mergeBlocked ? 'Choose a trip first' : 'Click or drop a file here'}
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-faint)' }}>.json (metadata only) or .zip (full archive)</div>
      </label>
      {error && (
        <div style={{ marginTop: 12, padding: 10, borderRadius: 8, background: 'rgba(239, 68, 68, 0.08)', border: '1px solid rgba(239, 68, 68, 0.3)', color: '#b91c1c', fontSize: 12 }}>
          {error}
        </div>
      )}
    </>
  )
}

function TargetButton({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        flex: 1, padding: '8px 10px', borderRadius: 8, cursor: 'pointer', fontFamily: 'inherit', fontSize: 12.5, fontWeight: active ? 600 : 400,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
        border: `1px solid ${active ? 'var(--accent)' : 'var(--border-primary)'}`,
        background: active ? 'var(--accent)' : 'transparent',
        color: active ? 'var(--accent-text)' : 'var(--text-secondary)',
      }}
    >
      {icon}{label}
    </button>
  )
}

/** [460-fork] M15 — per-day diff preview for a merge. */
function MergePreviewPhase({
  report, file, busy, error, onCancel, onConfirm,
}: {
  report: MergeReport
  file: File | null
  busy: boolean
  error: string | null
  onCancel: () => void
  onConfirm: () => void
}) {
  const t = report.totals
  const hasErrors = report.errors.length > 0
  const matched = report.days.filter(d => d.matched)
  // Updates count as work too — a patch that only rewrites existing records is
  // not "nothing to do".
  const nothingToDo =
    t.days_matched === 0 &&
    t.places_added + t.places_updated === 0 &&
    t.reservations_added + t.reservations_updated === 0 &&
    t.accommodations_added + t.accommodations_updated === 0 &&
    t.budget_items_added + t.budget_items_updated === 0 &&
    t.todo_items_added + t.todo_items_updated === 0
  return (
    <>
      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 11, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '0.04em', fontWeight: 600 }}>Adding to</div>
        <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>{report.trip_title}</div>
        <div style={{ fontSize: 11, color: 'var(--text-faint)' }}>{file?.name} · patch “{report.patch_key}”</div>
      </div>

      {matched.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 11, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '0.04em', fontWeight: 600, marginBottom: 6 }}>
            Day by day
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 190, overflowY: 'auto' }}>
            {matched.map(d => (
              <div key={d.date} style={{ display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 12, padding: '5px 8px', borderRadius: 6, background: 'var(--bg-secondary)' }}>
                <span style={{ fontWeight: 600, color: 'var(--text-primary)', minWidth: 82 }}>{d.date}</span>
                <span style={{ color: 'var(--text-muted)' }}>
                  {[
                    d.assignments_added ? `+${d.assignments_added} place${d.assignments_added === 1 ? '' : 's'}` : null,
                    d.title_set ? 'title set' : null,
                    d.notes_block === 'added' ? 'notes added' : d.notes_block === 'replaced' ? 'notes updated' : null,
                  ].filter(Boolean).join(' · ') || 'no change'}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 11, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '0.04em', fontWeight: 600, marginBottom: 6 }}>Totals</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 6, fontSize: 12 }}>
          <Stat label="days patched" value={t.days_matched} />
          {t.days_skipped > 0 && <Stat label="days not in trip" value={t.days_skipped} dim />}
          <Stat label="place slots" value={t.assignments_added} />
          {/* added and updated stay SEPARATE — on a merge, "1 reservation" is the
              difference between a new booking and one quietly rewritten. */}
          <Pair label="places" added={t.places_added} updated={t.places_updated} />
          <Pair label="reservations" added={t.reservations_added} updated={t.reservations_updated} />
          <Pair label="accommodations" added={t.accommodations_added} updated={t.accommodations_updated} />
          <Pair label="budget items" added={t.budget_items_added} updated={t.budget_items_updated} />
          <Pair label="to-dos" added={t.todo_items_added} updated={t.todo_items_updated} />
          {t.duplicates_skipped > 0 && <Stat label="duplicates skipped" value={t.duplicates_skipped} dim />}
        </div>
      </div>

      {nothingToDo && !hasErrors && (
        <div style={{ marginBottom: 12, padding: 10, borderRadius: 8, background: 'var(--bg-secondary)', fontSize: 12, color: 'var(--text-muted)' }}>
          Nothing in this file matches days in that trip — check you picked the right trip, or that the file's dates line up.
        </div>
      )}

      {report.warnings.length > 0 && (
        <div style={{ marginBottom: 12, padding: 10, borderRadius: 8, background: 'rgba(245, 158, 11, 0.08)', border: '1px solid rgba(245, 158, 11, 0.35)', fontSize: 12, color: 'var(--text-primary)', display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 600, color: '#a16207' }}>
            <AlertTriangle size={13} /> {report.warnings.length} warning{report.warnings.length === 1 ? '' : 's'}
          </div>
          <ul style={{ margin: 0, paddingLeft: 16 }}>{report.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
        </div>
      )}

      {hasErrors && (
        <div style={{ marginBottom: 12, padding: 10, borderRadius: 8, background: 'rgba(239, 68, 68, 0.08)', border: '1px solid rgba(239, 68, 68, 0.35)', fontSize: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 600, color: '#b91c1c' }}>
            <FileWarning size={13} /> Cannot merge this file
          </div>
          <ul style={{ margin: '4px 0 0 16px', padding: 0 }}>{report.errors.map((e, i) => <li key={i}>{e}</li>)}</ul>
        </div>
      )}

      {error && (
        <div style={{ marginBottom: 12, padding: 10, borderRadius: 8, background: 'rgba(239, 68, 68, 0.08)', border: '1px solid rgba(239, 68, 68, 0.3)', color: '#b91c1c', fontSize: 12 }}>
          {error}
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
        <button type="button" onClick={onCancel} disabled={busy}
          style={{ padding: '8px 16px', borderRadius: 8, border: '1px solid var(--border-primary)', background: 'transparent', color: 'var(--text-primary)', cursor: 'pointer', fontFamily: 'inherit', fontSize: 13 }}>
          Choose another file
        </button>
        <button type="button" onClick={onConfirm} disabled={busy || hasErrors}
          style={{
            padding: '8px 16px', borderRadius: 8, border: 'none',
            background: hasErrors ? 'var(--border-primary)' : 'var(--accent)',
            color: hasErrors ? 'var(--text-faint)' : 'var(--accent-text)',
            cursor: hasErrors || busy ? 'not-allowed' : 'pointer',
            fontFamily: 'inherit', fontSize: 13, fontWeight: 600,
            display: 'inline-flex', alignItems: 'center', gap: 6,
          }}>
          <CheckCircle size={13} />
          {busy ? 'Adding…' : 'Add to trip'}
        </button>
      </div>
    </>
  )
}

function PreviewPhase({
  report, file, busy, error, onCancel, onConfirm,
}: {
  report: ImportReport
  file: File | null
  busy: boolean
  error: string | null
  onCancel: () => void
  onConfirm: () => void
}) {
  const wc = report.would_create
  const hasErrors = report.errors.length > 0
  return (
    <>
      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 11, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '0.04em', fontWeight: 600 }}>Source</div>
        <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>{report.source_trip.title}</div>
        <div style={{ fontSize: 11, color: 'var(--text-faint)' }}>
          {file?.name} · {report.format} · schema v{report.schema_version}
        </div>
      </div>

      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 11, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '0.04em', fontWeight: 600, marginBottom: 6 }}>
          Would create
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 6, fontSize: 12 }}>
          <Stat label="trip" value={wc.trip} />
          <Stat label="days" value={wc.days} />
          <Stat label="places" value={wc.places} />
          <Stat label="reservations" value={wc.reservations} />
          <Stat label="journals" value={wc.journals} />
          <Stat label="photos (binary)" value={wc.photos_with_binary} />
          <Stat label="photos (metadata only)" value={wc.photos_metadata_only} dim={wc.photos_metadata_only > 0} />
          <Stat label="budget items" value={wc.budget_items} />
          <Stat label="packing" value={wc.packing_items} />
          <Stat label="todo" value={wc.todo_items} />
          <Stat label="accommodations" value={wc.accommodations} />
          {/* [460-fork] M12 — faithful off-boarding counts. Only render when
              the server reported them (older servers omit the fields). */}
          {wc.segments !== undefined && <Stat label="shared segments" value={wc.segments} />}
          {wc.reservation_files !== undefined && <Stat label="reservation files" value={wc.reservation_files} />}
          {wc.budget_splits !== undefined && <Stat label="budget splits" value={wc.budget_splits} />}
        </div>
      </div>

      {report.warnings.length > 0 && (
        <div style={{ marginBottom: 12, padding: 10, borderRadius: 8, background: 'rgba(245, 158, 11, 0.08)', border: '1px solid rgba(245, 158, 11, 0.35)', fontSize: 12, color: 'var(--text-primary)', display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 600, color: '#a16207' }}>
            <AlertTriangle size={13} /> {report.warnings.length} warning{report.warnings.length === 1 ? '' : 's'}
          </div>
          <ul style={{ margin: 0, paddingLeft: 16 }}>
            {report.warnings.map((w, i) => <li key={i}>{w}</li>)}
          </ul>
        </div>
      )}

      {hasErrors && (
        <div style={{ marginBottom: 12, padding: 10, borderRadius: 8, background: 'rgba(239, 68, 68, 0.08)', border: '1px solid rgba(239, 68, 68, 0.35)', fontSize: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 600, color: '#b91c1c' }}>
            <FileWarning size={13} /> Cannot import this file
          </div>
          <ul style={{ margin: '4px 0 0 16px', padding: 0 }}>
            {report.errors.map((e, i) => <li key={i}>{e}</li>)}
          </ul>
        </div>
      )}

      {error && (
        <div style={{ marginBottom: 12, padding: 10, borderRadius: 8, background: 'rgba(239, 68, 68, 0.08)', border: '1px solid rgba(239, 68, 68, 0.3)', color: '#b91c1c', fontSize: 12 }}>
          {error}
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          style={{ padding: '8px 16px', borderRadius: 8, border: '1px solid var(--border-primary)', background: 'transparent', color: 'var(--text-primary)', cursor: 'pointer', fontFamily: 'inherit', fontSize: 13 }}
        >
          Choose another file
        </button>
        <button
          type="button"
          onClick={onConfirm}
          disabled={busy || hasErrors}
          style={{
            padding: '8px 16px', borderRadius: 8, border: 'none',
            background: hasErrors ? 'var(--border-primary)' : 'var(--accent)',
            color: hasErrors ? 'var(--text-faint)' : 'var(--accent-text)',
            cursor: hasErrors || busy ? 'not-allowed' : 'pointer',
            fontFamily: 'inherit', fontSize: 13, fontWeight: 600,
            display: 'inline-flex', alignItems: 'center', gap: 6,
          }}
        >
          <CheckCircle size={13} />
          {busy ? 'Importing…' : 'Import'}
        </button>
      </div>
    </>
  )
}

// "<thing> added" always; "<thing> updated" only when something is being
// rewritten, so the common add-only patch doesn't grow a row of zeroes.
function Pair({ label, added, updated }: { label: string; added: number; updated: number }) {
  return (
    <>
      <Stat label={`${label} added`} value={added} />
      {updated > 0 && <Stat label={`${label} updated`} value={updated} />}
    </>
  )
}

function Stat({ label, value, dim = false }: { label: string; value: number; dim?: boolean }) {
  return (
    <div style={{ padding: '6px 8px', borderRadius: 6, background: 'var(--bg-secondary)', display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
      <span style={{ fontSize: 11, color: dim ? 'var(--text-faint)' : 'var(--text-muted)' }}>{label}</span>
      <span style={{ fontSize: 13, fontWeight: 600, color: dim ? '#a16207' : 'var(--text-primary)' }}>{value}</span>
    </div>
  )
}
