// [460-fork] Milestone 5 slice 5 — Capacitor lifecycle bridge.
//
// On native (Capacitor wraps the React app inside an iOS/Android shell), the
// `App.resume` event fires whenever the user brings the app back to the
// foreground. That's the ideal moment to drain the mutation queue: any work
// that piled up while the app was backgrounded should sync immediately when
// the user opens the app, well before the 30 s in-page timer would tick.
//
// On web, `@capacitor/app` is not present and the import would fail. We use
// dynamic imports + a feature-detect so web builds skip the entire bridge
// and the function returns a no-op cleanup.

import { process as processQueue } from './db/mutationQueue'

let unsubscribe: (() => void) | null = null

export async function startCapacitorLifecycle(): Promise<void> {
  // Detect Capacitor at runtime; only proceed on native shells.
  const isNative = typeof window !== 'undefined' && Boolean((window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor?.isNativePlatform?.())
  if (!isNative) return

  try {
    // The dynamic-import path is wrapped in a try/catch because the package
    // may not be installed yet during M1 phase A. Once the native build
    // pipeline ships, the import will resolve normally.
    const cap = await import(/* @vite-ignore */ '@capacitor/app').catch(() => null) as
      | { App: { addListener: (event: string, handler: () => void) => Promise<{ remove: () => Promise<void> }> } }
      | null
    if (!cap?.App?.addListener) return

    // Lazy-build the transport so syncWorker.ts owns the canonical wiring.
    const { _transport } = await import('./db/syncWorker')
    const handle = await cap.App.addListener('resume', () => {
      void processQueue(_transport).catch((err) => {
        console.error('[capacitor] queue process on resume failed:', err)
      })
    })
    unsubscribe = () => { void handle.remove() }
  } catch (err) {
    console.error('[capacitor] failed to attach App.resume listener:', err)
  }
}

export function stopCapacitorLifecycle(): void {
  if (unsubscribe) {
    unsubscribe()
    unsubscribe = null
  }
}
