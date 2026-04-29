import { create } from 'zustand'
import type { StoreApi } from 'zustand'
import { tripsApi, daysApi, placesApi, packingApi, todoApi, tagsApi, categoriesApi } from '../api/client'
import { createPlacesSlice } from './slices/placesSlice'
import { createAssignmentsSlice } from './slices/assignmentsSlice'
import { createDayNotesSlice } from './slices/dayNotesSlice'
import { createPackingSlice } from './slices/packingSlice'
import { createTodoSlice } from './slices/todoSlice'
import { createBudgetSlice } from './slices/budgetSlice'
import { createReservationsSlice } from './slices/reservationsSlice'
import { createFilesSlice } from './slices/filesSlice'
import { createJournalSlice } from './slices/journalSlice' // [460-fork] Milestone 6 slice 1
import { createDayPhotosSlice } from './slices/dayPhotosSlice' // [460-fork] Milestone 6 slice 2
import { createPhotoRouteOverridesSlice } from './slices/photoRouteOverridesSlice' // [460-fork] M6 follow-up
import { createGpxTracksSlice } from './slices/gpxTracksSlice' // [460-fork] M6 follow-up
import { handleRemoteEvent } from './slices/remoteEventHandler'
import { readTripSnapshot, writeTripSnapshot } from '../db/localDb' // [460-fork] Milestone 5
import type {
  Trip, Day, Place, Assignment, DayNote, PackingItem, TodoItem,
  Tag, Category, BudgetItem, TripFile, Reservation,
  AssignmentsMap, DayNotesMap, WebSocketEvent,
} from '../types'
import { getApiErrorMessage } from '../types'
import type { PlacesSlice } from './slices/placesSlice'
import type { AssignmentsSlice } from './slices/assignmentsSlice'
import type { DayNotesSlice } from './slices/dayNotesSlice'
import type { PackingSlice } from './slices/packingSlice'
import type { TodoSlice } from './slices/todoSlice'
import type { BudgetSlice } from './slices/budgetSlice'
import type { ReservationsSlice } from './slices/reservationsSlice'
import type { FilesSlice } from './slices/filesSlice'
import type { JournalSlice } from './slices/journalSlice' // [460-fork] Milestone 6 slice 1
import type { DayPhotosSlice } from './slices/dayPhotosSlice' // [460-fork] Milestone 6 slice 2
import type { PhotoRouteOverridesSlice } from './slices/photoRouteOverridesSlice' // [460-fork] M6 follow-up
import type { GpxTracksSlice } from './slices/gpxTracksSlice' // [460-fork] M6 follow-up

export interface TripStoreState
  extends PlacesSlice,
    AssignmentsSlice,
    DayNotesSlice,
    PackingSlice,
    TodoSlice,
    BudgetSlice,
    ReservationsSlice,
    FilesSlice,
    JournalSlice,
    DayPhotosSlice,
    PhotoRouteOverridesSlice,
    GpxTracksSlice {
  trip: Trip | null
  days: Day[]
  places: Place[]
  assignments: AssignmentsMap
  dayNotes: DayNotesMap
  packingItems: PackingItem[]
  todoItems: TodoItem[]
  tags: Tag[]
  categories: Category[]
  budgetItems: BudgetItem[]
  files: TripFile[]
  reservations: Reservation[]
  selectedDayId: number | null
  isLoading: boolean
  error: string | null

  setSelectedDay: (dayId: number | null) => void
  handleRemoteEvent: (event: WebSocketEvent) => void
  loadTrip: (tripId: number | string) => Promise<void>
  refreshDays: (tripId: number | string) => Promise<void>
  updateTrip: (tripId: number | string, data: Partial<Trip>) => Promise<Trip>
  addTag: (data: Partial<Tag>) => Promise<Tag>
  addCategory: (data: Partial<Category>) => Promise<Category>
}

export const useTripStore = create<TripStoreState>((set, get) => ({
  trip: null,
  days: [],
  places: [],
  assignments: {},
  dayNotes: {},
  packingItems: [],
  todoItems: [],
  tags: [],
  categories: [],
  budgetItems: [],
  files: [],
  reservations: [],
  selectedDayId: null,
  isLoading: false,
  error: null,

  setSelectedDay: (dayId: number | null) => set({ selectedDayId: dayId }),

  handleRemoteEvent: (event: WebSocketEvent) => handleRemoteEvent(set, event),

  loadTrip: async (tripId: number | string) => {
    set({ isLoading: true, error: null })

    // [460-fork] Milestone 5 — hydrate from the local mirror first so the
    // planner has SOMETHING to render on a cold start while the network
    // call is still in flight (or while offline). The server fetch below
    // overwrites whatever this populates whenever it eventually returns.
    // We AWAIT this so the catch path below can decide whether to swallow
    // a network failure (cache hit → user sees cached planner) or rethrow
    // (no cache → page-level toast + redirect).
    const hydrated = await hydrateFromLocalMirror(Number(tripId), set).catch(() => false)

    try {
      const [tripData, daysData, placesData, packingData, todoData, tagsData, categoriesData] = await Promise.all([
        tripsApi.get(tripId),
        daysApi.list(tripId),
        placesApi.list(tripId),
        packingApi.list(tripId),
        todoApi.list(tripId),
        tagsApi.list(),
        categoriesApi.list(),
      ])

      const assignmentsMap: AssignmentsMap = {}
      const dayNotesMap: DayNotesMap = {}
      for (const day of daysData.days) {
        assignmentsMap[String(day.id)] = day.assignments || []
        dayNotesMap[String(day.id)] = day.notes_items || []
      }

      set({
        trip: tripData.trip,
        days: daysData.days,
        places: placesData.places,
        assignments: assignmentsMap,
        dayNotes: dayNotesMap,
        packingItems: packingData.items,
        todoItems: todoData.items,
        tags: tagsData.tags,
        categories: categoriesData.categories,
        isLoading: false,
        // [460-fork] M6 follow-up — reset day-keyed maps so a previous
        // trip's photos / journals don't leak into the new one. Both
        // are keyed by dayId (not tripId), so without this they
        // accumulate across navigations and can falsely trigger the
        // batch-import duplicate check or surface stale memoir data.
        dayPhotos: {},
        dayJournals: {},
        // [460-fork] M6 follow-up — also reset waypoint overrides; they
        // are keyed by photo IDs (also not tripId), and a stale entry
        // would corrupt the new trip's route.
        photoRouteOverrides: {},
        // [460-fork] M6 follow-up — and reset uploaded GPX tracks so the
        // previous trip's recorded tracks don't leak onto the new map.
        gpxTracks: [],
      })

      // [460-fork] M6 follow-up — load overrides + GPX tracks for the
      // new trip so the photo-route layer and GpxTracksLayer both have
      // their data by the time they render.
      void (get() as TripStoreState).loadPhotoRouteOverrides(tripId).catch(() => {/* silent */})
      void (get() as TripStoreState).loadGpxTracks(tripId).catch(() => {/* silent */})

      // [460-fork] Milestone 5 — write-through to the local mirror so the
      // next cold start (or an offline reload) can hydrate from it.
      void persistTripSnapshotToMirror(tripData.trip, daysData.days, placesData.places).catch(() => {/* silent */})
    } catch (err: unknown) {
      // [460-fork] Milestone 5 — if the local mirror gave us a usable trip,
      // the network failure isn't fatal. Render the cached planner and
      // suppress the page-level redirect; mutations stay queueable while
      // offline. Without this, "Download for offline" → reload offline
      // bounces the user to /dashboard before the hydrated state shows.
      if (hydrated) {
        set({ isLoading: false })
        return
      }
      const message = err instanceof Error ? err.message : 'Unknown error'
      set({ isLoading: false, error: message })
      throw err
    }
  },

  refreshDays: async (tripId: number | string) => {
    try {
      const daysData = await daysApi.list(tripId)
      const assignmentsMap: AssignmentsMap = {}
      const dayNotesMap: DayNotesMap = {}
      for (const day of daysData.days) {
        assignmentsMap[String(day.id)] = day.assignments || []
        dayNotesMap[String(day.id)] = day.notes_items || []
      }
      set({ days: daysData.days, assignments: assignmentsMap, dayNotes: dayNotesMap })
    } catch (err: unknown) {
      console.error('Failed to refresh days:', err)
    }
  },

  updateTrip: async (tripId: number | string, data: Partial<Trip>) => {
    try {
      const result = await tripsApi.update(tripId, data)
      set({ trip: result.trip })
      const daysData = await daysApi.list(tripId)
      const assignmentsMap: AssignmentsMap = {}
      const dayNotesMap: DayNotesMap = {}
      for (const day of daysData.days) {
        assignmentsMap[String(day.id)] = day.assignments || []
        dayNotesMap[String(day.id)] = day.notes_items || []
      }
      set({ days: daysData.days, assignments: assignmentsMap, dayNotes: dayNotesMap })
      return result.trip
    } catch (err: unknown) {
      throw new Error(getApiErrorMessage(err, 'Error updating trip'))
    }
  },

  addTag: async (data: Partial<Tag>) => {
    try {
      const result = await tagsApi.create(data)
      set((state) => ({ tags: [...state.tags, result.tag] }))
      return result.tag
    } catch (err: unknown) {
      throw new Error(getApiErrorMessage(err, 'Error creating tag'))
    }
  },

  addCategory: async (data: Partial<Category>) => {
    try {
      const result = await categoriesApi.create(data)
      set((state) => ({ categories: [...state.categories, result.category] }))
      return result.category
    } catch (err: unknown) {
      throw new Error(getApiErrorMessage(err, 'Error creating category'))
    }
  },

  ...createPlacesSlice(set, get),
  ...createAssignmentsSlice(set, get),
  ...createDayNotesSlice(set, get),
  ...createPackingSlice(set, get),
  ...createTodoSlice(set, get),
  ...createBudgetSlice(set, get),
  ...createReservationsSlice(set, get),
  ...createFilesSlice(set, get),
  ...createJournalSlice(set, get),
  ...createDayPhotosSlice(set, get),
  ...createPhotoRouteOverridesSlice(set, get),
  ...createGpxTracksSlice(set),
}))

// [460-fork] Milestone 5 — local-mirror adapters --------------------------
// Slice 1 scope: read-side hydrate-on-cold-start and write-through on
// successful server fetch. Mutation queue + optimistic writes land in slice 2.

type SetTripState = (partial: Partial<TripStoreState> | ((s: TripStoreState) => Partial<TripStoreState>)) => void

async function hydrateFromLocalMirror(tripId: number, set: SetTripState): Promise<boolean> {
  const snap = await readTripSnapshot(tripId)
  if (!snap || !snap.trip) return false
  // If a fresher server response has already populated the store, don't
  // clobber it — we only fill in if `trip` is still null. Either way, we
  // return true so loadTrip knows there is local data to fall back on.
  set((s) => {
    if (s.trip && s.trip.id === tripId) return {}
    const assignmentsMap: AssignmentsMap = {}
    const dayNotesMap: DayNotesMap = {}
    for (const day of snap.days || []) {
      const id = String(day.id)
      assignmentsMap[id] = (day as any).assignments || []
      dayNotesMap[id] = (day as any).notes_items || []
    }
    return {
      trip: snap.trip as unknown as Trip,
      days: (snap.days || []) as unknown as Day[],
      places: (snap.places || []) as unknown as Place[],
      assignments: assignmentsMap,
      dayNotes: dayNotesMap,
    }
  })
  return true
}

async function persistTripSnapshotToMirror(trip: Trip, days: Day[], places: Place[]): Promise<void> {
  await writeTripSnapshot({
    trip: { ...(trip as any), id: trip.id, _updated_at: (trip as any).updated_at },
    days: days.map((d) => ({ ...(d as any), id: d.id, trip_id: d.trip_id, _updated_at: (d as any).updated_at })),
    places: places.map((p) => ({ ...(p as any), id: p.id, trip_id: (p as any).trip_id })),
  })
}
