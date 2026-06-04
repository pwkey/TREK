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
  /** [460-fork] M14 — 'thumb' (default, tiny server thumbnail for grids/memoir)
   *  or 'full' (original, used in the lightbox). */
  variant?: 'thumb' | 'full'
}

export default function PhotoImg({ tripId, uploadId, alt, onClick, style, variant = 'thumb' }: PhotoImgProps) {
  // [460-fork] M14 — thumbnails are tiny (~tens of KB) so they always load, even
  // on Data-saver; only the FULL image is deferred to tap-to-load on a metered
  // connection so the lightbox doesn't silently pull a big original.
  const dataSaver = useDataSaverActive()
  const { t } = useTranslation()
  const [src, setSrc] = useState('')
  const deferred = variant === 'full' && dataSaver
  const [wantLoad, setWantLoad] = useState(!deferred)

  useEffect(() => { if (!deferred) setWantLoad(true) }, [deferred])

  useEffect(() => {
    if (!wantLoad) return
    let cancelled = false
    const url = `/api/trips/${tripId}/files/${uploadId}/download${variant === 'thumb' ? '?thumb=1' : ''}`
    getAuthUrl(url, 'download').then(s => { if (!cancelled) setSrc(s) })
    return () => { cancelled = true }
  }, [wantLoad, tripId, uploadId, variant])

  if (deferred && !wantLoad) {
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
