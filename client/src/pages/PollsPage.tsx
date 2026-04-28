// [460-fork] Milestone 9 — owner-side polls page.
//
// Lists my polls, lets me create new ones with N candidate date ranges,
// and shows per-poll results with copy-share-link affordance. Slice 9.3
// "convert winning option to a trip" is a follow-up.
import { useEffect, useState } from 'react'
import { Plus, Copy, Trash2, Calendar, Link2, Vote } from 'lucide-react'
import Navbar from '../components/Layout/Navbar'
import { useToast } from '../components/shared/Toast'
import { pollsApi, type Poll, type PollOption, type PollVote } from '../api/client'

export default function PollsPage() {
  const toast = useToast()
  const [polls, setPolls] = useState<Poll[]>([])
  const [loading, setLoading] = useState(true)
  const [showCreate, setShowCreate] = useState(false)
  const [selectedId, setSelectedId] = useState<number | null>(null)

  const refresh = async () => {
    try {
      const r = await pollsApi.list()
      setPolls(r.polls)
    } catch {
      toast.error('Could not load polls')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void refresh() }, [])

  const onCreated = (poll: Poll) => {
    setPolls(p => [poll, ...p])
    setShowCreate(false)
    setSelectedId(poll.id)
  }

  const onDelete = async (id: number) => {
    if (!confirm('Delete this poll? Votes will be lost.')) return
    try {
      await pollsApi.delete(id)
      setPolls(p => p.filter(x => x.id !== id))
      if (selectedId === id) setSelectedId(null)
    } catch {
      toast.error('Could not delete poll')
    }
  }

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg-secondary)' }}>
      <Navbar />
      <div style={{ paddingTop: 'var(--nav-h)' }}>
        <div style={{ maxWidth: 1100, margin: '0 auto', padding: '24px 16px 64px' }}>
          <header style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
            <Vote size={20} strokeWidth={1.8} />
            <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: 'var(--text-primary)' }}>Pre-trip availability polls</h1>
            <span style={{ marginLeft: 'auto' }}>
              <button
                type="button"
                onClick={() => setShowCreate(true)}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '9px 16px', background: 'var(--accent)', color: 'var(--accent-text)', border: 'none', borderRadius: 12, fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}
              >
                <Plus size={15} /> New poll
              </button>
            </span>
          </header>

          <p style={{ marginTop: 0, color: 'var(--text-muted)', fontSize: 13 }}>
            Pick a few candidate date ranges, share the link with travel partners, and let them vote without creating an account. Once you converge on dates, create the trip and invite the voters as members.
          </p>

          {loading ? (
            <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-faint)' }}>Loading…</div>
          ) : polls.length === 0 ? (
            <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-faint)', border: '1.5px dashed var(--border-primary)', borderRadius: 12, marginTop: 16 }}>
              No polls yet. Click <strong>New poll</strong> above to make one.
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: '320px 1fr', gap: 16, marginTop: 16, alignItems: 'start' }}>
              <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
                {polls.map(p => (
                  <li key={p.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedId(p.id)}
                      style={{
                        width: '100%', textAlign: 'left',
                        padding: '10px 12px', borderRadius: 10,
                        border: '1px solid ' + (selectedId === p.id ? 'var(--accent)' : 'var(--border-primary)'),
                        background: selectedId === p.id ? 'var(--bg-card)' : 'transparent',
                        cursor: 'pointer', fontFamily: 'inherit', color: 'var(--text-primary)',
                      }}
                    >
                      <div style={{ fontSize: 13, fontWeight: 600 }}>{p.title}</div>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{p.options.length} option{p.options.length === 1 ? '' : 's'}</div>
                    </button>
                  </li>
                ))}
              </ul>
              <div>
                {selectedId == null ? (
                  <div style={{ padding: 32, color: 'var(--text-faint)', textAlign: 'center' }}>Pick a poll on the left to see results.</div>
                ) : (
                  <PollDetail key={selectedId} pollId={selectedId} onDelete={onDelete} />
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {showCreate && (
        <CreatePollModal onClose={() => setShowCreate(false)} onCreated={onCreated} />
      )}
    </div>
  )
}

function PollDetail({ pollId, onDelete }: { pollId: number; onDelete: (id: number) => void }) {
  const toast = useToast()
  const [poll, setPoll] = useState<Poll | null>(null)
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    setLoading(true)
    pollsApi.get(pollId).then(r => setPoll(r.poll)).catch(() => toast.error('Could not load poll')).finally(() => setLoading(false))
  }, [pollId])

  if (loading || !poll) return <div style={{ padding: 32, color: 'var(--text-faint)' }}>Loading…</div>

  const shareUrl = `${window.location.origin}/poll/${poll.share_token}`
  // Group votes by voter_browser_id so we can render one row per voter.
  const voters: Record<string, { name: string; per_option: Record<number, PollVote> }> = {}
  for (const v of (poll.votes || [])) {
    if (!voters[v.voter_browser_id]) voters[v.voter_browser_id] = { name: v.voter_name, per_option: {} }
    voters[v.voter_browser_id].per_option[v.option_id] = v
  }
  const voterList = Object.values(voters)

  return (
    <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border-primary)', borderRadius: 12, padding: 18 }}>
      <header style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 12 }}>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: 'var(--text-primary)' }}>{poll.title}</h2>
        <button
          type="button"
          onClick={() => onDelete(poll.id)}
          title="Delete poll"
          style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-faint)', padding: 4 }}
        >
          <Trash2 size={14} />
        </button>
      </header>
      {poll.description && <p style={{ margin: '0 0 12px', color: 'var(--text-secondary)', fontSize: 13 }}>{poll.description}</p>}

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 10, borderRadius: 8, background: 'var(--bg-secondary)', marginBottom: 16 }}>
        <Link2 size={14} style={{ color: 'var(--text-muted)' }} />
        <code style={{ flex: 1, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text-primary)' }}>{shareUrl}</code>
        <button
          type="button"
          onClick={() => { void navigator.clipboard.writeText(shareUrl); toast.success('Share link copied') }}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '4px 10px', borderRadius: 6, border: '1px solid var(--border-primary)', background: 'transparent', cursor: 'pointer', fontSize: 12, color: 'var(--text-primary)', fontFamily: 'inherit' }}
        >
          <Copy size={12} /> Copy
        </button>
      </div>

      {/* Results matrix */}
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
        <thead>
          <tr>
            <th style={th}>Option</th>
            <th style={{ ...th, width: 60, textAlign: 'center' }}>👍</th>
            <th style={{ ...th, width: 60, textAlign: 'center' }}>🤔</th>
            <th style={{ ...th, width: 60, textAlign: 'center' }}>👎</th>
            <th style={th}>Voters</th>
          </tr>
        </thead>
        <tbody>
          {poll.options.map((opt: PollOption) => {
            const votes = (poll.votes || []).filter(v => v.option_id === opt.id)
            const yes = votes.filter(v => v.choice === 'yes')
            const maybe = votes.filter(v => v.choice === 'maybe')
            const no = votes.filter(v => v.choice === 'no')
            return (
              <tr key={opt.id}>
                <td style={td}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <Calendar size={12} style={{ color: 'var(--text-faint)' }} />
                    <span>{opt.start_date} → {opt.end_date}</span>
                  </div>
                </td>
                <td style={{ ...td, textAlign: 'center', color: '#16a34a', fontWeight: 600 }}>{yes.length}</td>
                <td style={{ ...td, textAlign: 'center', color: '#ca8a04' }}>{maybe.length}</td>
                <td style={{ ...td, textAlign: 'center', color: '#dc2626' }}>{no.length}</td>
                <td style={td}>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                    {yes.map(v => <Chip key={v.id} text={v.voter_name} bg="#dcfce7" color="#15803d" />)}
                    {maybe.map(v => <Chip key={v.id} text={v.voter_name} bg="#fef9c3" color="#854d0e" />)}
                    {no.map(v => <Chip key={v.id} text={v.voter_name} bg="#fee2e2" color="#991b1b" />)}
                  </div>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>

      {voterList.length > 0 && (
        <div style={{ marginTop: 12, fontSize: 11, color: 'var(--text-faint)' }}>
          {voterList.length} voter{voterList.length === 1 ? '' : 's'} so far
        </div>
      )}
    </div>
  )
}

const th: React.CSSProperties = { textAlign: 'left', fontSize: 10, color: 'var(--text-faint)', padding: '6px 8px', borderBottom: '1px solid var(--border-faint)', textTransform: 'uppercase', letterSpacing: '0.04em', fontWeight: 600 }
const td: React.CSSProperties = { padding: '8px', borderBottom: '1px solid var(--border-faint)', verticalAlign: 'middle' }

function Chip({ text, bg, color }: { text: string; bg: string; color: string }) {
  return <span style={{ padding: '2px 6px', borderRadius: 999, background: bg, color, fontSize: 10, fontWeight: 600 }}>{text}</span>
}

function CreatePollModal({ onClose, onCreated }: { onClose: () => void; onCreated: (p: Poll) => void }) {
  const toast = useToast()
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [options, setOptions] = useState<{ start_date: string; end_date: string }[]>([{ start_date: '', end_date: '' }, { start_date: '', end_date: '' }])
  const [busy, setBusy] = useState(false)

  const updateOption = (i: number, field: 'start_date' | 'end_date', value: string) => {
    setOptions(opts => opts.map((o, idx) => idx === i ? { ...o, [field]: value } : o))
  }
  const addOption = () => setOptions(opts => [...opts, { start_date: '', end_date: '' }])
  const removeOption = (i: number) => setOptions(opts => opts.length > 1 ? opts.filter((_, idx) => idx !== i) : opts)

  const submit = async () => {
    if (!title.trim()) { toast.error('Title required'); return }
    const filled = options.filter(o => o.start_date && o.end_date)
    if (filled.length === 0) { toast.error('Add at least one date range'); return }
    setBusy(true)
    try {
      const r = await pollsApi.create({ title: title.trim(), description: description.trim() || null, options: filled })
      onCreated(r.poll)
    } catch (err: unknown) {
      const ax = err as { response?: { data?: { error?: string } }; message?: string }
      toast.error(ax.response?.data?.error ?? ax.message ?? 'Could not create poll')
      setBusy(false)
    }
  }

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div onClick={e => e.stopPropagation()} style={{ width: '100%', maxWidth: 540, background: 'var(--bg-card)', borderRadius: 14, padding: 24 }}>
        <h2 style={{ margin: '0 0 16px', fontSize: 18, fontWeight: 700, color: 'var(--text-primary)' }}>New poll</h2>
        <label style={{ display: 'block', marginBottom: 12 }}>
          <span style={{ display: 'block', fontSize: 12, color: 'var(--text-muted)', fontWeight: 600, marginBottom: 4 }}>Title</span>
          <input
            value={title} onChange={e => setTitle(e.target.value)}
            placeholder="e.g. Easter trip dates?"
            style={{ width: '100%', padding: 9, borderRadius: 8, border: '1px solid var(--border-primary)', background: 'var(--bg-input)', color: 'var(--text-primary)', fontFamily: 'inherit', fontSize: 14, boxSizing: 'border-box' }}
          />
        </label>
        <label style={{ display: 'block', marginBottom: 12 }}>
          <span style={{ display: 'block', fontSize: 12, color: 'var(--text-muted)', fontWeight: 600, marginBottom: 4 }}>Description (optional)</span>
          <textarea
            value={description} onChange={e => setDescription(e.target.value)}
            rows={2}
            style={{ width: '100%', padding: 9, borderRadius: 8, border: '1px solid var(--border-primary)', background: 'var(--bg-input)', color: 'var(--text-primary)', fontFamily: 'inherit', fontSize: 13, boxSizing: 'border-box', resize: 'vertical' }}
          />
        </label>
        <div style={{ marginBottom: 12 }}>
          <span style={{ display: 'block', fontSize: 12, color: 'var(--text-muted)', fontWeight: 600, marginBottom: 6 }}>Candidate date ranges</span>
          {options.map((o, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
              <input type="date" value={o.start_date} onChange={e => updateOption(i, 'start_date', e.target.value)} style={inputStyle} />
              <span style={{ color: 'var(--text-faint)' }}>→</span>
              <input type="date" value={o.end_date} onChange={e => updateOption(i, 'end_date', e.target.value)} style={inputStyle} />
              <button type="button" onClick={() => removeOption(i)} disabled={options.length === 1} style={{ background: 'none', border: 'none', cursor: options.length === 1 ? 'not-allowed' : 'pointer', color: 'var(--text-faint)', padding: 4 }}>
                <Trash2 size={14} />
              </button>
            </div>
          ))}
          <button type="button" onClick={addOption} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '4px 10px', borderRadius: 6, border: '1px dashed var(--border-primary)', background: 'transparent', cursor: 'pointer', fontSize: 12, color: 'var(--text-muted)', fontFamily: 'inherit' }}>
            <Plus size={11} /> Add range
          </button>
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
          <button type="button" onClick={onClose} disabled={busy} style={btnSecondary}>Cancel</button>
          <button type="button" onClick={submit} disabled={busy} style={btnPrimary}>{busy ? 'Creating…' : 'Create poll'}</button>
        </div>
      </div>
    </div>
  )
}

const inputStyle: React.CSSProperties = { padding: '6px 8px', borderRadius: 6, border: '1px solid var(--border-primary)', background: 'var(--bg-input)', color: 'var(--text-primary)', fontSize: 13, fontFamily: 'inherit' }
const btnSecondary: React.CSSProperties = { padding: '8px 16px', borderRadius: 8, border: '1px solid var(--border-primary)', background: 'transparent', color: 'var(--text-primary)', cursor: 'pointer', fontSize: 13, fontFamily: 'inherit' }
const btnPrimary: React.CSSProperties = { padding: '8px 16px', borderRadius: 8, border: 'none', background: 'var(--accent)', color: 'var(--accent-text)', cursor: 'pointer', fontSize: 13, fontWeight: 600, fontFamily: 'inherit' }
