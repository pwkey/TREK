// [460-fork] Milestone 14 slice 3 — "N photos waiting for Wi-Fi" chip.
//
// Shown when the photo hold-queue is non-empty. Tapping it forces an upload
// now (the "Upload now" override), regardless of Data-saver state.
import { useEffect, useState, useCallback } from 'react'
import { UploadCloud } from 'lucide-react'
import { useTranslation } from '../../i18n'
import {
  countPendingPhotos,
  flushPhotoQueue,
  PHOTO_QUEUE_CHANGED_EVENT,
} from '../../db/photoUploadQueue'

export default function PhotoQueueIndicator() {
  const { t } = useTranslation()
  const [count, setCount] = useState(0)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    try { setCount(await countPendingPhotos()) } catch { /* db not ready */ }
  }, [])

  useEffect(() => {
    void refresh()
    const onChange = () => { void refresh() }
    window.addEventListener(PHOTO_QUEUE_CHANGED_EVENT, onChange)
    return () => window.removeEventListener(PHOTO_QUEUE_CHANGED_EVENT, onChange)
  }, [refresh])

  if (count <= 0) return null

  const label = (t('photoQueue.waiting', { count: String(count) }) || `${count} photos waiting for Wi-Fi`)
  const onClick = async () => {
    if (busy) return
    setBusy(true)
    try { await flushPhotoQueue() } finally { setBusy(false); void refresh() }
  }

  return (
    <div
      title={t('photoQueue.tooltip') || 'Photos waiting for Wi-Fi — tap to upload now'}
      aria-label={label}
      role="button"
      onClick={onClick}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 5,
        padding: '4px 9px', borderRadius: 999,
        fontSize: 11, fontWeight: 600,
        color: '#a16207',
        background: 'rgba(245, 158, 11, 0.15)',
        border: '1px solid rgba(245, 158, 11, 0.35)',
        cursor: busy ? 'default' : 'pointer', userSelect: 'none',
        opacity: busy ? 0.6 : 1,
      }}
    >
      <UploadCloud size={12} strokeWidth={2.2} />
      {busy ? (t('photoQueue.uploading') || 'Uploading…') : label}
    </div>
  )
}
