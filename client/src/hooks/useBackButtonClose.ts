import { useEffect, useRef } from 'react'

// [460-fork] Make the Android / browser Back button (and back-swipe gesture)
// close an open overlay instead of navigating away from the app.
//
// Why: on Android the app installs as a standalone PWA. An overlay like the
// day-detail panel has no route of its own, so a Back press wasn't handled —
// it fell through to browser history and dumped the user on the map ("goes to
// main view"), never firing the overlay's onClose (so the return-to-Plan logic
// never ran).
//
// Pattern: push one history entry while the overlay is mounted. A Back press
// pops it and fires onClose. If the overlay is instead closed via its own UI
// (the X button), the cleanup removes the entry we pushed so history stays
// balanced. Call this from a component that only exists while the overlay is
// open (conditional render), so mount == open and unmount == closed.
export function useBackButtonClose(onClose: () => void): void {
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    if (typeof window === 'undefined') return
    let poppedByBack = false
    window.history.pushState({ __overlay: true }, '')
    const handler = (): void => {
      poppedByBack = true
      onCloseRef.current()
    }
    window.addEventListener('popstate', handler)
    return () => {
      window.removeEventListener('popstate', handler)
      // Closed via the UI, not Back: remove the entry we added so a later Back
      // press doesn't have to eat a phantom history step.
      if (!poppedByBack && (window.history.state as { __overlay?: boolean } | null)?.__overlay) {
        window.history.back()
      }
    }
  }, [])
}
