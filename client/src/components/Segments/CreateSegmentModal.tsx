// [460-fork] Shared segments (Milestone 4) — create-segment flow.
// Lets the trip owner pick a contiguous range of days on their own trip,
// name the resulting segment, and receive a signed invite URL to send to
// another household.
import { useEffect, useMemo, useState } from 'react'
import { Check, Copy, Link2, Users } from 'lucide-react'
import Modal from '../shared/Modal'
import { useToast } from '../shared/Toast'
import { segmentsApi } from '../../api/segments'
import { getApiErrorMessage } from '../../types'
import type { Day } from '../../types'

interface Props {
  isOpen: boolean
  onClose: () => void
  tripId: number
  days: Day[]
  onCreated?: () => void // caller refetches days so segment_id shows up
}

interface Created {
  segmentId: string
  inviteUrl: string
  expiresAt: string
}

export default function CreateSegmentModal({ isOpen, onClose, tripId, days, onCreated }: Props) {
  const toast = useToast()

  // Only dated days can participate; sorted by date for the pickers.
  const datedDays = useMemo(
    () => days.filter(d => !!d.date).slice().sort((a, b) => a.date.localeCompare(b.date)),
    [days],
  )

  const [title, setTitle] = useState('')
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [created, setCreated] = useState<Created | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!isOpen) {
      setTitle('')
      setStartDate('')
      setEndDate('')
      setBusy(false)
      setError(null)
      setCreated(null)
      setCopied(false)
    }
  }, [isOpen])

  const selectedDayIds = useMemo(() => {
    if (!startDate || !endDate) return []
    if (startDate > endDate) return []
    return datedDays.filter(d => d.date >= startDate && d.date <= endDate).map(d => d.id)
  }, [datedDays, startDate, endDate])

  const selectedDates = useMemo(() => {
    if (!startDate || !endDate) return [] as string[]
    if (startDate > endDate) return []
    return datedDays.filter(d => d.date >= startDate && d.date <= endDate).map(d => d.date)
  }, [datedDays, startDate, endDate])

  const alreadyShared = selectedDates.length > 0 && datedDays
    .filter(d => selectedDates.includes(d.date))
    .some(d => d.segment_id)

  const canSubmit = !busy && !!title.trim() && selectedDayIds.length > 0 && !alreadyShared

  const submit = async () => {
    setError(null)
    setBusy(true)
    try {
      const segment = await segmentsApi.create({
        trip_id: tripId,
        day_ids: selectedDayIds,
        title: title.trim(),
      })
      const invite = await segmentsApi.createInvite(segment.segment.id)
      const url = `${window.location.origin}/segments/accept/${invite.token}`
      setCreated({ segmentId: segment.segment.id, inviteUrl: url, expiresAt: invite.expires_at })
      onCreated?.()
    } catch (err: unknown) {
      setError(getApiErrorMessage(err, 'Failed to create shared segment'))
    } finally {
      setBusy(false)
    }
  }

  const copyLink = async () => {
    if (!created) return
    try {
      await navigator.clipboard.writeText(created.inviteUrl)
      setCopied(true)
      toast.success('Invite link copied')
      setTimeout(() => setCopied(false), 2000)
    } catch {
      toast.error('Copy failed — select the link and copy manually')
    }
  }

  const formatDate = (iso: string) => {
    try { return new Date(iso + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) } catch { return iso }
  }

  const firstDate = datedDays[0]?.date ?? ''
  const lastDate = datedDays[datedDays.length - 1]?.date ?? ''

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Share days with another household" size="md">
      {created ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 10,
            padding: '10px 12px', borderRadius: 8,
            background: 'rgba(16, 185, 129, 0.08)', border: '1px solid rgba(16, 185, 129, 0.3)',
            color: 'var(--text-primary)', fontSize: 13,
          }}>
            <Check size={16} style={{ color: '#10b981', flexShrink: 0 }} />
            <div>Segment created. Send the invite link to the other household.</div>
          </div>

          <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)' }}>Invite link</span>
            <div style={{ display: 'flex', gap: 6 }}>
              <input
                type="text"
                readOnly
                value={created.inviteUrl}
                onFocus={e => e.currentTarget.select()}
                style={{
                  flex: 1, padding: '8px 10px', borderRadius: 8,
                  border: '1px solid var(--border-primary)', background: 'var(--bg-input)',
                  color: 'var(--text-primary)', fontSize: 12, fontFamily: 'ui-monospace, SFMono-Regular, monospace',
                  outline: 'none', boxSizing: 'border-box',
                }}
              />
              <button
                type="button"
                onClick={copyLink}
                style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  padding: '8px 12px', borderRadius: 8,
                  border: '1px solid var(--text-primary)', background: 'var(--text-primary)',
                  color: 'var(--bg-primary)', fontSize: 12, fontWeight: 600,
                  cursor: 'pointer', fontFamily: 'inherit', flexShrink: 0,
                }}
              >
                {copied ? <Check size={13} /> : <Copy size={13} />}
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
          </label>

          <p style={{ margin: 0, fontSize: 11, color: 'var(--text-muted)' }}>
            Link expires {new Date(created.expiresAt).toLocaleDateString()}. Anyone with the link can attach one of their trips to this segment.
          </p>

          <div style={{ display: 'flex', justifyContent: 'flex-end', paddingTop: 6 }}>
            <button
              type="button"
              onClick={onClose}
              style={{
                padding: '8px 14px', borderRadius: 8,
                border: '1px solid var(--border-primary)', background: 'var(--bg-card)',
                color: 'var(--text-primary)', fontSize: 13, fontWeight: 500,
                cursor: 'pointer', fontFamily: 'inherit',
              }}
            >
              Done
            </button>
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{
            display: 'flex', alignItems: 'flex-start', gap: 10,
            padding: 10, borderRadius: 8,
            background: 'rgba(59, 130, 246, 0.06)', border: '1px solid rgba(59, 130, 246, 0.25)',
            fontSize: 12, color: 'var(--text-primary)',
          }}>
            <Users size={14} style={{ marginTop: 1, color: '#3b82f6', flexShrink: 0 }} />
            <div>
              Pick a contiguous range of days to share. The other household will see these days in their own trip once they accept.
              Edits on either side sync live.
            </div>
          </div>

          <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)' }}>Segment title</span>
            <input
              type="text"
              value={title}
              onChange={e => setTitle(e.target.value)}
              placeholder="Adventure with the Smiths"
              maxLength={120}
              style={{
                padding: '8px 10px', borderRadius: 8,
                border: '1px solid var(--border-primary)', background: 'var(--bg-input)',
                color: 'var(--text-primary)', fontSize: 13, fontFamily: 'inherit',
                outline: 'none', boxSizing: 'border-box',
              }}
            />
          </label>

          <div style={{ display: 'flex', gap: 10 }}>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: 1 }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)' }}>From</span>
              <input
                type="date"
                value={startDate}
                onChange={e => setStartDate(e.target.value)}
                min={firstDate}
                max={lastDate}
                style={{
                  padding: '8px 10px', borderRadius: 8,
                  border: '1px solid var(--border-primary)', background: 'var(--bg-input)',
                  color: 'var(--text-primary)', fontSize: 13, fontFamily: 'inherit',
                  outline: 'none', boxSizing: 'border-box',
                }}
              />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: 1 }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)' }}>To</span>
              <input
                type="date"
                value={endDate}
                onChange={e => setEndDate(e.target.value)}
                min={startDate || firstDate}
                max={lastDate}
                style={{
                  padding: '8px 10px', borderRadius: 8,
                  border: '1px solid var(--border-primary)', background: 'var(--bg-input)',
                  color: 'var(--text-primary)', fontSize: 13, fontFamily: 'inherit',
                  outline: 'none', boxSizing: 'border-box',
                }}
              />
            </label>
          </div>

          {selectedDayIds.length > 0 && !alreadyShared && (
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              {selectedDayIds.length} day{selectedDayIds.length === 1 ? '' : 's'} will be shared:{' '}
              <span style={{ color: 'var(--text-primary)' }}>
                {selectedDates.map(formatDate).join(', ')}
              </span>
            </div>
          )}

          {alreadyShared && (
            <div style={{ fontSize: 12, color: '#dc2626' }}>
              One or more of these days is already part of another shared segment. Pick a different range.
            </div>
          )}

          {error && (
            <div style={{
              padding: 10, borderRadius: 8,
              background: 'rgba(239, 68, 68, 0.08)', border: '1px solid rgba(239, 68, 68, 0.3)',
              fontSize: 12, color: 'var(--text-primary)',
            }}>
              {error}
            </div>
          )}

          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', paddingTop: 6 }}>
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              style={{
                padding: '8px 14px', borderRadius: 8,
                border: '1px solid var(--border-primary)', background: 'var(--bg-card)',
                color: 'var(--text-primary)', fontSize: 13, fontWeight: 500,
                cursor: busy ? 'default' : 'pointer', fontFamily: 'inherit',
                opacity: busy ? 0.5 : 1,
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={!canSubmit}
              style={{
                display: 'flex', alignItems: 'center', gap: 6,
                padding: '8px 16px', borderRadius: 8,
                border: '1px solid var(--text-primary)',
                background: canSubmit ? 'var(--text-primary)' : 'var(--border-primary)',
                color: 'var(--bg-primary)', fontSize: 13, fontWeight: 600,
                cursor: canSubmit ? 'pointer' : 'default', fontFamily: 'inherit',
                opacity: canSubmit ? 1 : 0.5,
              }}
            >
              {busy
                ? <div style={{ width: 12, height: 12, border: '2px solid currentColor', borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 0.6s linear infinite' }} />
                : <Link2 size={13} />
              }
              {busy ? 'Creating…' : 'Create + get invite link'}
            </button>
          </div>
        </div>
      )}
    </Modal>
  )
}
