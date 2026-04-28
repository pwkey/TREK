import { daysApi, dayNotesApi } from '../../api/client'
import type { StoreApi } from 'zustand'
import type { TripStoreState } from '../tripStore'
import type { Day, DayNote } from '../../types'
import { getApiErrorMessage } from '../../types'

type SetState = StoreApi<TripStoreState>['setState']
type GetState = StoreApi<TripStoreState>['getState']

// [460-fork] Milestone 5 — mirrors the api/client response interceptor's
// classifier. A "queueable" failure is one the offline queue will replay
// (no response, 5xx, 408, 429); we keep optimistic local state for those
// because the change WILL land. Anything else (including 409 conflict-
// parked) means the server rejected — roll back.
function isQueueableError(err: unknown): boolean {
  const status = (err as { response?: { status?: number } })?.response?.status
  return status === undefined || status >= 500 || status === 408 || status === 429
}

export interface DayNotesSlice {
  updateDayNotes: (tripId: number | string, dayId: number | string, notes: string) => Promise<void>
  updateDayTitle: (tripId: number | string, dayId: number | string, title: string) => Promise<void>
  addDayNote: (tripId: number | string, dayId: number | string, data: Partial<DayNote>) => Promise<DayNote>
  updateDayNote: (tripId: number | string, dayId: number | string, id: number, data: Partial<DayNote>) => Promise<DayNote>
  deleteDayNote: (tripId: number | string, dayId: number | string, id: number) => Promise<void>
  moveDayNote: (tripId: number | string, fromDayId: number | string, toDayId: number | string, noteId: number, sort_order?: number) => Promise<void>
}

export const createDayNotesSlice = (set: SetState, get: GetState): DayNotesSlice => ({
  updateDayNotes: async (tripId, dayId, notes) => {
    // [460-fork] Milestone 5 — optimistic local apply with smart rollback.
    // The previous shape (write-through, set state only on success) meant
    // offline edits never appeared in the UI even though the queue captured
    // them. We now apply locally first; queueable failures (network/5xx/
    // 408/429) keep the optimistic state because the queue will replay; any
    // other 4xx (including 409 conflict-parked) rolls back so local truth
    // matches server truth until the user resolves.
    //
    // On success we replace the local row with the FULL day record from the
    // response — not just the field we changed. The server's broadcast
    // suppression (X-Socket-Id) means the originating client never receives
    // its own day:updated event, so without this we'd never refresh
    // updated_at locally; the next edit would then send a stale
    // If-Unmodified-Since and the server would 409-park as a conflict.
    const dayIdNum = parseInt(String(dayId))
    const prev = get().days.find(d => d.id === dayIdNum)
    const observed = prev?.updated_at ?? null
    const prevNotes = prev?.notes ?? ''
    set(state => ({
      days: state.days.map(d => d.id === dayIdNum ? { ...d, notes } : d)
    }))
    try {
      const result = await daysApi.update(tripId, dayId, { notes }, observed)
      const updated = (result as { day?: Day } | undefined)?.day
      if (updated) {
        set(state => ({
          days: state.days.map(d => d.id === dayIdNum ? { ...d, ...updated } : d),
        }))
      }
    } catch (err: unknown) {
      if (isQueueableError(err)) return
      set(state => ({
        days: state.days.map(d => d.id === dayIdNum ? { ...d, notes: prevNotes } : d)
      }))
      throw new Error(getApiErrorMessage(err, 'Error updating notes'))
    }
  },

  updateDayTitle: async (tripId, dayId, title) => {
    const dayIdNum = parseInt(String(dayId))
    const prev = get().days.find(d => d.id === dayIdNum)
    const observed = prev?.updated_at ?? null
    const prevTitle = prev?.title ?? ''
    set(state => ({
      days: state.days.map(d => d.id === dayIdNum ? { ...d, title } : d)
    }))
    try {
      const result = await daysApi.update(tripId, dayId, { title }, observed)
      const updated = (result as { day?: Day } | undefined)?.day
      if (updated) {
        set(state => ({
          days: state.days.map(d => d.id === dayIdNum ? { ...d, ...updated } : d),
        }))
      }
    } catch (err: unknown) {
      if (isQueueableError(err)) return
      set(state => ({
        days: state.days.map(d => d.id === dayIdNum ? { ...d, title: prevTitle } : d)
      }))
      throw new Error(getApiErrorMessage(err, 'Error updating day name'))
    }
  },

  addDayNote: async (tripId, dayId, data) => {
    const tempId = Date.now() * -1
    const tempNote: DayNote = { id: tempId, day_id: dayId as number, ...data, created_at: new Date().toISOString() } as DayNote
    set(state => ({
      dayNotes: {
        ...state.dayNotes,
        [String(dayId)]: [...(state.dayNotes[String(dayId)] || []), tempNote],
      }
    }))
    try {
      const result = await dayNotesApi.create(tripId, dayId, data)
      set(state => ({
        dayNotes: {
          ...state.dayNotes,
          [String(dayId)]: (state.dayNotes[String(dayId)] || []).map(n => n.id === tempId ? result.note : n),
        }
      }))
      return result.note
    } catch (err: unknown) {
      set(state => ({
        dayNotes: {
          ...state.dayNotes,
          [String(dayId)]: (state.dayNotes[String(dayId)] || []).filter(n => n.id !== tempId),
        }
      }))
      throw new Error(getApiErrorMessage(err, 'Error adding note'))
    }
  },

  updateDayNote: async (tripId, dayId, id, data) => {
    try {
      const result = await dayNotesApi.update(tripId, dayId, id, data)
      set(state => ({
        dayNotes: {
          ...state.dayNotes,
          [String(dayId)]: (state.dayNotes[String(dayId)] || []).map(n => n.id === id ? result.note : n),
        }
      }))
      return result.note
    } catch (err: unknown) {
      throw new Error(getApiErrorMessage(err, 'Error updating note'))
    }
  },

  deleteDayNote: async (tripId, dayId, id) => {
    const prev = get().dayNotes
    set(state => ({
      dayNotes: {
        ...state.dayNotes,
        [String(dayId)]: (state.dayNotes[String(dayId)] || []).filter(n => n.id !== id),
      }
    }))
    try {
      await dayNotesApi.delete(tripId, dayId, id)
    } catch (err: unknown) {
      set({ dayNotes: prev })
      throw new Error(getApiErrorMessage(err, 'Error deleting note'))
    }
  },

  moveDayNote: async (tripId, fromDayId, toDayId, noteId, sort_order = 9999) => {
    const state = get()
    const note = (state.dayNotes[String(fromDayId)] || []).find(n => n.id === noteId)
    if (!note) return

    set(s => ({
      dayNotes: {
        ...s.dayNotes,
        [String(fromDayId)]: (s.dayNotes[String(fromDayId)] || []).filter(n => n.id !== noteId),
      }
    }))

    try {
      await dayNotesApi.delete(tripId, fromDayId, noteId)
      const result = await dayNotesApi.create(tripId, toDayId, {
        text: note.text, time: note.time, icon: note.icon, sort_order,
      })
      set(s => ({
        dayNotes: {
          ...s.dayNotes,
          [String(toDayId)]: [...(s.dayNotes[String(toDayId)] || []), result.note],
        }
      }))
    } catch (err: unknown) {
      set(s => ({
        dayNotes: {
          ...s.dayNotes,
          [String(fromDayId)]: [...(s.dayNotes[String(fromDayId)] || []), note],
        }
      }))
      throw new Error(getApiErrorMessage(err, 'Error moving note'))
    }
  },
})
