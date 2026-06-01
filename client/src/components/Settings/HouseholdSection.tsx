// [460-fork] Milestone 11 — Household panel (replaces PartnerSection).
//
// A household groups N user accounts plus M named non-account members.
// This single component renders the three states:
//   - no household yet: "+ Create household" CTA
//   - in a household: roster of users + named members + invite form
//   - has incoming invites: prominent accept/decline cards on top
//
import { useCallback, useEffect, useState } from 'react'
import { Users, UserPlus, Pencil, X, Check, Plus, Trash2, AlertTriangle, Home } from 'lucide-react'
import { authApi } from '../../api/client'
import { useToast } from '../shared/Toast'
import { useTranslation } from '../../i18n'
import { getApiErrorMessage } from '../../types'
import type { HouseholdGetResponse, HouseholdMember, HouseholdInviteView, UserSnapshot, HouseholdSnapshot } from '../../types/household'
import Section from './Section'

const MAX_INVITE_MESSAGE = 200

function genMutationId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return (crypto as Crypto).randomUUID()
  }
  return `hh-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

export default function HouseholdSection() {
  const { t } = useTranslation()
  const toast = useToast()
  const [data, setData] = useState<HouseholdGetResponse>({ household: null, incoming: [], outgoing: [] })
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [showLeaveConfirm, setShowLeaveConfirm] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const result = (await authApi.household.get()) as HouseholdGetResponse
      setData(result)
    } catch (err: unknown) {
      toast.error(getApiErrorMessage(err, 'Failed to load household'))
    } finally {
      setLoading(false)
    }
  }, [toast])

  useEffect(() => { void refresh() }, [refresh])

  const handleCreate = async (name: string | null) => {
    setBusy('create')
    try {
      await authApi.household.create(name)
      toast.success('Household created')
      await refresh()
    } catch (err: unknown) {
      toast.error(getApiErrorMessage(err, 'Failed to create household'))
    } finally {
      setBusy(null)
    }
  }

  const handleRename = async (name: string | null) => {
    setBusy('rename')
    try {
      await authApi.household.rename(name)
      await refresh()
    } catch (err: unknown) {
      toast.error(getApiErrorMessage(err, 'Failed to rename'))
    } finally {
      setBusy(null)
    }
  }

  const handleLeave = async () => {
    setShowLeaveConfirm(false)
    setBusy('leave')
    try {
      await authApi.household.leave()
      toast.success('Left household')
      await refresh()
    } catch (err: unknown) {
      toast.error(getApiErrorMessage(err, 'Failed to leave'))
    } finally {
      setBusy(null)
    }
  }

  const handleInvite = async (email: string, message: string) => {
    setBusy('invite')
    try {
      await authApi.household.invites.send({ email, message: message || undefined, clientMutationId: genMutationId() })
      toast.success('Invite sent')
      await refresh()
    } catch (err: unknown) {
      toast.error(getApiErrorMessage(err, 'Failed to send invite'))
    } finally {
      setBusy(null)
    }
  }

  const handleCancelInvite = async (id: string) => {
    setBusy(`cancel-${id}`)
    try {
      await authApi.household.invites.cancel(id)
      await refresh()
    } catch (err: unknown) {
      toast.error(getApiErrorMessage(err, 'Failed to cancel'))
    } finally {
      setBusy(null)
    }
  }

  const handleAcceptInvite = async (token: string) => {
    setBusy(`accept-${token}`)
    try {
      await authApi.household.invites.accept(token)
      toast.success('Joined household')
      await refresh()
    } catch (err: unknown) {
      toast.error(getApiErrorMessage(err, 'Failed to accept'))
    } finally {
      setBusy(null)
    }
  }

  const handleDeclineInvite = async (token: string) => {
    setBusy(`decline-${token}`)
    try {
      await authApi.household.invites.decline(token)
      await refresh()
    } catch (err: unknown) {
      toast.error(getApiErrorMessage(err, 'Failed to decline'))
    } finally {
      setBusy(null)
    }
  }

  const handleAddMember = async (name: string, dob: string, relationship: string) => {
    setBusy('add-member')
    try {
      await authApi.household.members.add({
        name,
        dob: dob || null,
        relationship: relationship || null,
      })
      await refresh()
    } catch (err: unknown) {
      toast.error(getApiErrorMessage(err, 'Failed to add member'))
    } finally {
      setBusy(null)
    }
  }

  const handleUpdateMember = async (id: number, patch: Partial<{ name: string; dob: string | null; relationship: string | null }>) => {
    setBusy(`update-member-${id}`)
    try {
      await authApi.household.members.update(id, patch)
      await refresh()
    } catch (err: unknown) {
      toast.error(getApiErrorMessage(err, 'Failed to update member'))
    } finally {
      setBusy(null)
    }
  }

  const handleDeleteMember = async (id: number) => {
    setBusy(`delete-member-${id}`)
    try {
      await authApi.household.members.delete(id)
      await refresh()
    } catch (err: unknown) {
      toast.error(getApiErrorMessage(err, 'Failed to delete member'))
    } finally {
      setBusy(null)
    }
  }

  if (loading) {
    return (
      <Section title="Household" icon={Users}>
        <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
          {t('common.loading')}
        </div>
      </Section>
    )
  }

  return (
    <>
      <Section title="Household" icon={Users}>
        <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: '0 0 20px', lineHeight: 1.6 }}>
          Group the people you travel with. Adult travel companions with their own accounts can edit your trips and get auto-added when you create new ones. Named members (kids, pets, granny) help reservations and photo captions know who's on the trip without giving them a login.
        </p>

        {data.incoming.length > 0 && (
          <IncomingInvitesPanel
            invites={data.incoming}
            onAccept={handleAcceptInvite}
            onDecline={handleDeclineInvite}
            busy={busy}
          />
        )}

        {data.household ? (
          <HouseholdPanel
            household={data.household}
            outgoing={data.outgoing}
            busy={busy}
            onRename={handleRename}
            onLeave={() => setShowLeaveConfirm(true)}
            onInvite={handleInvite}
            onCancelInvite={handleCancelInvite}
            onAddMember={handleAddMember}
            onUpdateMember={handleUpdateMember}
            onDeleteMember={handleDeleteMember}
          />
        ) : (
          <NoHouseholdPanel onCreate={handleCreate} busy={busy === 'create'} />
        )}
      </Section>

      {showLeaveConfirm && data.household && (
        <LeaveConfirmModal
          household={data.household}
          onCancel={() => setShowLeaveConfirm(false)}
          onConfirm={handleLeave}
        />
      )}
    </>
  )
}

// ── No household yet — CTA ──────────────────────────────────────────────────

function NoHouseholdPanel({ onCreate, busy }: { onCreate: (name: string | null) => void; busy: boolean }) {
  const [name, setName] = useState('')
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: 14, borderRadius: 10, background: 'var(--bg-card)', border: '1px solid var(--border-primary)' }}>
      <label style={inputLabelStyle}>Household name (optional)</label>
      <input
        type="text"
        value={name}
        onChange={e => setName(e.target.value)}
        placeholder="The Keys"
        style={inputStyle}
      />
      <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: '4px 0 0' }}>
        You can rename it later. After creating, invite your partner or other adult travel-companions who already have an account (they accept on their in-app notification bell — no email is sent), and add named members for kids or anyone who doesn't use the app.
      </p>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 6 }}>
        <button
          onClick={() => onCreate(name.trim() || null)}
          disabled={busy}
          style={primaryButtonStyle(busy)}
        >
          {busy ? '…' : <><Home size={14} /> Create household</>}
        </button>
      </div>
    </div>
  )
}

// ── Household exists — main panel ───────────────────────────────────────────

function HouseholdPanel(props: {
  household: HouseholdSnapshot
  outgoing: HouseholdInviteView[]
  busy: string | null
  onRename: (name: string | null) => void
  onLeave: () => void
  onInvite: (email: string, message: string) => void
  onCancelInvite: (id: string) => void
  onAddMember: (name: string, dob: string, relationship: string) => void
  onUpdateMember: (id: number, patch: Partial<{ name: string; dob: string | null; relationship: string | null }>) => void
  onDeleteMember: (id: number) => void
}) {
  const { household, outgoing, busy, onRename, onLeave, onInvite, onCancelInvite, onAddMember, onUpdateMember, onDeleteMember } = props
  const [editingName, setEditingName] = useState(false)
  const [nameDraft, setNameDraft] = useState(household.name ?? '')
  const [showInvite, setShowInvite] = useState(false)
  const [showAddMember, setShowAddMember] = useState(false)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* Household name */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        {editingName ? (
          <>
            <input
              type="text"
              value={nameDraft}
              onChange={e => setNameDraft(e.target.value)}
              placeholder="Household name (optional)"
              style={{ ...inputStyle, flex: 1 }}
              autoFocus
            />
            <button
              onClick={() => { onRename(nameDraft.trim() || null); setEditingName(false) }}
              style={iconButtonStyle}
              title="Save"
            >
              <Check size={14} />
            </button>
            <button onClick={() => { setNameDraft(household.name ?? ''); setEditingName(false) }} style={iconButtonStyle} title="Cancel">
              <X size={14} />
            </button>
          </>
        ) : (
          <>
            <div style={{ flex: 1, fontSize: 15, fontWeight: 600, color: 'var(--text-primary)' }}>
              {household.name || <span style={{ color: 'var(--text-faint)', fontWeight: 400 }}>Unnamed household</span>}
            </div>
            <button onClick={() => setEditingName(true)} style={iconButtonStyle} title="Rename">
              <Pencil size={14} />
            </button>
          </>
        )}
      </div>

      {/* User-account members */}
      <div>
        <div style={sectionLabelStyle}>Accounts</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {household.users.map(u => <UserRow key={u.id} user={u} />)}
        </div>
      </div>

      {/* Outgoing pending invites */}
      {outgoing.length > 0 && (
        <div>
          <div style={sectionLabelStyle}>Pending invites</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {outgoing.map(inv => (
              <div key={inv.id} style={rowStyle}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, color: 'var(--text-primary)' }}>{inv.invitee_email}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Waiting for accept</div>
                </div>
                <button onClick={() => onCancelInvite(inv.id)} disabled={busy === `cancel-${inv.id}`} style={secondaryButtonStyle}>Cancel</button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Invite an account-holder (in-app, not email) */}
      {!showInvite ? (
        <button onClick={() => setShowInvite(true)} style={addRowButtonStyle}>
          <UserPlus size={14} /> Invite someone with an account
        </button>
      ) : (
        <InviteForm
          onSubmit={(email, message) => { onInvite(email, message); setShowInvite(false) }}
          onCancel={() => setShowInvite(false)}
          busy={busy === 'invite'}
        />
      )}

      {/* Named members */}
      <div>
        <div style={sectionLabelStyle}>Named members</div>
        {household.members.length > 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {household.members.map(m => (
              <MemberRow
                key={m.id}
                member={m}
                onUpdate={onUpdateMember}
                onDelete={onDeleteMember}
                busy={busy}
              />
            ))}
          </div>
        ) : (
          <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: '8px 0' }}>
            Add kids, pets, or anyone else who travels with you but doesn't have their own account.
          </div>
        )}
        {!showAddMember ? (
          <button onClick={() => setShowAddMember(true)} style={addRowButtonStyle}>
            <Plus size={14} /> Add member
          </button>
        ) : (
          <AddMemberForm
            onSubmit={(name, dob, rel) => { onAddMember(name, dob, rel); setShowAddMember(false) }}
            onCancel={() => setShowAddMember(false)}
            busy={busy === 'add-member'}
          />
        )}
      </div>

      {/* Leave button */}
      <div style={{ borderTop: '1px solid var(--border-faint)', paddingTop: 12, display: 'flex', justifyContent: 'flex-end' }}>
        <button onClick={onLeave} disabled={busy === 'leave'} style={dangerButtonStyle}>
          {busy === 'leave' ? '…' : 'Leave household'}
        </button>
      </div>
    </div>
  )
}

// ── Incoming invites (sit above the panel) ──────────────────────────────────

function IncomingInvitesPanel({ invites, onAccept, onDecline, busy }: { invites: HouseholdInviteView[]; onAccept: (token: string) => void; onDecline: (token: string) => void; busy: string | null }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 14, padding: 12, borderRadius: 10, background: 'rgba(184, 67, 11, 0.06)', border: '1px solid rgba(184, 67, 11, 0.25)' }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)' }}>You have a household invite</div>
      {invites.map(inv => (
        <div key={inv.id} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ flex: 1, minWidth: 0, fontSize: 13, color: 'var(--text-muted)' }}>
            {inv.invited_by?.username ?? 'Someone'} ({inv.invited_by?.email ?? 'unknown'}) invited you to <strong>{inv.household_name || 'their household'}</strong>.
            {inv.message && <div style={{ marginTop: 4, fontStyle: 'italic' }}>"{inv.message}"</div>}
          </div>
          <button onClick={() => onAccept(inv.token)} disabled={busy === `accept-${inv.token}`} style={primaryButtonStyle(busy === `accept-${inv.token}`)}>Accept</button>
          <button onClick={() => onDecline(inv.token)} disabled={busy === `decline-${inv.token}`} style={secondaryButtonStyle}>Decline</button>
        </div>
      ))}
    </div>
  )
}

// ── Rows / sub-components ───────────────────────────────────────────────────

function UserRow({ user }: { user: UserSnapshot }) {
  return (
    <div style={rowStyle}>
      {user.avatar_url ? (
        <img src={user.avatar_url} alt={user.username} style={avatarStyle} />
      ) : (
        <div style={{ ...avatarStyle, background: 'var(--border-primary)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, fontWeight: 700, color: 'var(--text-muted)' }}>
          {user.username.charAt(0).toUpperCase()}
        </div>
      )}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{user.username}</div>
        <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{user.email}</div>
      </div>
    </div>
  )
}

function MemberRow({ member, onUpdate, onDelete, busy }: { member: HouseholdMember; onUpdate: (id: number, patch: Partial<{ name: string; dob: string | null; relationship: string | null }>) => void; onDelete: (id: number) => void; busy: string | null }) {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(member.name)
  const [dob, setDob] = useState(member.dob ?? '')
  const [relationship, setRelationship] = useState(member.relationship ?? '')

  if (editing) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: 12, borderRadius: 8, background: 'var(--bg-card)', border: '1px solid var(--border-primary)' }}>
        <input value={name} onChange={e => setName(e.target.value)} placeholder="Name" style={inputStyle} />
        <input value={dob} onChange={e => setDob(e.target.value)} placeholder="Date of birth (YYYY-MM-DD, optional)" style={inputStyle} />
        <input value={relationship} onChange={e => setRelationship(e.target.value)} placeholder="Relationship (optional)" style={inputStyle} />
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6 }}>
          <button
            onClick={() => { onUpdate(member.id, { name: name.trim(), dob: dob.trim() || null, relationship: relationship.trim() || null }); setEditing(false) }}
            disabled={!name.trim() || busy === `update-member-${member.id}`}
            style={primaryButtonStyle(busy === `update-member-${member.id}`)}
          >
            Save
          </button>
          <button onClick={() => setEditing(false)} style={secondaryButtonStyle}>Cancel</button>
        </div>
      </div>
    )
  }

  return (
    <div style={rowStyle}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{member.name}</div>
        <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          {[member.relationship, member.dob].filter(Boolean).join(' · ') || 'No additional info'}
        </div>
      </div>
      <button onClick={() => setEditing(true)} style={iconButtonStyle} title="Edit"><Pencil size={13} /></button>
      <button onClick={() => onDelete(member.id)} disabled={busy === `delete-member-${member.id}`} style={iconButtonStyle} title="Remove"><Trash2 size={13} /></button>
    </div>
  )
}

function InviteForm({ onSubmit, onCancel, busy }: { onSubmit: (email: string, message: string) => void; onCancel: () => void; busy: boolean }) {
  const [email, setEmail] = useState('')
  const [message, setMessage] = useState('')
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 12, borderRadius: 10, background: 'var(--bg-card)', border: '1px solid var(--border-primary)' }}>
      <label style={inputLabelStyle}>Their account email</label>
      <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="partner@example.com" style={inputStyle} />
      <label style={{ ...inputLabelStyle, marginTop: 4 }}>Optional message ({message.length}/{MAX_INVITE_MESSAGE})</label>
      <textarea value={message} onChange={e => setMessage(e.target.value.slice(0, MAX_INVITE_MESSAGE))} placeholder="Join our household on 460 Trip Planner!" rows={2} style={{ ...inputStyle, resize: 'vertical' as const }} />
      <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: '4px 0 0' }}>
        <strong>No email is sent.</strong> The person must already have an account here, and your
        invite appears on their in-app notification bell (not their inbox). Enter the email address
        they registered with.
      </p>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6 }}>
        <button onClick={() => onSubmit(email.trim(), message.trim())} disabled={!email.trim() || busy} style={primaryButtonStyle(busy)}>
          {busy ? 'Adding…' : 'Send invite'}
        </button>
        <button onClick={onCancel} style={secondaryButtonStyle}>Cancel</button>
      </div>
    </div>
  )
}

function AddMemberForm({ onSubmit, onCancel, busy }: { onSubmit: (name: string, dob: string, relationship: string) => void; onCancel: () => void; busy: boolean }) {
  const [name, setName] = useState('')
  const [dob, setDob] = useState('')
  const [relationship, setRelationship] = useState('')
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: 12, borderRadius: 10, background: 'var(--bg-card)', border: '1px solid var(--border-primary)' }}>
      <input value={name} onChange={e => setName(e.target.value)} placeholder="Name (required)" style={inputStyle} autoFocus />
      <input value={dob} onChange={e => setDob(e.target.value)} placeholder="Date of birth (YYYY-MM-DD, optional)" style={inputStyle} />
      <input value={relationship} onChange={e => setRelationship(e.target.value)} placeholder="Relationship (optional)" style={inputStyle} />
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6 }}>
        <button onClick={() => onSubmit(name.trim(), dob.trim(), relationship.trim())} disabled={!name.trim() || busy} style={primaryButtonStyle(busy)}>
          {busy ? 'Adding…' : 'Add'}
        </button>
        <button onClick={onCancel} style={secondaryButtonStyle}>Cancel</button>
      </div>
    </div>
  )
}

function LeaveConfirmModal({ household, onCancel, onConfirm }: { household: HouseholdSnapshot; onCancel: () => void; onConfirm: () => void }) {
  const isLast = household.users.length === 1
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }} onClick={onCancel}>
      <div onClick={e => e.stopPropagation()} style={{ background: 'var(--bg-card)', borderRadius: 16, padding: 24, maxWidth: 440, width: '100%', boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
          <div style={{ width: 36, height: 36, borderRadius: 10, background: '#fef3c7', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <AlertTriangle size={18} style={{ color: '#d97706' }} />
          </div>
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: 'var(--text-primary)' }}>Leave household?</h3>
        </div>
        <p style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.6, margin: '0 0 8px' }}>
          Existing trip memberships stay — you remain a member of any trips you're currently on. Leaving only stops auto-add for new trips.
        </p>
        {isLast && (
          <p style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.6, margin: '0 0 8px' }}>
            You're the last account in this household — leaving will delete it along with any named members.
          </p>
        )}
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 16 }}>
          <button onClick={onCancel} style={secondaryButtonStyle}>Cancel</button>
          <button onClick={onConfirm} style={{ ...dangerButtonStyle, padding: '9px 18px' }}>
            <X size={14} /> Leave
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Inline style helpers ────────────────────────────────────────────────────

const inputLabelStyle: React.CSSProperties = { fontSize: 11, fontWeight: 600, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '0.03em' }
const sectionLabelStyle: React.CSSProperties = { fontSize: 11, fontWeight: 600, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '0.03em', marginBottom: 8 }
const inputStyle: React.CSSProperties = { width: '100%', border: '1px solid var(--border-primary)', borderRadius: 8, padding: '8px 12px', fontSize: 13, fontFamily: 'inherit', outline: 'none', background: 'var(--bg-input)', color: 'var(--text-primary)', boxSizing: 'border-box' }
const rowStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', borderRadius: 8, background: 'var(--bg-card)', border: '1px solid var(--border-primary)' }
const avatarStyle: React.CSSProperties = { width: 36, height: 36, borderRadius: '50%', objectFit: 'cover' as const, flexShrink: 0 }
const iconButtonStyle: React.CSSProperties = { width: 28, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'transparent', border: '1px solid var(--border-primary)', borderRadius: 6, cursor: 'pointer', color: 'var(--text-muted)' }
const addRowButtonStyle: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 12px', borderRadius: 8, border: '1px dashed var(--border-primary)', background: 'transparent', color: 'var(--text-muted)', fontSize: 12, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit', alignSelf: 'flex-start' }
const dangerButtonStyle: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 14px', borderRadius: 8, border: '1px solid #dc2626', background: 'transparent', color: '#dc2626', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }
const secondaryButtonStyle: React.CSSProperties = { padding: '7px 14px', borderRadius: 8, border: '1px solid var(--border-primary)', background: 'var(--bg-card)', color: 'var(--text-muted)', fontSize: 12, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit' }
function primaryButtonStyle(busy: boolean): React.CSSProperties {
  return { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 16px', borderRadius: 8, border: 'none', background: '#b8430b', color: '#faf0d9', fontSize: 12, fontWeight: 600, cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.5 : 1, fontFamily: 'inherit' }
}
