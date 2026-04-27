// [460-fork] Milestone 5 — small status dot in the navbar.
//
// Slice 1 only renders the online/offline state. Slices 2-4 will extend this
// to show a pending-mutation count badge and a yellow conflict-pending dot.
import { useOnlineStatus } from '../../hooks/useOnlineStatus'

export default function SyncIndicator() {
  const online = useOnlineStatus()
  const tooltip = online ? 'Online — changes sync live' : 'Offline — changes will sync when you reconnect'
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
      <span style={{ display: 'none' }} className="sync-indicator-label">
        {online ? 'Online' : 'Offline'}
      </span>
    </div>
  )
}
