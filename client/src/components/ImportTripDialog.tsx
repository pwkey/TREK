// [460-fork] Milestone 7 slice 3 — import a previously-exported trip.
//
// Two-phase UX (matches CLAUDE.md §8.4): drop a .json / .zip file, see
// a dry-run preview ("would create 1 trip, 14 days, 87 places, 3 photo
// binaries; 5 photos missing binaries — see warnings"), then explicitly
// confirm to actually create the trip. The user is the new trip's
// owner; member rows are not restored.
import { useState } from 'react'
import { Upload, X, CheckCircle, AlertTriangle, FileWarning } from 'lucide-react'
import { tripsApi, type ImportReport } from '../api/client'

interface ImportTripDialogProps {
  onClose: () => void
  onImported: (newTripId: number) => void
}

export default function ImportTripDialog({ onClose, onImported }: ImportTripDialogProps) {
  const [file, setFile] = useState<File | null>(null)
  const [report, setReport] = useState<ImportReport | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [phase, setPhase] = useState<'pick' | 'preview'>('pick')

  const onPickFile = async (f: File) => {
    setFile(f)
    setError(null)
    setBusy(true)
    try {
      const resp = await tripsApi.importDryRun(f)
      setReport(resp.report)
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
      const resp = await tripsApi.importApply(file)
      onImported(resp.result.trip_id)
    } catch (err: unknown) {
      const ax = err as { response?: { data?: { error?: string } }; message?: string }
      setError(ax.response?.data?.error ?? ax.message ?? 'Import failed')
      setBusy(false)
    }
  }

  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{ width: '100%', maxWidth: 540, background: 'var(--bg-card)', borderRadius: 14, padding: 24, boxShadow: '0 20px 60px rgba(0,0,0,0.25)' }}
      >
        <header style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
          <Upload size={18} strokeWidth={1.8} style={{ color: 'var(--text-secondary)' }} />
          <h2 style={{ fontSize: 16, fontWeight: 700, margin: 0, color: 'var(--text-primary)', flex: 1 }}>Import a trip</h2>
          <button type="button" onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: 4 }}>
            <X size={16} />
          </button>
        </header>

        {phase === 'pick' && (
          <PickPhase onPick={onPickFile} busy={busy} error={error} />
        )}

        {phase === 'preview' && report && (
          <PreviewPhase
            report={report}
            file={file}
            busy={busy}
            error={error}
            onCancel={() => { setReport(null); setFile(null); setPhase('pick'); setError(null) }}
            onConfirm={onConfirm}
          />
        )}
      </div>
    </div>
  )
}

function PickPhase({ onPick, busy, error }: { onPick: (f: File) => void; busy: boolean; error: string | null }) {
  return (
    <>
      <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 0, marginBottom: 16, lineHeight: 1.5 }}>
        Select a <strong>.json</strong> or <strong>.zip</strong> file previously created via the Export buttons on a trip's planner. The file will create a new trip in your dashboard — no existing trips are touched.
      </p>
      <label
        onDragOver={e => e.preventDefault()}
        onDrop={e => {
          e.preventDefault()
          const f = e.dataTransfer.files?.[0]
          if (f) onPick(f)
        }}
        style={{
          display: 'block', padding: 24, borderRadius: 10,
          border: '1.5px dashed var(--border-primary)',
          textAlign: 'center', cursor: 'pointer',
          background: busy ? 'var(--bg-hover)' : 'transparent',
        }}
      >
        <input
          type="file"
          accept=".json,.zip,application/json,application/zip"
          style={{ display: 'none' }}
          disabled={busy}
          onChange={e => { const f = e.target.files?.[0]; if (f) onPick(f); if (e.target) e.target.value = '' }}
        />
        <Upload size={28} strokeWidth={1.5} style={{ color: 'var(--text-faint)', marginBottom: 8 }} />
        <div style={{ fontSize: 13, color: 'var(--text-primary)', marginBottom: 4 }}>
          {busy ? 'Reading file…' : 'Click or drop a file here'}
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

function Stat({ label, value, dim = false }: { label: string; value: number; dim?: boolean }) {
  return (
    <div style={{ padding: '6px 8px', borderRadius: 6, background: 'var(--bg-secondary)', display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
      <span style={{ fontSize: 11, color: dim ? 'var(--text-faint)' : 'var(--text-muted)' }}>{label}</span>
      <span style={{ fontSize: 13, fontWeight: 600, color: dim ? '#a16207' : 'var(--text-primary)' }}>{value}</span>
    </div>
  )
}
