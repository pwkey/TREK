// [460-fork] Milestone 6 — shared <img> wrapper that fetches a short-lived
// resource token and renders the file via the authenticated download
// endpoint. Required because TREK blocks direct /uploads/files access
// (see server/src/app.ts and the project_file_serving_convention memory).
//
// Slice 2 introduced this; slice 3 (memoir mode) shares it so the read-
// only timeline can render the same thumbnails as the editor without
// duplicating the auth flow.
import { useEffect, useState } from 'react'
import { Download } from 'lucide-react'
import { getAuthUrl } from '../../api/authUrl'
import { useDataSaverActive } from '../../store/dataSaverStore' // [460-fork] Milestone 14
import { useTranslation } from '../../i18n' // [460-fork] Milestone 14

interface PhotoImgProps {
  tripId: number | string
  uploadId: number
  alt: string
  onClick?: (e: React.MouseEvent) => void
  style: React.CSSProperties
}

export default function PhotoImg({ tripId, uploadId, alt, onClick, style }: PhotoImgProps) {
  // [460-fork] M14 slice 4 — defer the download while Data-saver is active so
  // browsing (memoir, grids) doesn't silently pull megabytes over the eSIM.
  // The user taps to load each photo; turning Data-saver off loads them all.
  const dataSaver = useDataSaverActive()
  const { t } = useTranslation()
  const [src, setSrc] = useState('')
  const [wantLoad, setWantLoad] = useState(!dataSaver)

  useEffect(() => { if (!dataSaver) setWantLoad(true) }, [dataSaver])

  useEffect(() => {
    if (!wantLoad) return
    let cancelled = false
    const url = `/api/trips/${tripId}/files/${uploadId}/download`
    getAuthUrl(url, 'download').then(s => { if (!cancelled) setSrc(s) })
    return () => { cancelled = true }
  }, [wantLoad, tripId, uploadId])

  if (dataSaver && !wantLoad) {
    return (
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); setWantLoad(true) }}
        title={t('photoImg.tapToLoad') || 'Tap to load (Data saver on)'}
        aria-label={t('photoImg.tapToLoad') || 'Tap to load photo (Data saver on)'}
        style={{
          ...style, background: 'var(--bg-tertiary)', border: 'none', padding: 0,
          cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: 'var(--text-faint)',
        }}
      >
        <Download size={16} strokeWidth={1.8} />
      </button>
    )
  }
  if (!src) return <div style={{ ...style, background: 'var(--bg-tertiary)' }} />
  return <img src={src} alt={alt} onClick={onClick} style={style} />
}
