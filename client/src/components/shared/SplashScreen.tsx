import { useEffect, useState } from 'react'

const STORAGE_KEY = '460-splash-shown'
const HOLD_MS = 900
const FADE_MS = 450

// Shows once per browser session on first load. Animates the 460 mark in
// from the centre outwards with a small overshoot, holds briefly, then
// fades the overlay out.
export default function SplashScreen() {
  const [visible, setVisible] = useState(() => {
    if (typeof window === 'undefined') return false
    try { return sessionStorage.getItem(STORAGE_KEY) !== '1' } catch { return true }
  })
  const [fadeOut, setFadeOut] = useState(false)

  useEffect(() => {
    if (!visible) return
    try { sessionStorage.setItem(STORAGE_KEY, '1') } catch { /* storage disabled */ }
    const fadeTimer = setTimeout(() => setFadeOut(true), HOLD_MS)
    const hideTimer = setTimeout(() => setVisible(false), HOLD_MS + FADE_MS)
    return () => { clearTimeout(fadeTimer); clearTimeout(hideTimer) }
  }, [visible])

  if (!visible) return null

  return (
    <div
      aria-hidden="true"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 99999,
        background: 'linear-gradient(180deg, #f4a85d 0%, #e88a6a 55%, #8b3a1a 100%)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        opacity: fadeOut ? 0 : 1,
        transition: `opacity ${FADE_MS}ms ease-out`,
        pointerEvents: fadeOut ? 'none' : 'auto',
      }}
    >
      <img
        src="/icons/icon.svg"
        alt=""
        style={{
          width: 'min(60vw, 340px)',
          height: 'min(60vw, 340px)',
          borderRadius: 28,
          boxShadow: '0 20px 60px rgba(90, 42, 15, 0.35)',
          animation: 'splashZoom 650ms cubic-bezier(0.2, 0.9, 0.2, 1.3) both',
          transformOrigin: 'center',
        }}
      />
      <style>{`
        @keyframes splashZoom {
          0%   { opacity: 0; transform: scale(0); }
          65%  { opacity: 1; transform: scale(1.08); }
          100% { opacity: 1; transform: scale(1); }
        }
      `}</style>
    </div>
  )
}
