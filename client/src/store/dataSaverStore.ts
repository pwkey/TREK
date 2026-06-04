// [460-fork] Milestone 14 slice 1 — Data-saver / metered-connection mode.
//
// A PER-DEVICE setting (localStorage, not the server-synced settingsStore):
// each device on each network wants its own state. Three modes:
//   - 'auto' (default): on while today is within one of your trips' date
//     ranges, OR when the browser reports a metered/save-data connection.
//   - 'on'  : always on.
//   - 'off' : always off.
//
// iOS Safari has no Network Information API, so the metered hint is a bonus on
// Android/desktop only; 'auto' leans on the trip-dates signal there. All
// platform reads are typeof-guarded so the module imports cleanly under the
// node test environment.

import { create } from 'zustand'
import { tripsApi } from '../api/client'

export type DataSaverMode = 'auto' | 'on' | 'off'

const LS_KEY = 'data_saver_mode'

function loadMode(): DataSaverMode {
  try {
    const v = typeof localStorage !== 'undefined' ? localStorage.getItem(LS_KEY) : null
    if (v === 'on' || v === 'off' || v === 'auto') return v
  } catch { /* private mode / no storage — fall through */ }
  return 'auto'
}

/** Local (wall-clock) YYYY-MM-DD, to compare against trip date strings. */
function todayIso(): string {
  const n = new Date()
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`
}

/** Browser metered/save-data hint. Always false where unsupported (iOS). */
export function saveDataHint(): boolean {
  try {
    const c = (navigator as unknown as { connection?: { saveData?: boolean; type?: string } })?.connection
    return !!(c && (c.saveData === true || c.type === 'cellular'))
  } catch {
    return false
  }
}

/** Pure effective-state resolver — the single source of truth, unit-tested. */
export function computeDataSaverActive(
  mode: DataSaverMode,
  withinActiveTrip: boolean,
  hint: boolean,
): boolean {
  if (mode === 'on') return true
  if (mode === 'off') return false
  return withinActiveTrip || hint
}

interface DataSaverState {
  mode: DataSaverMode
  withinActiveTrip: boolean
  setMode: (m: DataSaverMode) => void
  refreshActiveTrip: () => Promise<void>
}

export const useDataSaverStore = create<DataSaverState>((set) => ({
  mode: loadMode(),
  withinActiveTrip: false,

  setMode: (m) => {
    try {
      if (typeof localStorage !== 'undefined') localStorage.setItem(LS_KEY, m)
    } catch { /* ignore */ }
    set({ mode: m })
  },

  // Recompute whether today falls within any of the user's trips. Called at
  // app boot (when authenticated) and after trip create/edit. Failures leave
  // the previous value untouched rather than flipping the setting.
  refreshActiveTrip: async () => {
    try {
      const data = await tripsApi.list()
      const trips = ((data?.trips ?? data ?? []) as Array<{ start_date?: string | null; end_date?: string | null }>)
      const t = todayIso()
      const within = trips.some(
        (x) => !!x.start_date && !!x.end_date && x.start_date <= t && x.end_date >= t,
      )
      set({ withinActiveTrip: within })
    } catch { /* unauth / offline — keep prior value */ }
  },
}))

/** Reactive effective-state for components. */
export function useDataSaverActive(): boolean {
  return useDataSaverStore((s) => computeDataSaverActive(s.mode, s.withinActiveTrip, saveDataHint()))
}

/** Imperative effective-state for non-component code (upload handlers, flush). */
export function isDataSaverActive(): boolean {
  const s = useDataSaverStore.getState()
  return computeDataSaverActive(s.mode, s.withinActiveTrip, saveDataHint())
}
