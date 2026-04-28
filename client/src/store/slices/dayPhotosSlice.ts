// [460-fork] Milestone 6 slice 2 — per-day photo state.
//
// One map per dayId in dayPhotos. The slice owns load / upload (with
// optimistic in-flight tile rendering) / update caption / reorder /
// delete. Multipart uploads don't go through the M5 mutation queue
// today — slice 4 will add Blob staging in IndexedDB / Capacitor
// filesystem so an offline photo capture can replay later.
import { dayPhotosApi } from '../../api/client'
import type { StoreApi } from 'zustand'
import type { TripStoreState } from '../tripStore'
import { prepareForUpload, isHeic } from '../../lib/imageProcessing'

type SetState = StoreApi<TripStoreState>['setState']
type GetState = StoreApi<TripStoreState>['getState']

export interface DayPhoto {
  id: number
  day_id: number
  upload_id: number
  caption: string | null
  taken_at: string | null
  lat: number | null
  lng: number | null
  altitude: number | null
  camera: string | null
  position: number
  created_at: string
  filename: string
  original_name: string
  mime_type: string
  file_size: number
}

export type DayPhotosMap = Record<string, DayPhoto[]>

export interface DayPhotosSlice {
  dayPhotos: DayPhotosMap
  loadDayPhotos: (tripId: number | string, dayId: number | string) => Promise<void>
  uploadDayPhoto: (tripId: number | string, dayId: number | string, file: File, opts?: { caption?: string }) => Promise<DayPhoto>
  updateDayPhoto: (tripId: number | string, dayId: number | string, id: number, data: { caption?: string | null; position?: number; taken_at?: string | null }) => Promise<void>
  reorderDayPhotos: (tripId: number | string, dayId: number | string, orderedIds: number[]) => Promise<void>
  deleteDayPhoto: (tripId: number | string, dayId: number | string, id: number) => Promise<void>
  /** Setter used by remoteEventHandler when a dayPhoto:* WS event arrives. */
  setDayPhotosFromBroadcast: (dayId: number, photos: DayPhoto[]) => void
}

export const createDayPhotosSlice = (set: SetState, get: GetState): DayPhotosSlice => ({
  dayPhotos: {},

  loadDayPhotos: async (tripId, dayId) => {
    try {
      const result = await dayPhotosApi.list(tripId, dayId)
      set(state => ({
        dayPhotos: { ...state.dayPhotos, [String(dayId)]: result.photos as DayPhoto[] },
      }))
    } catch {
      // Silent — leave whatever's already in the slot.
    }
  },

  uploadDayPhoto: async (tripId, dayId, file, opts) => {
    const meta = await prepareForUpload(file)
    // POST is multipart-only; cannot ride the JSON mutation queue today.
    // The catch path surfaces a real error to the caller so the UI can
    // toast and let the user retry.
    //
    // Rename .heic / .heif filenames to .jpg since the upload bytes are
    // post-conversion JPEG. Without this, multer would persist the file
    // on disk with a .heic extension despite the JPEG content, which
    // confuses both content-type sniffers and the image renderer.
    const filename = isHeic(file) ? file.name.replace(/\.hei[cf]$/i, '.jpg') : file.name
    const result = await dayPhotosApi.upload(tripId, dayId, meta.blob, {
      caption: opts?.caption,
      takenAt: meta.takenAt ?? undefined,
      lat: meta.lat,
      lng: meta.lng,
      altitude: meta.altitude,
      camera: meta.camera,
      filename,
    })
    const photo = result.photo as DayPhoto
    set(state => ({
      dayPhotos: {
        ...state.dayPhotos,
        [String(dayId)]: [...(state.dayPhotos[String(dayId)] || []), photo],
      },
    }))
    return photo
  },

  updateDayPhoto: async (tripId, dayId, id, data) => {
    const dayKey = String(dayId)
    const list = get().dayPhotos[dayKey] || []
    const prev = list.find(p => p.id === id)
    if (!prev) return
    // Optimistic apply, full rollback on any failure (no offline queue
    // for photos in slice 2).
    set(state => ({
      dayPhotos: {
        ...state.dayPhotos,
        [dayKey]: (state.dayPhotos[dayKey] || []).map(p => p.id === id ? { ...p, ...data } as DayPhoto : p),
      },
    }))
    try {
      const result = await dayPhotosApi.update(tripId, dayId, id, data)
      const updated = result.photo as DayPhoto
      set(state => ({
        dayPhotos: {
          ...state.dayPhotos,
          [dayKey]: (state.dayPhotos[dayKey] || []).map(p => p.id === id ? updated : p),
        },
      }))
    } catch (err) {
      set(state => ({
        dayPhotos: {
          ...state.dayPhotos,
          [dayKey]: (state.dayPhotos[dayKey] || []).map(p => p.id === id ? prev : p),
        },
      }))
      throw err
    }
  },

  reorderDayPhotos: async (tripId, dayId, orderedIds) => {
    const dayKey = String(dayId)
    const prev = get().dayPhotos[dayKey] || []
    // Optimistic local reorder.
    const byId = new Map(prev.map(p => [p.id, p]))
    const reordered = orderedIds.map((id, idx) => {
      const p = byId.get(id)
      return p ? { ...p, position: idx } : null
    }).filter((p): p is DayPhoto => p !== null)
    set(state => ({ dayPhotos: { ...state.dayPhotos, [dayKey]: reordered } }))
    try {
      const result = await dayPhotosApi.reorder(tripId, dayId, orderedIds)
      set(state => ({ dayPhotos: { ...state.dayPhotos, [dayKey]: result.photos as DayPhoto[] } }))
    } catch (err) {
      set(state => ({ dayPhotos: { ...state.dayPhotos, [dayKey]: prev } }))
      throw err
    }
  },

  deleteDayPhoto: async (tripId, dayId, id) => {
    const dayKey = String(dayId)
    const prev = get().dayPhotos[dayKey] || []
    set(state => ({
      dayPhotos: {
        ...state.dayPhotos,
        [dayKey]: (state.dayPhotos[dayKey] || []).filter(p => p.id !== id),
      },
    }))
    try {
      await dayPhotosApi.delete(tripId, dayId, id)
    } catch (err) {
      set(state => ({ dayPhotos: { ...state.dayPhotos, [dayKey]: prev } }))
      throw err
    }
  },

  setDayPhotosFromBroadcast: (dayId, photos) => {
    set(state => ({
      dayPhotos: { ...state.dayPhotos, [String(dayId)]: photos },
    }))
  },
})
