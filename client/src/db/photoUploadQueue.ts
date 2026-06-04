// [460-fork] Milestone 14 slice 3 — photo upload hold-queue.
//
// Journal photos don't ride the JSON mutation queue (uploads are multipart), so
// to honour Data-saver "wait for Wi-Fi" we persist the already-downscaled JPEG
// blob in IndexedDB and replay the upload later — surviving reloads / PWA
// restarts. Flushed manually ("Upload now"), when Data-saver turns off, or when
// the device is online and not metered.
//
// This module is store-free (no React/Zustand imports) so it stays loadable
// under the node test environment; it communicates results via window events.
import { getDb, type PendingPhotoRecord } from './localDb'
import { dayPhotosApi } from '../api/client'

export const PHOTO_QUEUE_CHANGED_EVENT = 'photoqueue:changed'
export const PHOTO_QUEUE_UPLOADED_EVENT = 'photoqueue:uploaded'

function emit(name: string, detail?: unknown): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(detail === undefined ? new Event(name) : new CustomEvent(name, { detail }))
}

function randomId(): string {
  try {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID()
  } catch { /* fall through */ }
  return `pp_${Math.random().toString(36).slice(2)}_${Date.now()}`
}

export type EnqueuePhotoInput = Omit<PendingPhotoRecord, 'id' | 'created_at'> & {
  id?: string
  created_at?: number
}

export async function enqueuePhoto(input: EnqueuePhotoInput): Promise<PendingPhotoRecord> {
  const db = await getDb()
  const record: PendingPhotoRecord = {
    id: input.id ?? randomId(),
    trip_id: input.trip_id,
    day_id: input.day_id,
    blob: input.blob,
    filename: input.filename,
    caption: input.caption,
    taken_at: input.taken_at ?? null,
    lat: input.lat ?? null,
    lng: input.lng ?? null,
    altitude: input.altitude ?? null,
    camera: input.camera ?? null,
    created_at: input.created_at ?? Date.now(),
  }
  await db.put('pendingPhotos', record)
  emit(PHOTO_QUEUE_CHANGED_EVENT)
  return record
}

export async function listPendingPhotos(): Promise<PendingPhotoRecord[]> {
  const db = await getDb()
  return db.getAll('pendingPhotos')
}

export async function countPendingPhotos(): Promise<number> {
  const db = await getDb()
  return db.count('pendingPhotos')
}

export async function removePendingPhoto(id: string): Promise<void> {
  const db = await getDb()
  await db.delete('pendingPhotos', id)
  emit(PHOTO_QUEUE_CHANGED_EVENT)
}

let flushing = false

/**
 * Upload every held photo. Stops on the first network/permission failure,
 * leaving that photo and the rest queued for a later attempt. Each successful
 * upload fires PHOTO_QUEUE_UPLOADED_EVENT so the day view can ingest it.
 */
export async function flushPhotoQueue(): Promise<{ uploaded: number; remaining: number }> {
  if (flushing) return { uploaded: 0, remaining: await countPendingPhotos() }
  flushing = true
  let uploaded = 0
  try {
    const pending = await listPendingPhotos()
    for (const p of pending) {
      try {
        const result = await dayPhotosApi.upload(p.trip_id, p.day_id, p.blob, {
          caption: p.caption,
          takenAt: p.taken_at ?? undefined,
          lat: p.lat,
          lng: p.lng,
          altitude: p.altitude,
          camera: p.camera,
          filename: p.filename,
        })
        await removePendingPhoto(p.id)
        uploaded++
        emit(PHOTO_QUEUE_UPLOADED_EVENT, { dayId: p.day_id, photo: result.photo })
      } catch {
        // Offline / server error — stop and keep the remainder queued.
        break
      }
    }
  } finally {
    flushing = false
    emit(PHOTO_QUEUE_CHANGED_EVENT)
  }
  return { uploaded, remaining: await countPendingPhotos() }
}

/** Test-only. */
export async function _clearPendingPhotosForTests(): Promise<void> {
  const db = await getDb()
  await db.clear('pendingPhotos')
}
