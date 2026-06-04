// [460-fork] Milestone 14 slice 2 — data-cost confirmation (logic + store).
//
// Promise-based confirm shown before data-heavy operations (photo upload,
// offline download, export bundle, backup restore). Imperative so it can be
// awaited from non-component handlers:
//
//   if (!(await confirmDataCost({ bytes, opKey: 'photoUpload' }))) return
//
// When Data-saver is active the dialog defaults to "Wait for Wi-Fi"; otherwise
// it only nags for genuinely large transfers. The threshold logic is pure and
// unit-tested. The dialog itself lives in DataCostConfirmHost.tsx (kept apart
// so this module imports no React/i18n — it stays loadable under the node test
// environment, unlike the i18n/settings import chain which touches localStorage).
import { create } from 'zustand'
import {
  useDataSaverStore,
  saveDataHint,
  computeDataSaverActive,
} from '../../store/dataSaverStore'

// Warn above 1 MB when on a metered/Data-saver connection; only above 25 MB
// otherwise, so home-Wi-Fi uploads of a photo or two stay friction-free.
export const ACTIVE_WARN_FLOOR = 1_000_000
export const ALWAYS_WARN_FLOOR = 25_000_000

/** Pure: should we interrupt this transfer with a confirm? (unit-tested) */
export function shouldWarnDataCost(
  bytes: number | null,
  active: boolean,
  inherentlyLarge = false,
): boolean {
  if (active) return inherentlyLarge || bytes === null || bytes >= ACTIVE_WARN_FLOOR
  return bytes !== null && bytes >= ALWAYS_WARN_FLOOR
}

/** Compact human size. null/Infinity render as empty (caller picks no-size copy). */
export function formatBytes(bytes: number | null): string {
  if (bytes === null || !isFinite(bytes)) return ''
  if (bytes < 1000) return `${bytes} B`
  const kb = bytes / 1000
  if (kb < 1000) return `${Math.round(kb)} KB`
  const mb = kb / 1000
  if (mb < 1000) return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`
  return `${(mb / 1000).toFixed(1)} GB`
}

export type DataCostOpKey =
  | 'photoUpload'
  | 'offlineDownload'
  | 'exportBundle'
  | 'backupRestore'

export interface DataCostRequest {
  bytes: number | null
  active: boolean
  opKey: DataCostOpKey
  resolve: (proceed: boolean) => void
}

interface DataCostStore {
  req: DataCostRequest | null
  set: (req: DataCostRequest | null) => void
}

export const useDataCostStore = create<DataCostStore>((set) => ({
  req: null,
  set: (req) => set({ req }),
}))

/**
 * Returns true if the operation should proceed. Resolves immediately (no
 * dialog) when the transfer is small enough not to warrant a warning.
 */
export function confirmDataCost(opts: {
  bytes?: number | null
  inherentlyLarge?: boolean
  opKey: DataCostOpKey
}): Promise<boolean> {
  const bytes = opts.bytes ?? null
  const s = useDataSaverStore.getState()
  const active = computeDataSaverActive(s.mode, s.withinActiveTrip, saveDataHint())
  if (!shouldWarnDataCost(bytes, active, !!opts.inherentlyLarge)) {
    return Promise.resolve(true)
  }
  return new Promise<boolean>((resolve) => {
    useDataCostStore.getState().set({ bytes, active, opKey: opts.opKey, resolve })
  })
}
