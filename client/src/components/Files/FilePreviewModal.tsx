// [460-fork] Shared file preview modal.
//
// One viewer used by both the Files tab and the day view, so a day attachment
// opens IN PLACE (over the planner) instead of navigating away to the Files
// tab — closing it returns you to the day you came from.
//
// Fixes three reported bugs:
//   1. The old fallback link was hardcoded German ("PDF herunterladen").
//   2. `<object type=application/pdf>` renders blank on Android, so tapping a
//      PDF appeared to do nothing. On a coarse pointer we skip the embed and
//      show an "Open PDF" action that hands off to the browser's own viewer.
//      The open/download actions are real <a> anchors, NOT window.open() —
//      window.open('_blank') is silently blocked in an installed (standalone)
//      Android PWA, which is why the earlier fix still did nothing on the phone.
//      A user-tapped anchor is a trusted navigation the OS honours.
//   3. The old modal rendered a PDF <object> for EVERY file type; non-PDFs now
//      get a proper info panel with Download.
import { useEffect, useState } from 'react'
import ReactDOM from 'react-dom'
import { X, ExternalLink, Download, FileText } from 'lucide-react'
import { getAuthUrl } from '../../api/authUrl'
import { useTranslation } from '../../i18n'
import type { TripFile } from '../../types'

const isImage = (m?: string | null): boolean => !!m && m.startsWith('image/')
const isPdf = (m?: string | null): boolean => m === 'application/pdf'

function isCoarsePointer(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false
  return window.matchMedia('(pointer: coarse)').matches
}

interface Props {
  file: TripFile | null
  onClose: () => void
}

export default function FilePreviewModal({ file, onClose }: Props): React.ReactElement | null {
  const { t } = useTranslation()
  const [url, setUrl] = useState('')

  useEffect(() => {
    let live = true
    if (file) getAuthUrl(file.url, 'download').then((u) => { if (live) setUrl(u) })
    else setUrl('')
    return () => { live = false }
  }, [file?.url])

  useEffect(() => {
    if (!file) return
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [file, onClose])

  if (!file) return null

  const pdf = isPdf(file.mime_type)
  const img = isImage(file.mime_type)
  const coarse = isCoarsePointer()

  const linkStyle: React.CSSProperties = {
    display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: 'var(--text-muted)',
    background: 'none', border: 'none', cursor: url ? 'pointer' : 'default', padding: '4px 8px',
    borderRadius: 6, fontFamily: 'inherit', textDecoration: 'none', opacity: url ? 1 : 0.5,
  }
  const bigLinkStyle: React.CSSProperties = {
    display: 'inline-flex', alignItems: 'center', gap: 8, minHeight: 44, padding: '0 20px',
    borderRadius: 10, border: 'none', background: 'var(--accent)', color: 'var(--accent-text)',
    fontSize: 14, fontWeight: 600, cursor: url ? 'pointer' : 'default', fontFamily: 'inherit',
    textDecoration: 'none', opacity: url ? 1 : 0.6,
  }

  // Real anchors, not window.open() — see the header note. target=_blank lets
  // the OS open it (PDF viewer / browser); rel guards the opener.
  const fallback = (message: string) => (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14, padding: 24, textAlign: 'center' }}>
      <FileText size={40} strokeWidth={1.6} style={{ color: 'var(--text-faint)' }} />
      <div style={{ fontSize: 13, color: 'var(--text-muted)', maxWidth: 320 }}>{message}</div>
      <a href={url || undefined} target="_blank" rel="noopener noreferrer" style={bigLinkStyle}>
        {pdf ? <><ExternalLink size={16} /> {t('files.openPdf')}</> : <><Download size={16} /> {t('files.download')}</>}
      </a>
    </div>
  )

  return ReactDOM.createPortal(
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)', zIndex: 10000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
      onClick={onClose}
    >
      <div
        style={{ width: '100%', maxWidth: 950, height: '94vh', background: 'var(--bg-card)', borderRadius: 12, overflow: 'hidden', display: 'flex', flexDirection: 'column', boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 16px', borderBottom: '1px solid var(--border-primary)', flexShrink: 0 }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{file.original_name}</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
            <a href={url || undefined} target="_blank" rel="noopener noreferrer" style={linkStyle}
              onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.color = 'var(--text-primary)')}
              onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.color = 'var(--text-muted)')}>
              <ExternalLink size={13} /> {t('files.openTab')}
            </a>
            <button onClick={onClose}
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-faint)', display: 'flex', padding: 4, borderRadius: 6 }}
              onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--text-primary)')}
              onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--text-faint)')}>
              <X size={18} />
            </button>
          </div>
        </div>
        <div style={{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: img ? '#000' : 'var(--bg-card)' }}>
          {img && url && (
            <img src={url} alt={file.original_name} style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />
          )}
          {pdf && !coarse && url && (
            <object data={`${url}#view=FitH`} type="application/pdf" style={{ flex: 1, width: '100%', height: '100%', border: 'none' }} title={file.original_name}>
              {fallback(t('files.previewFallback'))}
            </object>
          )}
          {pdf && coarse && fallback(t('files.previewMobile'))}
          {!pdf && !img && fallback(t('files.noPreview'))}
        </div>
      </div>
    </div>,
    document.body,
  )
}
