import { useEffect, useRef, useState } from 'react'
import { Upload, FileText, AlertCircle, Wand2 } from 'lucide-react'
import Modal from '../shared/Modal'
import { reservationImportsApi } from '../../api/client'
import { useToast } from '../shared/Toast'
import { useTranslation } from '../../i18n'
import { getApiErrorMessage } from '../../types'
import type { ReservationImportResponse } from '../../types/reservationImport'

type Tab = 'pdf' | 'email'

interface ReservationImportSheetProps {
  isOpen: boolean
  onClose: () => void
  tripId: string | number
  onImported: (result: ReservationImportResponse) => void
}

function genMutationId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return (crypto as Crypto).randomUUID()
  }
  return `mi-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

export default function ReservationImportSheet({ isOpen, onClose, tripId, onImported }: ReservationImportSheetProps) {
  const { t } = useTranslation()
  const toast = useToast()
  const [tab, setTab] = useState<Tab>('pdf')
  const [file, setFile] = useState<File | null>(null)
  const [emailText, setEmailText] = useState('')
  const [busy, setBusy] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Tick every second while busy so we can show "still loading the model…"-style
  // reassurances during the Ollama cold-start (~30-60s on the first request).
  useEffect(() => {
    if (!busy) { setElapsed(0); return }
    const start = Date.now()
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - start) / 1000)), 500)
    return () => clearInterval(id)
  }, [busy])

  const progressLine = (() => {
    if (!busy) return null
    if (elapsed < 5) return `Sending to extractor… (${elapsed}s)`
    if (elapsed < 15) return `Extracting… (${elapsed}s)`
    if (elapsed < 60) return `Loading model into memory — first run only, ~30-60s. (${elapsed}s)`
    if (elapsed < 120) return `Still working — large or complex PDFs take longer. (${elapsed}s)`
    return `Almost there — Ollama can take up to 3 min on a cold start. (${elapsed}s)`
  })()

  const reset = () => {
    setFile(null)
    setEmailText('')
    setError(null)
    setBusy(false)
  }

  const close = () => {
    reset()
    onClose()
  }

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    const dropped = e.dataTransfer.files?.[0]
    if (dropped) {
      if (!dropped.name.toLowerCase().endsWith('.pdf')) {
        setError('Drop a PDF file.')
        return
      }
      setFile(dropped)
      setError(null)
    }
  }

  const submit = async () => {
    setError(null)
    if (tab === 'pdf' && !file) {
      setError('Pick a PDF first.')
      return
    }
    if (tab === 'email' && !emailText.trim()) {
      setError('Paste the email text first.')
      return
    }
    setBusy(true)
    try {
      const result = (await reservationImportsApi.extract(tripId, {
        file: tab === 'pdf' ? file! : undefined,
        emailText: tab === 'email' ? emailText.trim() : undefined,
        autoAttach: tab === 'pdf',
        clientMutationId: genMutationId(),
      })) as ReservationImportResponse
      onImported(result)
      toast.success(`Imported with ${Math.round(result.confidence * 100)}% confidence`)
      close()
    } catch (err: unknown) {
      const msg = getApiErrorMessage(err, 'Extraction failed')
      setError(msg)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal isOpen={isOpen} onClose={close} title="Import from document or email" size="lg">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <p style={{ margin: 0, fontSize: 12, color: 'var(--text-muted)' }}>
          Drop a booking PDF or paste the email body, and we'll pre-fill the reservation form. You'll still review before saving.
        </p>

        <div style={{ display: 'flex', gap: 6, borderBottom: '1px solid var(--border-primary)' }}>
          {([
            { id: 'pdf' as const, label: 'Upload PDF', Icon: FileText },
            { id: 'email' as const, label: 'Paste email text', Icon: Wand2 },
          ]).map(({ id, label, Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => { setTab(id); setError(null) }}
              style={{
                display: 'flex', alignItems: 'center', gap: 6,
                padding: '8px 14px', border: 'none', background: 'none',
                fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
                color: tab === id ? 'var(--text-primary)' : 'var(--text-muted)',
                borderBottom: tab === id ? '2px solid var(--text-primary)' : '2px solid transparent',
                marginBottom: -1,
              }}
            >
              <Icon size={14} /> {label}
            </button>
          ))}
        </div>

        {tab === 'pdf' ? (
          <div
            onDrop={onDrop}
            onDragOver={e => e.preventDefault()}
            onClick={() => fileInputRef.current?.click()}
            style={{
              border: '2px dashed var(--border-primary)',
              borderRadius: 12, padding: 32, textAlign: 'center', cursor: 'pointer',
              background: 'var(--bg-card)',
              minHeight: 120, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8,
            }}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept=".pdf,application/pdf"
              style={{ display: 'none' }}
              onChange={e => { const f = e.target.files?.[0]; if (f) { setFile(f); setError(null) } }}
            />
            <Upload size={20} style={{ color: 'var(--text-muted)' }} />
            {file ? (
              <>
                <div style={{ fontSize: 13, fontWeight: 600 }}>{file.name}</div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{Math.round(file.size / 1024)} KB — click or drop to replace</div>
              </>
            ) : (
              <>
                <div style={{ fontSize: 13, fontWeight: 600 }}>Drop a PDF or click to choose</div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Text-layer PDFs work best. Max 10 MB.</div>
              </>
            )}
          </div>
        ) : (
          <textarea
            value={emailText}
            onChange={e => { setEmailText(e.target.value); setError(null) }}
            placeholder="Paste the booking confirmation email body here…"
            rows={12}
            style={{
              width: '100%', padding: 12, borderRadius: 10, border: '1px solid var(--border-primary)',
              background: 'var(--bg-input)', color: 'var(--text-primary)', fontSize: 12, fontFamily: 'ui-monospace, SFMono-Regular, monospace',
              outline: 'none', resize: 'vertical', boxSizing: 'border-box',
            }}
          />
        )}

        {error && (
          <div style={{
            display: 'flex', alignItems: 'flex-start', gap: 8,
            padding: 10, borderRadius: 8,
            background: 'rgba(239, 68, 68, 0.08)', border: '1px solid rgba(239, 68, 68, 0.3)',
            fontSize: 12, color: 'var(--text-primary)',
          }}>
            <AlertCircle size={14} style={{ marginTop: 1, color: '#ef4444', flexShrink: 0 }} />
            <div>{error}</div>
          </div>
        )}

        {busy && progressLine && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 10,
            padding: 10, borderRadius: 8,
            background: 'rgba(59, 130, 246, 0.08)', border: '1px solid rgba(59, 130, 246, 0.3)',
            fontSize: 12, color: 'var(--text-primary)',
          }}>
            <div style={{ width: 14, height: 14, border: '2px solid currentColor', borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 0.6s linear infinite', flexShrink: 0 }} />
            <div>{progressLine}</div>
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', paddingTop: 8, borderTop: '1px solid var(--border-primary)' }}>
          <button
            type="button"
            onClick={close}
            disabled={busy}
            style={{
              padding: '8px 16px', borderRadius: 8, border: '1px solid var(--border-primary)',
              background: 'var(--bg-card)', fontSize: 13, fontWeight: 500, cursor: busy ? 'default' : 'pointer',
              color: 'var(--text-primary)', fontFamily: 'inherit', opacity: busy ? 0.5 : 1,
            }}
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={busy || (tab === 'pdf' ? !file : !emailText.trim())}
            style={{
              padding: '8px 18px', borderRadius: 8, border: '1px solid var(--text-primary)',
              background: 'var(--text-primary)', fontSize: 13, fontWeight: 600,
              cursor: busy ? 'default' : 'pointer',
              color: 'var(--bg-primary)', fontFamily: 'inherit',
              opacity: (busy || (tab === 'pdf' ? !file : !emailText.trim())) ? 0.5 : 1,
              display: 'flex', alignItems: 'center', gap: 6,
            }}
          >
            {busy
              ? <div style={{ width: 12, height: 12, border: '2px solid currentColor', borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 0.6s linear infinite' }} />
              : <Wand2 size={14} />
            }
            {busy ? 'Extracting…' : 'Extract'}
          </button>
        </div>
      </div>
    </Modal>
  )
}
