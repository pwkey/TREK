// [460-fork] Milestone 6 — shared <img> wrapper that fetches a short-lived
// resource token and renders the file via the authenticated download
// endpoint. Required because TREK blocks direct /uploads/files access
// (see server/src/app.ts and the project_file_serving_convention memory).
//
// Slice 2 introduced this; slice 3 (memoir mode) shares it so the read-
// only timeline can render the same thumbnails as the editor without
// duplicating the auth flow.
import { useEffect, useState } from 'react'
import { getAuthUrl } from '../../api/authUrl'

interface PhotoImgProps {
  tripId: number | string
  uploadId: number
  alt: string
  onClick?: (e: React.MouseEvent) => void
  style: React.CSSProperties
}

export default function PhotoImg({ tripId, uploadId, alt, onClick, style }: PhotoImgProps) {
  const [src, setSrc] = useState('')
  useEffect(() => {
    let cancelled = false
    const url = `/api/trips/${tripId}/files/${uploadId}/download`
    getAuthUrl(url, 'download').then(s => { if (!cancelled) setSrc(s) })
    return () => { cancelled = true }
  }, [tripId, uploadId])
  if (!src) return <div style={{ ...style, background: 'var(--bg-tertiary)' }} />
  return <img src={src} alt={alt} onClick={onClick} style={style} />
}
