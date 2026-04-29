// [460-fork] M6 follow-up — per-segment photo-route waypoint overrides.
//
// The store keeps a flat map keyed by `${fromPhotoId}-${toPhotoId}`.
// PhotoRouteLayer reads it to splice waypoints into OSRM calls. Writes
// go through the offline-queue-aware apiClient (Milestone 5) so the
// optimistic local update survives an offline drag → drop and replays
// when the connection returns.
//
// On the wire the server stores per-trip rows; on the client we keep
// a single global map (loaded for the active trip). Switching trips
// clears via the load function.
import { photoRouteOverridesApi } from '../../api/client'
import type { StoreApi } from 'zustand'
import type { TripStoreState } from '../tripStore'

type SetState = StoreApi<TripStoreState>['setState']
type GetState = StoreApi<TripStoreState>['getState']

export interface PhotoRouteOverride {
  trip_id: number
  from_photo_id: number
  to_photo_id: number
  waypoints: [number, number][]
  updated_at: string
}

/** `${fromPhotoId}-${toPhotoId}` → override row. */
export type PhotoRouteOverridesMap = Record<string, PhotoRouteOverride>

export const photoRouteOverrideKey = (fromId: number, toId: number) => `${fromId}-${toId}`

function isQueueableError(err: unknown): boolean {
  const status = (err as { response?: { status?: number } })?.response?.status
  return status === undefined || status >= 500 || status === 408 || status === 429
}

export interface PhotoRouteOverridesSlice {
  photoRouteOverrides: PhotoRouteOverridesMap
  loadPhotoRouteOverrides: (tripId: number | string) => Promise<void>
  setPhotoRouteOverride: (
    tripId: number | string,
    fromPhotoId: number,
    toPhotoId: number,
    waypoints: [number, number][],
  ) => Promise<void>
  deletePhotoRouteOverride: (
    tripId: number | string,
    fromPhotoId: number,
    toPhotoId: number,
  ) => Promise<void>
  /** Setter used by remoteEventHandler when a WebSocket event arrives
   *  from another collaborator (or from this client's own broadcast on
   *  the way back). */
  applyRemotePhotoRouteOverride: (override: PhotoRouteOverride | null, fromPhotoId?: number, toPhotoId?: number) => void
}

export const createPhotoRouteOverridesSlice = (set: SetState, get: GetState): PhotoRouteOverridesSlice => ({
  photoRouteOverrides: {},

  loadPhotoRouteOverrides: async (tripId) => {
    try {
      const result = await photoRouteOverridesApi.list(tripId)
      const map: PhotoRouteOverridesMap = {}
      for (const o of result.overrides as PhotoRouteOverride[]) {
        map[photoRouteOverrideKey(o.from_photo_id, o.to_photo_id)] = o
      }
      set({ photoRouteOverrides: map })
    } catch {
      // Network failure → leave whatever's in the store. The layer
      // falls back to OSRM defaults if a segment isn't in the map.
    }
  },

  setPhotoRouteOverride: async (tripId, fromPhotoId, toPhotoId, waypoints) => {
    const key = photoRouteOverrideKey(fromPhotoId, toPhotoId)
    const prev = get().photoRouteOverrides[key] ?? null

    // Optimistic apply so the dragged waypoint sticks immediately and
    // the layer re-snaps without waiting for the server round-trip.
    set(state => ({
      photoRouteOverrides: {
        ...state.photoRouteOverrides,
        [key]: {
          trip_id: Number(tripId),
          from_photo_id: fromPhotoId,
          to_photo_id: toPhotoId,
          waypoints,
          updated_at: prev?.updated_at ?? new Date().toISOString(),
        },
      },
    }))

    try {
      const result = await photoRouteOverridesApi.upsert(tripId, fromPhotoId, toPhotoId, waypoints)
      const fresh = (result as { override?: PhotoRouteOverride } | undefined)?.override
      if (fresh) {
        set(state => ({
          photoRouteOverrides: { ...state.photoRouteOverrides, [key]: fresh },
        }))
      }
    } catch (err: unknown) {
      // Queueable failures (network down, 5xx, 408, 429) get auto-queued
      // by the apiClient interceptor — keep the optimistic state so the
      // UX matches the eventually-consistent reality.
      if (isQueueableError(err)) return
      // Permanent failure (4xx that isn't queue-worthy) → roll back.
      set(state => {
        const next = { ...state.photoRouteOverrides }
        if (prev) next[key] = prev
        else delete next[key]
        return { photoRouteOverrides: next }
      })
      throw err
    }
  },

  deletePhotoRouteOverride: async (tripId, fromPhotoId, toPhotoId) => {
    const key = photoRouteOverrideKey(fromPhotoId, toPhotoId)
    const prev = get().photoRouteOverrides[key] ?? null

    set(state => {
      const next = { ...state.photoRouteOverrides }
      delete next[key]
      return { photoRouteOverrides: next }
    })

    try {
      await photoRouteOverridesApi.remove(tripId, fromPhotoId, toPhotoId)
    } catch (err: unknown) {
      if (isQueueableError(err)) return
      // Permanent failure → restore the row we removed optimistically.
      if (prev) {
        set(state => ({
          photoRouteOverrides: { ...state.photoRouteOverrides, [key]: prev },
        }))
      }
      throw err
    }
  },

  applyRemotePhotoRouteOverride: (override, fromPhotoId, toPhotoId) => {
    set(state => {
      const next = { ...state.photoRouteOverrides }
      if (override) {
        next[photoRouteOverrideKey(override.from_photo_id, override.to_photo_id)] = override
      } else if (fromPhotoId != null && toPhotoId != null) {
        delete next[photoRouteOverrideKey(fromPhotoId, toPhotoId)]
      }
      return { photoRouteOverrides: next }
    })
  },
})
