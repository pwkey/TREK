// [460-fork] Milestone 9 — public voter page.
//
// Lives at /poll/:token. No authentication; the share token is the
// access control. The voter identifies by name + a UUID stored in
// localStorage so subsequent visits in the same browser revise the
// existing votes rather than creating a new voter.
import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { Calendar, Vote, ThumbsUp, ThumbsDown, HelpCircle, CheckCircle } from 'lucide-react'
import { pollsApi, type Poll, type PollOption } from '../api/client'

const BROWSER_ID_KEY = '460tp-poll-voter-id'
function getOrCreateBrowserId(): string {
  let id = localStorage.getItem(BROWSER_ID_KEY)
  if (!id) {
    id = (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
      ? (crypto as Crypto).randomUUID()
      : `voter-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`
    localStorage.setItem(BROWSER_ID_KEY, id)
  }
  return id
}

const NAME_KEY_PREFIX = '460tp-poll-voter-name:'

type Choice = 'yes' | 'no' | 'maybe'

export default function PublicPollPage() {
  const { token } = useParams<{ token: string }>()
  const [poll, setPoll] = useState<Poll | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [voterName, setVoterName] = useState('')
  const [choices, setChoices] = useState<Record<number, Choice>>({})
  const [submitting, setSubmitting] = useState(false)
  const [submitted, setSubmitted] = useState(false)

  const browserId = getOrCreateBrowserId()

  useEffect(() => {
    if (!token) return
    pollsApi.getPublic(token)
      .then(r => {
        setPoll(r.poll)
        // Pre-fill the voter's previous choices if they've voted before.
        const myVotes = (r.poll.votes || []).filter(v => v.voter_browser_id === browserId)
        if (myVotes.length > 0) {
          setVoterName(myVotes[0].voter_name)
          const m: Record<number, Choice> = {}
          for (const v of myVotes) m[v.option_id] = v.choice
          setChoices(m)
        } else {
          // Fallback: per-token last-used name, helps when localStorage was cleared partway.
          const stored = localStorage.getItem(NAME_KEY_PREFIX + token)
          if (stored) setVoterName(stored)
        }
      })
      .catch(() => setError('Poll not found or link is invalid'))
      .finally(() => setLoading(false))
  }, [token, browserId])

  const submit = async () => {
    if (!poll || !token) return
    if (!voterName.trim()) { setError('Please enter your name'); return }
    if (Object.keys(choices).length === 0) { setError('Tap a choice on at least one date range'); return }
    setError(null)
    setSubmitting(true)
    try {
      const payload = {
        voter_name: voterName.trim(),
        voter_browser_id: browserId,
        choices: Object.entries(choices).map(([optId, c]) => ({ option_id: Number(optId), choice: c })),
      }
      await pollsApi.submitVotes(token, payload)
      localStorage.setItem(NAME_KEY_PREFIX + token, voterName.trim())
      setSubmitted(true)
      // Re-fetch so the page reflects the saved state.
      const fresh = await pollsApi.getPublic(token)
      setPoll(fresh.poll)
    } catch (err: unknown) {
      const ax = err as { response?: { data?: { error?: string } }; message?: string }
      setError(ax.response?.data?.error ?? ax.message ?? 'Could not submit vote')
    } finally {
      setSubmitting(false)
    }
  }

  if (loading) return <div style={{ padding: 32, textAlign: 'center', color: '#666' }}>Loading…</div>
  if (error && !poll) return <div style={{ padding: 32, textAlign: 'center', color: '#b91c1c' }}>{error}</div>
  if (!poll) return null

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg-secondary, #f7f5f1)', padding: '32px 16px' }}>
      <div style={{ maxWidth: 640, margin: '0 auto' }}>
        <header style={{ marginBottom: 20 }}>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, color: 'var(--text-secondary)', marginBottom: 6 }}>
            <Vote size={16} strokeWidth={1.8} />
            <span style={{ fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>460 Trip Planner — availability poll</span>
          </div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: 'var(--text-primary)' }}>{poll.title}</h1>
          {poll.description && <p style={{ marginTop: 8, color: 'var(--text-secondary)', fontSize: 14 }}>{poll.description}</p>}
        </header>

        <section style={{ background: 'var(--bg-card, white)', borderRadius: 14, padding: 18, marginBottom: 16, border: '1px solid var(--border-primary)' }}>
          <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 6 }}>Your name</label>
          <input
            value={voterName}
            onChange={e => setVoterName(e.target.value)}
            placeholder="Alice"
            style={{ width: '100%', padding: 10, borderRadius: 8, border: '1px solid var(--border-primary)', background: 'var(--bg-input)', color: 'var(--text-primary)', fontFamily: 'inherit', fontSize: 14, boxSizing: 'border-box' }}
          />
          <p style={{ margin: '8px 0 0', fontSize: 11, color: 'var(--text-faint)' }}>
            Visible to others on this poll. Your responses are remembered on this browser.
          </p>
        </section>

        <section style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 16 }}>
          {poll.options.map((opt: PollOption) => {
            const cur = choices[opt.id]
            return (
              <div key={opt.id} style={{ background: 'var(--bg-card, white)', borderRadius: 12, padding: 14, border: '1px solid var(--border-primary)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                  <Calendar size={14} style={{ color: 'var(--text-faint)' }} />
                  <strong style={{ fontSize: 14, color: 'var(--text-primary)' }}>{formatRange(opt.start_date, opt.end_date)}</strong>
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <ChoiceBtn icon={<ThumbsUp size={14} />} label="Yes" active={cur === 'yes'} colour="#16a34a" onClick={() => setChoices(c => ({ ...c, [opt.id]: 'yes' }))} />
                  <ChoiceBtn icon={<HelpCircle size={14} />} label="Maybe" active={cur === 'maybe'} colour="#ca8a04" onClick={() => setChoices(c => ({ ...c, [opt.id]: 'maybe' }))} />
                  <ChoiceBtn icon={<ThumbsDown size={14} />} label="No" active={cur === 'no'} colour="#dc2626" onClick={() => setChoices(c => ({ ...c, [opt.id]: 'no' }))} />
                </div>
              </div>
            )
          })}
        </section>

        {error && <div style={{ marginBottom: 12, padding: 10, borderRadius: 8, background: '#fee2e2', border: '1px solid #fca5a5', color: '#991b1b', fontSize: 13 }}>{error}</div>}

        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button
            type="button"
            onClick={submit}
            disabled={submitting}
            style={{ flex: 1, padding: '12px 18px', borderRadius: 10, border: 'none', background: 'var(--accent)', color: 'var(--accent-text)', cursor: submitting ? 'not-allowed' : 'pointer', fontSize: 14, fontWeight: 600, fontFamily: 'inherit' }}
          >
            {submitting ? 'Saving…' : submitted ? 'Update my answers' : 'Submit'}
          </button>
          {submitted && (
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: '#16a34a', fontSize: 12, fontWeight: 600 }}>
              <CheckCircle size={14} /> saved
            </div>
          )}
        </div>

        <p style={{ marginTop: 20, fontSize: 11, color: 'var(--text-faint)', textAlign: 'center' }}>
          You can change your answers any time by reopening this link. The trip creator can see who voted what.
        </p>
      </div>
    </div>
  )
}

function ChoiceBtn({ icon, label, active, colour, onClick }: { icon: React.ReactNode; label: string; active: boolean; colour: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      style={{
        flex: 1,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
        padding: '8px 12px', borderRadius: 8,
        border: '1px solid ' + (active ? colour : 'var(--border-primary)'),
        background: active ? colour : 'transparent',
        color: active ? 'white' : 'var(--text-primary)',
        cursor: 'pointer', fontFamily: 'inherit', fontSize: 13, fontWeight: 500,
      }}
    >
      {icon} {label}
    </button>
  )
}

function formatRange(start: string, end: string): string {
  try {
    const s = new Date(start + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
    const e = new Date(end + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })
    return `${s} → ${e}`
  } catch { return `${start} → ${end}` }
}
