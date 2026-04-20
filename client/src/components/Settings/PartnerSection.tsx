import { useCallback, useEffect, useState } from 'react'
import { Heart, UserPlus, X, AlertTriangle } from 'lucide-react'
import { authApi } from '../../api/client'
import { useToast } from '../shared/Toast'
import { useTranslation } from '../../i18n'
import { getApiErrorMessage } from '../../types'
import Section from './Section'
import type { PartnerGetResponse, PartnerSnapshot, PartnerInviteView, BackfillTripsResponse } from '../../types/partner'

const MAX_MESSAGE_CHARS = 200

function genMutationId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return (crypto as Crypto).randomUUID()
  }
  return `partner-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

export default function PartnerSection() {
  const { t } = useTranslation()
  const toast = useToast()
  const [data, setData] = useState<PartnerGetResponse>({ partner: null, incoming: [], outgoing: [], backfill_done: false })
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [showUnpairConfirm, setShowUnpairConfirm] = useState(false)

  // Invite form
  const [identifier, setIdentifier] = useState('')
  const [message, setMessage] = useState('')

  const refresh = useCallback(async () => {
    try {
      const result = (await authApi.partner.get()) as PartnerGetResponse
      setData(result)
    } catch (err: unknown) {
      toast.error(getApiErrorMessage(err, 'Failed to load partner status'))
    } finally {
      setLoading(false)
    }
  }, [toast])

  useEffect(() => { refresh() }, [refresh])

  const handleSendInvite = async () => {
    const trimmed = identifier.trim()
    if (!trimmed) return
    setBusy('invite')
    try {
      await authApi.partner.invite({
        identifier: trimmed,
        message: message.trim() || undefined,
        clientMutationId: genMutationId(),
      })
      toast.success('Partner request sent')
      setIdentifier('')
      setMessage('')
      await refresh()
    } catch (err: unknown) {
      toast.error(getApiErrorMessage(err, 'Failed to send request'))
    } finally {
      setBusy(null)
    }
  }

  const handleCancel = async (inviteId: string) => {
    setBusy(`cancel-${inviteId}`)
    try {
      await authApi.partner.cancelInvite(inviteId)
      await refresh()
    } catch (err: unknown) {
      toast.error(getApiErrorMessage(err, 'Failed to cancel'))
    } finally {
      setBusy(null)
    }
  }

  const handleUnpair = async () => {
    setShowUnpairConfirm(false)
    setBusy('unpair')
    try {
      await authApi.partner.unpair()
      toast.success('Unpaired')
      await refresh()
    } catch (err: unknown) {
      toast.error(getApiErrorMessage(err, 'Failed to unpair'))
    } finally {
      setBusy(null)
    }
  }

  const handleBackfill = async () => {
    setBusy('backfill')
    try {
      const result = (await authApi.partner.backfillTrips()) as BackfillTripsResponse
      toast.success(
        result.added === 0
          ? 'Nothing to add — partner is already on all your trips.'
          : `Added partner to ${result.added} trip${result.added === 1 ? '' : 's'}.`,
      )
      await refresh()
    } catch (err: unknown) {
      toast.error(getApiErrorMessage(err, 'Backfill failed'))
    } finally {
      setBusy(null)
    }
  }

  const { partner, incoming, outgoing } = data
  const isInviting = busy === 'invite'
  const isUnpairing = busy === 'unpair'

  return (
    <>
      <Section title="Partner" icon={Heart}>
        <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: '0 0 20px', lineHeight: 1.6 }}>
          Pair with your spouse or lifelong travel partner. Paired partners are auto-added to any new trips you create, and reservations you import for both of you show as "You + partner" rather than free-text names.
        </p>

        {loading ? (
          <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
            {t('common.loading')}
          </div>
        ) : partner ? (
          <PartnerPairedView
            partner={partner}
            onUnpair={() => setShowUnpairConfirm(true)}
            unpairing={isUnpairing}
            backfillDone={data.backfill_done}
            onBackfill={handleBackfill}
            backfilling={busy === 'backfill'}
          />
        ) : (
          <PartnerUnpairedView
            incoming={incoming}
            outgoing={outgoing}
            identifier={identifier}
            setIdentifier={setIdentifier}
            message={message}
            setMessage={setMessage}
            onSendInvite={handleSendInvite}
            onCancel={handleCancel}
            sending={isInviting}
            busy={busy}
          />
        )}
      </Section>

      {showUnpairConfirm && (
        <UnpairConfirmModal
          partner={partner!}
          onCancel={() => setShowUnpairConfirm(false)}
          onConfirm={handleUnpair}
        />
      )}
    </>
  )
}

function PartnerPairedView(props: {
  partner: PartnerSnapshot
  onUnpair: () => void
  unpairing: boolean
  backfillDone: boolean
  onBackfill: () => void
  backfilling: boolean
}) {
  const { partner, onUnpair, unpairing, backfillDone, onBackfill, backfilling } = props
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: 16, borderRadius: 12, background: 'var(--bg-card)', border: '1px solid var(--border-primary)' }}>
        {partner.avatar_url ? (
          <img src={partner.avatar_url} alt={partner.username} style={{ width: 48, height: 48, borderRadius: '50%', objectFit: 'cover' }} />
        ) : (
          <div style={{ width: 48, height: 48, borderRadius: '50%', background: 'var(--border-primary)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18, fontWeight: 700, color: 'var(--text-muted)' }}>
            {partner.username.charAt(0).toUpperCase()}
          </div>
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: 6 }}>
            <Heart size={12} style={{ color: '#b8430b', fill: '#b8430b' }} /> Paired with {partner.username}
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>{partner.email}</div>
        </div>
        <button
          onClick={onUnpair}
          disabled={unpairing}
          style={{
            padding: '8px 14px', borderRadius: 8, border: '1px solid #dc2626',
            background: 'transparent', color: '#dc2626', fontSize: 12, fontWeight: 600,
            cursor: unpairing ? 'default' : 'pointer', fontFamily: 'inherit',
            opacity: unpairing ? 0.5 : 1,
          }}
        >
          {unpairing ? '…' : 'Unpair'}
        </button>
      </div>
      {!backfillDone && (
        <div style={{ padding: 14, borderRadius: 10, background: 'rgba(59, 130, 246, 0.06)', border: '1px solid rgba(59, 130, 246, 0.25)' }}>
          <div style={{ fontSize: 13, color: 'var(--text-primary)', marginBottom: 8 }}>
            New trips you create automatically add {partner.username} as a member. Want to apply this to trips you've already created too?
          </div>
          <button
            onClick={onBackfill}
            disabled={backfilling}
            style={{
              padding: '8px 14px', borderRadius: 8, border: '1px solid #b8430b',
              background: 'transparent', color: '#b8430b', fontSize: 12, fontWeight: 600,
              cursor: backfilling ? 'default' : 'pointer', fontFamily: 'inherit',
              opacity: backfilling ? 0.5 : 1,
            }}
          >
            {backfilling ? 'Adding…' : 'Apply to existing trips'}
          </button>
        </div>
      )}
    </div>
  )
}

function PartnerUnpairedView(props: {
  incoming: PartnerInviteView[]
  outgoing: PartnerInviteView[]
  identifier: string
  setIdentifier: (v: string) => void
  message: string
  setMessage: (v: string) => void
  onSendInvite: () => void
  onCancel: (id: string) => void
  sending: boolean
  busy: string | null
}) {
  const { incoming, outgoing, identifier, setIdentifier, message, setMessage, onSendInvite, onCancel, sending, busy } = props
  const hasOutgoing = outgoing.length > 0

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {incoming.length > 0 && (
        <div style={{
          padding: 14, borderRadius: 10,
          background: 'rgba(184, 67, 11, 0.06)', border: '1px solid rgba(184, 67, 11, 0.25)',
        }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 8 }}>
            Incoming partner request
          </div>
          {incoming.map(invite => (
            <div key={invite.id} style={{ fontSize: 13, color: 'var(--text-muted)' }}>
              {invite.inviter.username} ({invite.inviter.email}) wants to pair.
              {invite.message && <div style={{ marginTop: 4, fontStyle: 'italic' }}>"{invite.message}"</div>}
              <div style={{ marginTop: 8, fontSize: 11, opacity: 0.8 }}>
                Accept or decline from the notification bell at the top right.
              </div>
            </div>
          ))}
        </div>
      )}

      {hasOutgoing && (
        <div style={{
          padding: 14, borderRadius: 10,
          background: 'var(--bg-card)', border: '1px solid var(--border-primary)',
        }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 10 }}>
            Pending outgoing request
          </div>
          {outgoing.map(invite => (
            <div key={invite.id} style={{ display: 'flex', alignItems: 'center', gap: 12, fontSize: 13 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <span style={{ color: 'var(--text-primary)' }}>Waiting for </span>
                <strong>{invite.target.username}</strong>
                <span style={{ color: 'var(--text-muted)' }}> ({invite.target.email})</span>
              </div>
              <button
                onClick={() => onCancel(invite.id)}
                disabled={busy === `cancel-${invite.id}`}
                style={{
                  padding: '6px 12px', borderRadius: 8, border: '1px solid var(--border-primary)',
                  background: 'var(--bg-card)', color: 'var(--text-muted)', fontSize: 12,
                  cursor: busy ? 'default' : 'pointer', fontFamily: 'inherit',
                }}
              >
                Cancel
              </button>
            </div>
          ))}
        </div>
      )}

      {!hasOutgoing && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '0.03em' }}>
            Partner's email or username
          </label>
          <input
            type="text"
            value={identifier}
            onChange={e => setIdentifier(e.target.value)}
            placeholder="partner@example.com"
            style={{
              width: '100%', border: '1px solid var(--border-primary)', borderRadius: 10,
              padding: '9px 12px', fontSize: 13, fontFamily: 'inherit', outline: 'none',
              background: 'var(--bg-input)', color: 'var(--text-primary)', boxSizing: 'border-box',
            }}
          />
          <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '0.03em', marginTop: 4 }}>
            Optional message ({message.length}/{MAX_MESSAGE_CHARS})
          </label>
          <textarea
            value={message}
            onChange={e => setMessage(e.target.value.slice(0, MAX_MESSAGE_CHARS))}
            placeholder="Let's pair up on 460 Trip Planner!"
            rows={2}
            style={{
              width: '100%', border: '1px solid var(--border-primary)', borderRadius: 10,
              padding: '9px 12px', fontSize: 13, fontFamily: 'inherit', outline: 'none',
              background: 'var(--bg-input)', color: 'var(--text-primary)', boxSizing: 'border-box',
              resize: 'vertical',
            }}
          />
          <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: '4px 0 0' }}>
            Your partner needs an existing account on this instance. We'll send them a pair request they can accept or decline from their notification bell.
          </p>
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 6 }}>
            <button
              onClick={onSendInvite}
              disabled={sending || !identifier.trim()}
              style={{
                display: 'flex', alignItems: 'center', gap: 6,
                padding: '9px 18px', borderRadius: 10, border: 'none',
                background: '#b8430b', color: '#faf0d9',
                fontSize: 13, fontWeight: 600, fontFamily: 'inherit',
                cursor: (sending || !identifier.trim()) ? 'default' : 'pointer',
                opacity: (sending || !identifier.trim()) ? 0.5 : 1,
              }}
            >
              {sending
                ? <div style={{ width: 12, height: 12, border: '2px solid currentColor', borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 0.6s linear infinite' }} />
                : <UserPlus size={14} />
              }
              {sending ? 'Sending…' : 'Send partner request'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function UnpairConfirmModal({ partner, onCancel, onConfirm }: { partner: PartnerSnapshot; onCancel: () => void; onConfirm: () => void }) {
  return (
    <div
      style={{ position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}
      onClick={onCancel}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{ background: 'var(--bg-card)', borderRadius: 16, padding: '24px', maxWidth: 440, width: '100%', boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
          <div style={{ width: 36, height: 36, borderRadius: 10, background: '#fef3c7', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <AlertTriangle size={18} style={{ color: '#d97706' }} />
          </div>
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: 'var(--text-primary)' }}>Unpair from {partner.username}?</h3>
        </div>
        <p style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.6, margin: '0 0 8px' }}>
          Existing trip memberships stay. Your partner keeps access to any trips they've already been added to — unpair only stops auto-adding them to new trips.
        </p>
        <p style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.6, margin: '0 0 20px' }}>
          You can pair again later.
        </p>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button
            onClick={onCancel}
            style={{ padding: '9px 18px', borderRadius: 8, border: '1px solid var(--border-primary)', background: 'var(--bg-card)', fontSize: 13, fontWeight: 500, cursor: 'pointer', color: 'var(--text-primary)', fontFamily: 'inherit' }}
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            style={{ padding: '9px 18px', borderRadius: 8, border: 'none', background: '#dc2626', color: 'white', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', display: 'flex', alignItems: 'center', gap: 6 }}
          >
            <X size={14} /> Unpair
          </button>
        </div>
      </div>
    </div>
  )
}
