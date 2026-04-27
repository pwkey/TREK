// [460-fork] Milestone 5 — online/offline detection.
//
// Wraps navigator.onLine and the 'online'/'offline' window events. SSR-safe
// and SSR-irrelevant for our purposes (we're a SPA), but the typeof guard
// keeps the function tree-shakeable for future server-rendered surfaces.
//
// On Capacitor we also listen for the `@capacitor/network` plugin's
// 'networkStatusChange' event when it's present; this gives a more reliable
// signal than browser-level navigator.onLine on iOS/Android. Detection is
// behind a typeof guard so the web build doesn't drag the plugin in.

import { useEffect, useState } from 'react'

export function useOnlineStatus(): boolean {
  const [online, setOnline] = useState<boolean>(() =>
    typeof navigator === 'undefined' ? true : navigator.onLine,
  )

  useEffect(() => {
    if (typeof window === 'undefined') return
    const onOnline = () => setOnline(true)
    const onOffline = () => setOnline(false)
    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOffline)
    return () => {
      window.removeEventListener('online', onOnline)
      window.removeEventListener('offline', onOffline)
    }
  }, [])

  return online
}
