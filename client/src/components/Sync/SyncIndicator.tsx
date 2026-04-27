// [460-fork] Milestone 5 — small status dot in the navbar.
//
// Slice 1 rendered the online/offline dot. Slice 2 adds a pending-mutation
// count badge that polls the IndexedDB queue. Slice 4 will add a yellow
// conflict-pending colour.
import { useEffect, useState } from 'react'
import { useOnlineStatus } from '../../hooks/useOnlineStatus'
import { count as queueCount } from '../../db/mutationQueue'

const PENDING_POLL_INTERVAL_MS = 2_000

export default function SyncIndicator() {
  const online = useOnlineStatus()
  const [pending, setPending] = useState<number>(0)

  useEffect(() => {
    let cancelled = false
    const tick = async () => {
      try {
        const n = await queueCount('pending')
        if (!cancelled) setPending(n)
      } catch { /* localDb not yet initialised — ignore */ }
    }
    void tick()
    const id = setInterval(tick, PENDING_POLL_INTERVAL_MS)
    return () => { cancelled = true; clearInterval(id) }
  }, [])

  const tooltip = !online
    ? `Offline — ${pending} change${pending === 1 ? '' : 's'} queued, will sync when you reconnect`
    : pending > 0
      ? `Online — syncing ${pending} pending change${pending === 1 ? '' : 's'}`
      : 'Online — changes sync live'

  return (
    <div
      title={tooltip}
      aria-label={tooltip}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6,
        padding: '4px 8px', borderRadius: 999,
        fontSize: 11, fontWeight: 500,
        color: 'var(--text-muted)',
        cursor: 'default',
        userSelect: 'none',
      }}
    >
      <span
        style={{
          display: 'inline-block', width: 8, height: 8, borderRadius: '50%',
          background: online ? '#10b981' : '#ef4444',
          boxShadow: online ? '0 0 0 2px rgba(16, 185, 129, 0.18)' : '0 0 0 2px rgba(239, 68, 68, 0.18)',
        }}
      />
      {pending > 0 && (
        <span
          style={{
            display: 'inline-block', minWidth: 16, padding: '0 5px',
            borderRadius: 999, fontSize: 10, fontWeight: 700,
            background: online ? 'rgba(16, 185, 129, 0.15)' : 'rgba(239, 68, 68, 0.15)',
            color: online ? '#0e7a5a' : '#b91c1c',
            border: online ? '1px solid rgba(16, 185, 129, 0.35)' : '1px solid rgba(239, 68, 68, 0.35)',
            textAlign: 'center', lineHeight: '14px',
          }}
        >
          {pending}
        </span>
      )}
    </div>
  )
}
