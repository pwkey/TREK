// [460-fork] Milestone 5 — global vitest setup. Loads fake-indexeddb's auto
// module so `indexedDB` is on globalThis from the first import.
import 'fake-indexeddb/auto'

// [460-fork] Minimal localStorage for the node environment — some stores read
// it at module load (e.g. authStore's offline-user cache, demo_mode).
if (typeof globalThis.localStorage === 'undefined') {
  const mem = new Map<string, string>()
  globalThis.localStorage = {
    getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
    setItem: (k: string, v: string) => { mem.set(k, String(v)) },
    removeItem: (k: string) => { mem.delete(k) },
    clear: () => { mem.clear() },
    key: (i: number) => Array.from(mem.keys())[i] ?? null,
    get length() { return mem.size },
  } as Storage
}
