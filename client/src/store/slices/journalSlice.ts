// [460-fork] Milestone 6 slice 1 — per-day journal slice.
//
// Pattern mirrors dayNotesSlice (M5 verification round 2): optimistic apply
// with smart-rollback on a permanent failure, and refresh local state from
// the server's response.journal so updated_at stays current. Without that
// refresh the next online edit would send a stale If-Unmodified-Since and
// the server would 409-park it as a conflict — same trap we hit in M5.
import { journalApi } from '../../api/client'
import type { StoreApi } from 'zustand'
import type { TripStoreState } from '../tripStore'

type SetState = StoreApi<TripStoreState>['setState']
type GetState = StoreApi<TripStoreState>['getState']

export interface DayJournal {
  day_id: number
  content_markdown: string
  updated_at: string
  updated_by: number | null
}

export type DayJournalsMap = Record<string, DayJournal | null>

export interface JournalSlice {
  dayJournals: DayJournalsMap
  loadJournal: (tripId: number | string, dayId: number | string) => Promise<void>
  updateJournal: (tripId: number | string, dayId: number | string, contentMarkdown: string) => Promise<void>
  /** Setter used by remoteEventHandler when a dayJournal:updated event
   *  arrives via WebSocket. */
  setJournalFromBroadcast: (dayId: number, journal: DayJournal | null) => void
}

function isQueueableError(err: unknown): boolean {
  const status = (err as { response?: { status?: number } })?.response?.status
  return status === undefined || status >= 500 || status === 408 || status === 429
}

export const createJournalSlice = (set: SetState, get: GetState): JournalSlice => ({
  dayJournals: {},

  loadJournal: async (tripId, dayId) => {
    try {
      const result = await journalApi.get(tripId, dayId)
      set(state => ({
        dayJournals: { ...state.dayJournals, [String(dayId)]: result.journal ?? null },
      }))
    } catch {
      // Silent — falling back to whatever is already in the store (or
      // nothing). The day-detail editor surfaces "no journal yet" rendering
      // when the slot is undefined.
    }
  },

  updateJournal: async (tripId, dayId, contentMarkdown) => {
    const dayKey = String(dayId)
    const prev = get().dayJournals[dayKey] ?? null
    const observed = prev?.updated_at ?? null

    // Optimistic local apply. The day_id and updated_by are filled from the
    // server response on success; here we just stash the new content so the
    // editor reflects the user's typing immediately and offline edits
    // survive the round-trip via the M5 mutation queue.
    set(state => ({
      dayJournals: {
        ...state.dayJournals,
        [dayKey]: {
          day_id: Number(dayId),
          content_markdown: contentMarkdown,
          updated_at: prev?.updated_at ?? new Date().toISOString(),
          updated_by: prev?.updated_by ?? null,
        },
      },
    }))

    try {
      const result = await journalApi.update(tripId, dayId, contentMarkdown, observed)
      const updated = (result as { journal?: DayJournal } | undefined)?.journal
      if (updated) {
        set(state => ({
          dayJournals: { ...state.dayJournals, [dayKey]: updated },
        }))
      }
    } catch (err: unknown) {
      if (isQueueableError(err)) return
      // Roll back to whatever the server last confirmed.
      set(state => ({
        dayJournals: { ...state.dayJournals, [dayKey]: prev },
      }))
      throw err
    }
  },

  setJournalFromBroadcast: (dayId, journal) => {
    set(state => ({
      dayJournals: { ...state.dayJournals, [String(dayId)]: journal },
    }))
  },
})
