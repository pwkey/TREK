// [460-fork] M6 follow-up — GPX tracks slice.
//
// One slice per trip's collection of uploaded GPS tracks. Used by the
// floating GpxTracksControl (upload / rename / delete) and by the
// GpxTracksLayer (render polylines).
//
// Visibility (eye toggle) is intentionally per-device — stored in
// localStorage rather than the server — so two collaborators can each
// hide/show different tracks without stepping on one another.
import { gpxTracksApi } from '../../api/client'
import type { StoreApi } from 'zustand'
import type { TripStoreState } from '../tripStore'

type SetState = StoreApi<TripStoreState>['setState']

export interface GpxTrack {
  id: number
  trip_id: number
  name: string
  points: [number, number][]
  point_count: number
  distance_m: number
  uploaded_by: number | null
  uploaded_at: string
}

export interface GpxTracksSlice {
  gpxTracks: GpxTrack[]
  loadGpxTracks: (tripId: number | string) => Promise<void>
  uploadGpxTrack: (tripId: number | string, file: File, name?: string) => Promise<GpxTrack>
  renameGpxTrack: (tripId: number | string, id: number, name: string) => Promise<void>
  deleteGpxTrack: (tripId: number | string, id: number) => Promise<void>
  /** Remote-event setters used by the WebSocket handler. */
  applyRemoteGpxTrack: (track: GpxTrack) => void
  applyRemoteGpxTrackDeleted: (id: number) => void
}

export const createGpxTracksSlice = (set: SetState): GpxTracksSlice => ({
  gpxTracks: [],

  loadGpxTracks: async (tripId) => {
    try {
      const result = await gpxTracksApi.list(tripId)
      set({ gpxTracks: (result.tracks as GpxTrack[]) ?? [] })
    } catch {
      // Network failure → leave whatever's in the store.
    }
  },

  uploadGpxTrack: async (tripId, file, name) => {
    const result = await gpxTracksApi.upload(tripId, file, name)
    const track = (result as { track: GpxTrack }).track
    set(state => ({
      gpxTracks: state.gpxTracks.some(t => t.id === track.id)
        ? state.gpxTracks.map(t => t.id === track.id ? track : t)
        : [...state.gpxTracks, track],
    }))
    return track
  },

  renameGpxTrack: async (tripId, id, name) => {
    set(state => ({
      gpxTracks: state.gpxTracks.map(t => t.id === id ? { ...t, name } : t),
    }))
    try {
      const result = await gpxTracksApi.rename(tripId, id, name)
      const updated = (result as { track?: GpxTrack } | undefined)?.track
      if (updated) {
        set(state => ({
          gpxTracks: state.gpxTracks.map(t => t.id === id ? updated : t),
        }))
      }
    } catch {
      // Rename is the kind of edit it's fine to leave optimistic — the
      // server will reconcile on the next list. We don't roll back so
      // the user's typed name doesn't disappear under them.
    }
  },

  deleteGpxTrack: async (tripId, id) => {
    const prev = (state => state)
    set(state => ({ gpxTracks: state.gpxTracks.filter(t => t.id !== id) }))
    void prev
    try {
      await gpxTracksApi.remove(tripId, id)
    } catch {
      // If the delete fails permanently the next list will restore the
      // row. Queueable failures auto-retry via the apiClient interceptor.
    }
  },

  applyRemoteGpxTrack: (track) => {
    set(state => ({
      gpxTracks: state.gpxTracks.some(t => t.id === track.id)
        ? state.gpxTracks.map(t => t.id === track.id ? track : t)
        : [...state.gpxTracks, track],
    }))
  },
  applyRemoteGpxTrackDeleted: (id) => {
    set(state => ({ gpxTracks: state.gpxTracks.filter(t => t.id !== id) }))
  },
})
