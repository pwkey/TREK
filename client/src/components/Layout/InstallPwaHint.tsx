// [460-fork] M1 — Add-to-Home-Screen hint banner for iOS Safari.
//
// iOS doesn't fire a `beforeinstallprompt` event the way Chromium does,
// so the only way to nudge a user toward install is a hand-written
// instruction: tap the Share icon → Add to Home Screen.
//
// We render this hint exactly when:
//   - The browser is iOS Safari (UA sniff is the only honest test).
//   - The PWA is NOT already running standalone (`display-mode:
//     standalone` OR the legacy `navigator.standalone` flag).
//   - The user hasn't dismissed it before (localStorage).
//
// Anything else: render nothing. Android Chrome shows its own install
// banner; desktop browsers have their own URL-bar install icon.
import React, { useEffect, useState } from 'react'
import { Share, X } from 'lucide-react'

const DISMISSED_KEY = '460-install-hint-dismissed-v1'

function isIosSafari(): boolean {
  if (typeof navigator === 'undefined') return false
  const ua = navigator.userAgent
  // iPad on iPadOS reports as Mac in modern UAs — `maxTouchPoints` is
  // the giveaway. Catch both old iPad UAs and the iPadOS/Safari case.
  const isIos = /iPhone|iPod/.test(ua)
    || (/Macintosh/.test(ua) && (navigator as Navigator & { maxTouchPoints?: number }).maxTouchPoints !== undefined && (navigator as Navigator & { maxTouchPoints?: number }).maxTouchPoints! > 1)
  if (!isIos) return false
  // Exclude in-app browsers (Facebook, Instagram, etc.) — A2HS doesn't
  // work in their webviews and the hint would mislead.
  if (/FBAN|FBAV|Instagram|Line|Twitter|GSA\//.test(ua)) return false
  // Exclude Chrome on iOS — uses CriOS UA and can't install PWAs.
  if (/CriOS/.test(ua)) return false
  return true
}

function isStandalone(): boolean {
  if (typeof window === 'undefined') return false
  if (window.matchMedia?.('(display-mode: standalone)').matches) return true
  // iOS legacy flag, still the source of truth on iOS Safari.
  if ((navigator as Navigator & { standalone?: boolean }).standalone === true) return true
  return false
}

export default function InstallPwaHint(): React.ReactElement | null {
  const [show, setShow] = useState<boolean>(false)

  useEffect(() => {
    if (typeof window === 'undefined') return
    if (isStandalone()) return
    if (!isIosSafari()) return
    try {
      if (localStorage.getItem(DISMISSED_KEY) === '1') return
    } catch { /* private mode, just show it */ }
    // Slight delay so the hint doesn't compete for attention with the
    // first-paint of whatever page the user landed on.
    const t = setTimeout(() => setShow(true), 1500)
    return () => clearTimeout(t)
  }, [])

  if (!show) return null

  const dismiss = () => {
    setShow(false)
    try { localStorage.setItem(DISMISSED_KEY, '1') } catch { /* ignore */ }
  }

  return (
    <div
      role="status"
      style={{
        position: 'fixed',
        left: 12, right: 12,
        // Above iPhone home indicator + 8px breathing room.
        bottom: 'calc(12px + env(safe-area-inset-bottom, 0px))',
        zIndex: 9998,
        background: 'rgba(17, 24, 39, 0.94)',
        color: 'white',
        backdropFilter: 'blur(16px)', WebkitBackdropFilter: 'blur(16px)',
        borderRadius: 14,
        padding: '12px 14px',
        display: 'flex', alignItems: 'flex-start', gap: 10,
        boxShadow: '0 12px 32px rgba(0,0,0,0.3)',
        fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif",
        fontSize: 13,
        lineHeight: 1.4,
        animation: 'fadeUp 280ms ease-out',
      }}
    >
      <style>{`
        @keyframes fadeUp {
          from { opacity: 0; transform: translateY(10px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>
      <img src="/icons/icon-white.svg" alt="" style={{ width: 32, height: 32, flexShrink: 0, borderRadius: 8 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600, marginBottom: 2 }}>Install 460 Trip Planner</div>
        <div style={{ color: 'rgba(255,255,255,0.8)', fontSize: 12 }}>
          Tap <Share size={11} style={{ verticalAlign: '-1px', display: 'inline' }} /> Share, then{' '}
          <span style={{ fontWeight: 600 }}>Add to Home Screen</span>.
        </div>
      </div>
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss install hint"
        style={{
          flexShrink: 0,
          background: 'transparent', border: 'none', cursor: 'pointer',
          color: 'rgba(255,255,255,0.7)', padding: 4, marginRight: -4, marginTop: -2,
        }}
      >
        <X size={16} />
      </button>
    </div>
  )
}
