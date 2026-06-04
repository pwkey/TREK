// [460-fork] Milestone 14 slice 3 — drains the photo hold-queue and folds
// uploaded photos back into the day view.
//
// Mounted once at the app root. Two jobs:
//   1. When a held photo finishes uploading (PHOTO_QUEUE_UPLOADED_EVENT), add it
//      to the day's photo list so it appears without a reload.
//   2. Auto-flush the queue when it's safe — i.e. online AND Data-saver is not
//      active — at boot, on reconnect, and whenever the Data-saver mode changes
//      (e.g. the user toggles it off, or leaves the trip's date range).
import { useEffect } from 'react'
import {
  flushPhotoQueue,
  PHOTO_QUEUE_UPLOADED_EVENT,
} from '../db/photoUploadQueue'
import { useDataSaverStore, isDataSaverActive } from '../store/dataSaverStore'
import { useTripStore } from '../store/tripStore'
import type { DayPhoto } from '../store/slices/dayPhotosSlice'

export function usePhotoQueueSync(): void {
  useEffect(() => {
    const onUploaded = (e: Event) => {
      const detail = (e as CustomEvent).detail as { dayId: number; photo: DayPhoto } | undefined
      if (detail?.photo) useTripStore.getState().ingestDayPhoto(detail.dayId, detail.photo)
    }
    window.addEventListener(PHOTO_QUEUE_UPLOADED_EVENT, onUploaded)

    const maybeFlush = () => {
      if (typeof navigator !== 'undefined' && navigator.onLine && !isDataSaverActive()) {
        void flushPhotoQueue()
      }
    }
    // Boot + reconnect.
    maybeFlush()
    window.addEventListener('online', maybeFlush)
    // Re-evaluate whenever the Data-saver mode / active-trip flag changes.
    const unsub = useDataSaverStore.subscribe(maybeFlush)

    return () => {
      window.removeEventListener(PHOTO_QUEUE_UPLOADED_EVENT, onUploaded)
      window.removeEventListener('online', maybeFlush)
      unsub()
    }
  }, [])
}
