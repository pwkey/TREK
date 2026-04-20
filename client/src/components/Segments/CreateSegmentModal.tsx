// [460-fork] Shared segments (Milestone 4) — create-segment flow.
// Lets the trip owner pick a contiguous range of days on their own trip,
// name the resulting segment, and receive a signed invite URL to send to
// another household.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Check, Copy, Link2, LogOut, Users } from 'lucide-react'
import Modal from '../shared/Modal'
import { useToast } from '../shared/Toast'
import { segmentsApi, type SegmentSummaryForTrip } from '../../api/segments'
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
  const [existingSegments, setExistingSegments] = useState<SegmentSummaryForTrip[]>([])
  const [leavingId, setLeavingId] = useState<string | null>(null)
  const [confirmLeaveId, setConfirmLeaveId] = useState<string | null>(null)

  const refreshExisting = useCallback(async () => {
    try {
      const res = await segmentsApi.listForTrip(tripId)
      setExistingSegments(res.segments)
    } catch { /* silent — list is non-critical */ }
  }, [tripId])

  useEffect(() => {
    if (!isOpen) {
      setTitle('')
      setStartDate('')
      setEndDate('')
      setBusy(false)
      setError(null)
      setCreated(null)
      setCopied(false)
      setConfirmLeaveId(null)
      setLeavingId(null)
      return
    }
    void refreshExisting()
  }, [isOpen, refreshExisting])

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
      void refreshExisting()
    } catch (err: unknown) {
      setError(getApiErrorMessage(err, 'Failed to create shared segment'))
    } finally {
      setBusy(false)
    }
  }

  const leave = async (segmentId: string) => {
    setLeavingId(segmentId)
    try {
      await segmentsApi.leave(segmentId, tripId)
      toast.success('Left shared segment — memento copy kept on your trip')
      await refreshExisting()
      onCreated?.()
    } catch (err: unknown) {
      toast.error(getApiErrorMessage(err, 'Failed to leave segment'))
    } finally {
      setLeavingId(null)
      setConfirmLeaveId(null)
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
          {existingSegments.length > 0 && (
            <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)' }}>
                Shared segments on this trip
              </div>
              {existingSegments.map(seg => {
                const range = seg.start_date && seg.end_date
                  ? `${formatDate(seg.start_date)} – ${formatDate(seg.end_date)}`
                  : ''
                const otherCount = Math.max(0, seg.linked_trip_count - 1)
                return (
                  <div key={seg.id} style={{
                    display: 'flex', alignItems: 'center', gap: 10,
                    padding: 10, borderRadius: 10,
                    border: '1px solid var(--border-primary)', background: 'var(--bg-card)',
                  }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <Link2 size={12} style={{ color: '#0e7a5a', flexShrink: 0 }} />
                        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {seg.title}
                        </span>
                        {seg.is_home && (
                          <span style={{
                            padding: '1px 6px', borderRadius: 999, fontSize: 10, fontWeight: 600,
                            background: 'rgba(59, 130, 246, 0.12)', color: '#2563eb',
                            border: '1px solid rgba(59, 130, 246, 0.3)',
                          }}>home</span>
                        )}
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                        {range}{range && otherCount > 0 ? ' · ' : ''}
                        {otherCount > 0 && `${otherCount} other trip${otherCount === 1 ? '' : 's'}`}
                      </div>
                    </div>
                    {confirmLeaveId === seg.id ? (
                      <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                        <button
                          type="button"
                          onClick={() => setConfirmLeaveId(null)}
                          disabled={leavingId === seg.id}
                          style={{
                            padding: '6px 10px', borderRadius: 6,
                            border: '1px solid var(--border-primary)', background: 'var(--bg-card)',
                            fontSize: 11, fontWeight: 500, color: 'var(--text-primary)',
                            cursor: 'pointer', fontFamily: 'inherit',
                          }}
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          onClick={() => leave(seg.id)}
                          disabled={leavingId === seg.id}
                          style={{
                            padding: '6px 10px', borderRadius: 6,
                            border: '1px solid #dc2626', background: '#dc2626',
                            fontSize: 11, fontWeight: 600, color: 'white',
                            cursor: leavingId === seg.id ? 'default' : 'pointer', fontFamily: 'inherit',
                            opacity: leavingId === seg.id ? 0.5 : 1,
                          }}
                        >
                          {leavingId === seg.id ? 'Leaving…' : 'Confirm leave'}
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setConfirmLeaveId(seg.id)}
                        disabled={seg.is_home}
                        title={seg.is_home ? "You're the home trip — dissolve the segment or have no siblings before leaving" : 'Leave this segment; a memento copy of the shared days stays on your trip'}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 4,
                          padding: '6px 10px', borderRadius: 6,
                          border: `1px solid ${seg.is_home ? 'var(--border-primary)' : '#dc2626'}`,
                          background: 'transparent',
                          fontSize: 11, fontWeight: 500,
                          color: seg.is_home ? 'var(--text-muted)' : '#dc2626',
                          cursor: seg.is_home ? 'default' : 'pointer', fontFamily: 'inherit',
                          opacity: seg.is_home ? 0.5 : 1,
                          flexShrink: 0,
                        }}
                      >
                        <LogOut size={11} />
                        Leave
                      </button>
                    )}
                  </div>
                )
              })}
              {confirmLeaveId && (
                <div style={{ fontSize: 11, color: 'var(--text-muted)', paddingLeft: 4 }}>
                  Confirming will copy the shared days into your trip as plain rows. The segment continues for the other households.
                </div>
              )}
            </section>
          )}

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
