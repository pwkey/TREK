import { useRegisterSW } from 'virtual:pwa-register/react'
import { RefreshCw, X } from 'lucide-react'
import { useTranslation } from '../../i18n'

// [460-fork] "Update available" banner.
//
// The PWA service worker caches the app shell, so after a deploy the old build
// keeps serving until the SW updates. We switched from registerType 'autoUpdate'
// (which swapped silently and was unreliable on installed Android PWAs — they
// sat on a stale build indefinitely) to 'prompt': when a new build is detected
// we show this banner and the user taps Reload to apply it.
//
// We also force a SW update check whenever the app regains focus (plus hourly),
// so a fresh deploy surfaces within seconds of reopening the app instead of
// waiting for Chrome's ~24h service-worker revalidation.
export default function UpdatePrompt(): React.ReactElement | null {
  const { t } = useTranslation()
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(_swUrl, registration) {
      if (!registration) return
      const check = (): void => { void registration.update() }
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') check()
      })
      window.setInterval(check, 60 * 60 * 1000) // hourly backstop
    },
  })

  if (!needRefresh) return null

  return (
    <div
      role="status"
      style={{
        position: 'fixed', zIndex: 9999,
        left: 12, right: 12, margin: '0 auto', maxWidth: 420,
        bottom: 'calc(12px + env(safe-area-inset-bottom))',
        display: 'flex', alignItems: 'center', gap: 12,
        padding: '12px 14px', borderRadius: 14,
        background: 'var(--bg-card)', color: 'var(--text-primary)',
        border: '1px solid var(--border-primary)',
        boxShadow: '0 8px 30px rgba(0,0,0,0.25)',
        fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', system-ui, sans-serif",
      }}
    >
      <RefreshCw size={18} strokeWidth={2} style={{ flexShrink: 0, color: 'var(--accent)' }} aria-hidden />
      <span style={{ flex: 1, fontSize: 13, fontWeight: 500 }}>{t('update.available')}</span>
      <button
        onClick={() => {
          void updateServiceWorker(true)
          // updateServiceWorker only reloads us via workbox's "controlling"
          // event, and that event carries isUpdate=false unless a worker was
          // ALREADY controlling this page when it registered. After an install,
          // an unregister, or a hard-refresh the page starts uncontrolled — so
          // the new worker activates and nothing reloads, leaving you on the old
          // build with the banner still up. Reload ourselves as a backstop; if
          // workbox got there first this never runs.
          window.setTimeout(() => window.location.reload(), 1200)
        }}
        style={{
          flexShrink: 0, minHeight: 44, padding: '0 18px', borderRadius: 22,
          border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 600,
          background: 'var(--accent)', color: 'var(--accent-text)', fontFamily: 'inherit',
        }}
      >
        {t('update.reload')}
      </button>
      <button
        onClick={() => setNeedRefresh(false)}
        aria-label={t('update.dismiss')}
        title={t('update.dismiss')}
        style={{
          flexShrink: 0, width: 40, height: 40, borderRadius: 20,
          background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-faint)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}
      >
        <X size={16} strokeWidth={2} />
      </button>
    </div>
  )
}
