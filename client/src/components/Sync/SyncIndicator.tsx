// [460-fork] Milestone 5 — small status dot in the navbar.
//
// Slice 1 rendered the online/offline dot. Slice 2 added a pending-mutation
// count badge from the local queue. Slice 4 adds a yellow override when
// the server has parked any pending conflicts for the user to review,
// linking out to Settings → Pending conflicts.
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useOnlineStatus } from '../../hooks/useOnlineStatus'
import { count as queueCount } from '../../db/mutationQueue'
import { conflictsApi } from '../../api/conflicts'

const PENDING_POLL_INTERVAL_MS = 2_000
const CONFLICTS_POLL_INTERVAL_MS = 15_000

export default function SyncIndicator() {
  const online = useOnlineStatus()
  const navigate = useNavigate()
  const [pending, setPending] = useState<number>(0)
  const [conflicts, setConflicts] = useState<number>(0)

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

  useEffect(() => {
    let cancelled = false
    const tick = async () => {
      if (!online) return
      try {
        const r = await conflictsApi.list()
        if (!cancelled) setConflicts(r.count)
      } catch { /* unauth or network — silent */ }
    }
    void tick()
    const id = setInterval(tick, CONFLICTS_POLL_INTERVAL_MS)
    return () => { cancelled = true; clearInterval(id) }
  }, [online])

  const dotColour = conflicts > 0 ? '#f59e0b' : (online ? '#10b981' : '#ef4444')
  const dotShadow = conflicts > 0
    ? '0 0 0 2px rgba(245, 158, 11, 0.2)'
    : (online ? '0 0 0 2px rgba(16, 185, 129, 0.18)' : '0 0 0 2px rgba(239, 68, 68, 0.18)')

  const tooltip = conflicts > 0
    ? `${conflicts} pending conflict${conflicts === 1 ? '' : 's'} — click to review`
    : !online
      ? `Offline — ${pending} change${pending === 1 ? '' : 's'} queued, will sync when you reconnect`
      : pending > 0
        ? `Online — syncing ${pending} pending change${pending === 1 ? '' : 's'}`
        : 'Online — changes sync live'

  const clickable = conflicts > 0

  return (
    <div
      title={tooltip}
      aria-label={tooltip}
      onClick={clickable ? () => navigate('/settings?tab=conflicts') : undefined}
      role={clickable ? 'button' : undefined}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6,
        padding: '4px 8px', borderRadius: 999,
        fontSize: 11, fontWeight: 500,
        color: 'var(--text-muted)',
        cursor: clickable ? 'pointer' : 'default',
        userSelect: 'none',
      }}
    >
      <span
        style={{
          display: 'inline-block', width: 8, height: 8, borderRadius: '50%',
          background: dotColour,
          boxShadow: dotShadow,
        }}
      />
      {(pending > 0 || conflicts > 0) && (
        <span
          style={{
            display: 'inline-block', minWidth: 16, padding: '0 5px',
            borderRadius: 999, fontSize: 10, fontWeight: 700,
            background: conflicts > 0
              ? 'rgba(245, 158, 11, 0.15)'
              : (online ? 'rgba(16, 185, 129, 0.15)' : 'rgba(239, 68, 68, 0.15)'),
            color: conflicts > 0 ? '#a16207' : (online ? '#0e7a5a' : '#b91c1c'),
            border: conflicts > 0
              ? '1px solid rgba(245, 158, 11, 0.35)'
              : (online ? '1px solid rgba(16, 185, 129, 0.35)' : '1px solid rgba(239, 68, 68, 0.35)'),
            textAlign: 'center', lineHeight: '14px',
          }}
        >
          {conflicts > 0 ? conflicts : pending}
        </span>
      )}
    </div>
  )
}
