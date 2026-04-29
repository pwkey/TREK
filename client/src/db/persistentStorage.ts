// [460-fork] M1 / Milestone 5 follow-up — request persistent storage.
//
// Asks the browser not to evict our IndexedDB / OPFS data under storage
// pressure. Free upside: browsers grant when engagement signals are
// strong (PWA installed, frequent visits) and silently no-op otherwise.
//
// On iOS Safari this is the cheapest defence against the rare-but-real
// data-loss scenario where a long-offline user with a queue of unsent
// edits has their PWA storage purged before they get back online.

export type PersistResult = 'granted' | 'denied' | 'unsupported'

let cached: PersistResult | null = null

export async function requestPersistentStorage(): Promise<PersistResult> {
  if (cached !== null) return cached
  if (typeof navigator === 'undefined' || !navigator.storage?.persist) {
    cached = 'unsupported'
    return cached
  }
  try {
    const persisted = await navigator.storage.persist()
    cached = persisted ? 'granted' : 'denied'
  } catch {
    cached = 'denied'
  }
  return cached
}

/** Best-effort estimate of how much origin storage the app is using.
 *  Returns null on browsers that don't expose `storage.estimate()`. */
export async function getStorageEstimate(): Promise<{ usage: number; quota: number } | null> {
  if (typeof navigator === 'undefined' || !navigator.storage?.estimate) return null
  try {
    const e = await navigator.storage.estimate()
    if (e.usage === undefined || e.quota === undefined) return null
    return { usage: e.usage, quota: e.quota }
  } catch {
    return null
  }
}
