// [460-fork] Shared segments (Milestone 4) — accept an invite token and
// attach one of the caller's trips to the segment.
import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { AlertTriangle, Check, Link2 } from 'lucide-react'
import Navbar from '../components/Layout/Navbar'
import { useToast } from '../components/shared/Toast'
import { segmentsApi, type InvitePreview } from '../api/segments'
import { tripsApi, daysApi } from '../api/client'
import { getApiErrorMessage } from '../types'

interface DashboardTripLite {
  id: number
  title: string
  start_date: string | null
  end_date: string | null
  is_owner: boolean
}

export default function SegmentAcceptPage() {
  const { token = '' } = useParams<{ token: string }>()
  const navigate = useNavigate()
  const toast = useToast()

  const [preview, setPreview] = useState<InvitePreview | null>(null)
  const [trips, setTrips] = useState<DashboardTripLite[]>([])
  const [selectedTripId, setSelectedTripId] = useState<number | null>(null)
  const [overlapDates, setOverlapDates] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [accepting, setAccepting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Initial load: preview + trip list in parallel.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setLoading(true)
      setError(null)
      try {
        const [p, tripsRes] = await Promise.all([
          segmentsApi.getInvitePreview(token),
          tripsApi.list(),
        ])
        if (cancelled) return
        setPreview(p)
        // Only owned, non-archived trips are valid accept targets.
        const owned: DashboardTripLite[] = (tripsRes.trips || [])
          .filter((t: any) => t.is_owner && !t.is_archived)
          .map((t: any) => ({ id: t.id, title: t.title, start_date: t.start_date ?? null, end_date: t.end_date ?? null, is_owner: true }))
        setTrips(owned)
      } catch (err: unknown) {
        if (!cancelled) setError(getApiErrorMessage(err, 'Invite link is invalid or expired'))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [token])

  // When a trip is picked, look up which dates will be replaced on its planner.
  useEffect(() => {
    if (!preview || !selectedTripId) { setOverlapDates([]); return }
    const segStart = preview.segment.start_date
    const segEnd = preview.segment.end_date
    if (!segStart || !segEnd) { setOverlapDates([]); return }
    let cancelled = false
    ;(async () => {
      try {
        const res = await daysApi.list(selectedTripId)
        if (cancelled) return
        const overlap = (res.days || [])
          .filter((d: any) => d.trip_id === selectedTripId && d.date && d.date >= segStart && d.date <= segEnd)
          .map((d: any) => d.date)
          .sort()
        setOverlapDates(overlap)
      } catch {
        if (!cancelled) setOverlapDates([])
      }
    })()
    return () => { cancelled = true }
  }, [preview, selectedTripId])

  const segmentDateLabel = useMemo(() => {
    if (!preview?.segment.start_date || !preview?.segment.end_date) return ''
    const fmt = (iso: string) => new Date(iso + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
    return `${fmt(preview.segment.start_date)} → ${fmt(preview.segment.end_date)}`
  }, [preview])

  const accept = async () => {
    if (!preview || !selectedTripId) return
    setAccepting(true)
    setError(null)
    try {
      await segmentsApi.accept({ token, target_trip_id: selectedTripId })
      toast.success('Segment linked to your trip')
      navigate(`/trips/${selectedTripId}`)
    } catch (err: unknown) {
      setError(getApiErrorMessage(err, 'Failed to accept invite'))
    } finally {
      setAccepting(false)
    }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column', background: 'var(--bg-secondary)' }}>
      <Navbar />
      <div style={{ flex: 1, overflow: 'auto', marginTop: 'var(--nav-h)' }}>
        <div style={{ maxWidth: 640, margin: '0 auto', padding: '32px 20px 60px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 18 }}>
            <Link2 size={20} style={{ color: 'var(--text-primary)' }} />
            <h1 style={{ margin: 0, fontSize: 20, fontWeight: 600, color: 'var(--text-primary)' }}>Accept shared segment</h1>
          </div>

          {loading && (
            <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>Loading invite…</div>
          )}

          {!loading && error && (
            <div style={{ padding: 14, borderRadius: 10, background: 'rgba(239, 68, 68, 0.08)', border: '1px solid rgba(239, 68, 68, 0.3)', fontSize: 13, color: 'var(--text-primary)', display: 'flex', alignItems: 'flex-start', gap: 10 }}>
              <AlertTriangle size={16} style={{ color: '#ef4444', flexShrink: 0, marginTop: 1 }} />
              <div>{error}</div>
            </div>
          )}

          {!loading && !error && preview && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              {preview.accepted && (
                <div style={{ padding: 10, borderRadius: 8, background: 'rgba(245, 158, 11, 0.08)', border: '1px solid rgba(245, 158, 11, 0.3)', fontSize: 12, color: 'var(--text-primary)' }}>
                  This invite has already been accepted. Create a new invite from the source trip if you need another link.
                </div>
              )}

              <section style={{ padding: 16, borderRadius: 12, background: 'var(--bg-card)', border: '1px solid var(--border-primary)', display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4 }}>Segment</div>
                <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--text-primary)' }}>{preview.segment.title}</div>
                {segmentDateLabel && <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>{segmentDateLabel}</div>}
              </section>

              <section style={{ padding: 16, borderRadius: 12, background: 'var(--bg-card)', border: '1px solid var(--border-primary)', display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)' }}>Attach to which of your trips?</div>
                {trips.length === 0 ? (
                  <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>
                    You don't own any trips yet. <a href="/dashboard" style={{ color: 'var(--text-primary)', textDecoration: 'underline' }}>Create one</a> first, then come back to this link.
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {trips.map(t => (
                      <label
                        key={t.id}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 10,
                          padding: 10, borderRadius: 8,
                          border: `1px solid ${selectedTripId === t.id ? 'var(--text-primary)' : 'var(--border-primary)'}`,
                          background: selectedTripId === t.id ? 'rgba(17,24,39,0.04)' : 'transparent',
                          cursor: 'pointer',
                        }}
                      >
                        <input
                          type="radio"
                          name="trip"
                          checked={selectedTripId === t.id}
                          onChange={() => setSelectedTripId(t.id)}
                          style={{ cursor: 'pointer' }}
                        />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{t.title}</div>
                          {(t.start_date || t.end_date) && (
                            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                              {t.start_date || '?'} → {t.end_date || '?'}
                            </div>
                          )}
                        </div>
                      </label>
                    ))}
                  </div>
                )}
              </section>

              {selectedTripId && overlapDates.length > 0 && (
                <div style={{ padding: 12, borderRadius: 10, background: 'rgba(245, 158, 11, 0.08)', border: '1px solid rgba(245, 158, 11, 0.3)', fontSize: 12, color: 'var(--text-primary)', display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                  <AlertTriangle size={14} style={{ color: '#f59e0b', flexShrink: 0, marginTop: 1 }} />
                  <div>
                    Your selected trip has content on {overlapDates.length} date{overlapDates.length === 1 ? '' : 's'} that the segment covers ({overlapDates.map(d => new Date(d + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' })).join(', ')}). Accepting will replace that content with the shared segment's days.
                    {' '}<em>Keep-mine partial-accept will ship in a later slice;</em> if you need to preserve the existing content, copy it off first or pick a different trip.
                  </div>
                </div>
              )}

              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button
                  type="button"
                  onClick={() => navigate('/dashboard')}
                  disabled={accepting}
                  style={{
                    padding: '8px 14px', borderRadius: 8,
                    border: '1px solid var(--border-primary)', background: 'var(--bg-card)',
                    color: 'var(--text-primary)', fontSize: 13, fontWeight: 500,
                    cursor: accepting ? 'default' : 'pointer', fontFamily: 'inherit',
                    opacity: accepting ? 0.5 : 1,
                  }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={accept}
                  disabled={!selectedTripId || accepting || preview.accepted}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 6,
                    padding: '8px 16px', borderRadius: 8,
                    border: '1px solid var(--text-primary)',
                    background: !selectedTripId || accepting || preview.accepted ? 'var(--border-primary)' : 'var(--text-primary)',
                    color: 'var(--bg-primary)', fontSize: 13, fontWeight: 600,
                    cursor: !selectedTripId || accepting || preview.accepted ? 'default' : 'pointer', fontFamily: 'inherit',
                    opacity: !selectedTripId || accepting || preview.accepted ? 0.5 : 1,
                  }}
                >
                  {accepting
                    ? <div style={{ width: 12, height: 12, border: '2px solid currentColor', borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 0.6s linear infinite' }} />
                    : <Check size={13} />
                  }
                  {accepting ? 'Attaching…' : 'Attach to this trip'}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
