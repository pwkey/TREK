// [460-fork] Home-screen household-invite banner.
//
// Why this exists: a household invite was only discoverable via (a) the
// notification bell — which doesn't fire if you were invited before you had an
// account, and was hidden on the mobile home screen anyway — or (b) buried in
// Settings → Account → Household. Neither is "obvious from the home screen".
//
// This banner reads the SAME `incoming` array the server already returns from
// GET /api/household (matched to the logged-in user by email), so it surfaces
// any pending invite reliably and independently of the notification pipeline.
// It renders nothing when there are no pending invites, so it has zero cost on
// the common path.
//
// Note: this mirrors the existing HouseholdSection accept/decline flow (direct
// authApi calls, hardcoded English copy) to stay consistent with the rest of
// the household UI rather than introducing a divergent pattern here.
import React, { useEffect, useState } from 'react'
import { Home, Check, X } from 'lucide-react'
import { authApi } from '../../api/client'
import { getApiErrorMessage } from '../../types'
import { useToast } from '../shared/Toast'
import type { HouseholdInviteView } from '../../types/household'

export default function IncomingInviteBanner(): React.ReactElement | null {
  const [invites, setInvites] = useState<HouseholdInviteView[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const toast = useToast()

  useEffect(() => {
    let cancelled = false
    authApi.household
      .get()
      .then(res => { if (!cancelled) setInvites(res?.incoming ?? []) })
      .catch(() => { /* offline or not reachable — just show no banner */ })
    return () => { cancelled = true }
  }, [])

  const accept = async (token: string): Promise<void> => {
    setBusy(`accept-${token}`)
    try {
      await authApi.household.invites.accept(token)
      toast.success('Joined household')
      setInvites(prev => prev.filter(i => i.token !== token))
    } catch (err: unknown) {
      toast.error(getApiErrorMessage(err, 'Failed to accept invite'))
    } finally {
      setBusy(null)
    }
  }

  const decline = async (token: string): Promise<void> => {
    setBusy(`decline-${token}`)
    try {
      await authApi.household.invites.decline(token)
      setInvites(prev => prev.filter(i => i.token !== token))
    } catch (err: unknown) {
      toast.error(getApiErrorMessage(err, 'Failed to decline invite'))
    } finally {
      setBusy(null)
    }
  }

  if (invites.length === 0) return null

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 24 }}>
      {invites.map(inv => (
        <div
          key={inv.id}
          role="status"
          style={{
            display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap',
            padding: '16px 18px', borderRadius: 16,
            background: 'var(--bg-card)',
            border: '1.5px solid var(--accent)',
            boxShadow: '0 4px 20px rgba(0,0,0,0.08)',
          }}
        >
          <div style={{
            width: 44, height: 44, borderRadius: 12, flexShrink: 0,
            background: 'var(--accent)', color: 'var(--accent-text)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <Home size={22} />
          </div>

          <div style={{ flex: 1, minWidth: 200 }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>
              You&rsquo;re invited to join {inv.household_name ? `“${inv.household_name}”` : 'a household'}
            </div>
            <div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 2, lineHeight: 1.45 }}>
              {inv.invited_by?.username ?? 'Someone'} added you to their household. Accept to share trips automatically.
              {inv.message && <span style={{ fontStyle: 'italic' }}> &ldquo;{inv.message}&rdquo;</span>}
            </div>
          </div>

          <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
            <button
              onClick={() => accept(inv.token)}
              disabled={busy === `accept-${inv.token}`}
              aria-label={`Accept invitation to join ${inv.household_name || 'household'}`}
              style={{
                display: 'flex', alignItems: 'center', gap: 6, minHeight: 44, padding: '0 18px',
                borderRadius: 12, border: 'none', cursor: 'pointer', fontSize: 14, fontWeight: 600,
                background: 'var(--accent)', color: 'var(--accent-text)', fontFamily: 'inherit',
                opacity: busy === `accept-${inv.token}` ? 0.6 : 1,
              }}
            >
              <Check size={16} /> {busy === `accept-${inv.token}` ? '…' : 'Accept'}
            </button>
            <button
              onClick={() => decline(inv.token)}
              disabled={busy === `decline-${inv.token}`}
              aria-label={`Decline invitation to join ${inv.household_name || 'household'}`}
              style={{
                display: 'flex', alignItems: 'center', gap: 6, minHeight: 44, padding: '0 16px',
                borderRadius: 12, border: '1px solid var(--border-primary)', cursor: 'pointer',
                fontSize: 14, fontWeight: 500, background: 'var(--bg-card)', color: 'var(--text-muted)',
                fontFamily: 'inherit',
              }}
            >
              <X size={16} /> Decline
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}
