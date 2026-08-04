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

function statusOf(err: unknown): number | undefined {
  return (err as { response?: { status?: number } })?.response?.status
}

// [460-fork] Per-day save chain. The editor autosaves on a debounce AND flushes
// on exit, so two saves for the same day can overlap. Each carries an
// If-Unmodified-Since precondition; if the second sends the timestamp it
// observed BEFORE the first landed, the server 409s it and the later text is
// lost — exactly the "only the first portion saved" report from the trip.
// Chaining saves per day means each one reads a fresh timestamp after the
// previous has committed, so a device never conflicts with itself.
const saveChains: Record<string, Promise<void>> = {}

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

    // Optimistic local apply, immediately, so the editor reflects the user's
    // typing and offline edits survive the round-trip via the M5 mutation queue.
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

    const run = async (): Promise<void> => {
      // Read the precondition NOW (inside the chain), so it reflects the
      // timestamp from any earlier save that has already committed.
      const observed = get().dayJournals[dayKey]?.updated_at ?? null
      try {
        const result = await journalApi.update(tripId, dayId, contentMarkdown, observed)
        const updated = (result as { journal?: DayJournal } | undefined)?.journal
        if (updated) set(state => ({ dayJournals: { ...state.dayJournals, [dayKey]: updated } }))
      } catch (err: unknown) {
        if (isQueueableError(err)) return // offline → M5 queue replays it later
        if (statusOf(err) === 409) {
          // Genuine stale-write (e.g. two devices, or a residual race). The
          // editor holds the text we want to keep, so resolve last-write-wins:
          // refetch the server's current timestamp and retry once with it.
          try {
            const fresh = await journalApi.get(tripId, dayId)
            const freshObserved = (fresh as { journal?: DayJournal } | undefined)?.journal?.updated_at ?? null
            const retry = await journalApi.update(tripId, dayId, contentMarkdown, freshObserved)
            const rj = (retry as { journal?: DayJournal } | undefined)?.journal
            if (rj) set(state => ({ dayJournals: { ...state.dayJournals, [dayKey]: rj } }))
            return
          } catch {
            // Retry failed too — fall through to surface the error.
          }
        }
        // Roll back to whatever the server last confirmed, then surface.
        set(state => ({ dayJournals: { ...state.dayJournals, [dayKey]: prev } }))
        throw err
      }
    }

    // Serialize behind any in-flight save for this day (success OR failure),
    // so overlapping autosave + exit-flush can't collide into a 409.
    const chain = (saveChains[dayKey] ?? Promise.resolve()).then(run, run)
    saveChains[dayKey] = chain.catch(() => {})
    return chain
  },

  setJournalFromBroadcast: (dayId, journal) => {
    set(state => ({
      dayJournals: { ...state.dayJournals, [String(dayId)]: journal },
    }))
  },
})
