// [460-fork] Journal save-race + 409 recovery (the "only the first portion
// saved" data-loss bug reported mid-trip in Morocco).
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../api/client', () => ({
  journalApi: { get: vi.fn(), update: vi.fn() },
}))

import { journalApi } from '../../api/client'
import { createJournalSlice, type DayJournal } from './journalSlice'

const upd = journalApi.update as unknown as ReturnType<typeof vi.fn>
const getj = journalApi.get as unknown as ReturnType<typeof vi.fn>

function makeStore(seed: DayJournal | null) {
  let state: Record<string, unknown> = { dayJournals: { '1': seed } }
  const set = (partial: unknown) => {
    const next = typeof partial === 'function' ? (partial as (s: unknown) => object)(state) : partial
    state = { ...state, ...(next as object) }
  }
  const get = () => state as never
  const slice = createJournalSlice(set as never, get as never)
  return { slice, journals: () => (state.dayJournals as Record<string, DayJournal | null>) }
}

const j = (content: string, updated_at: string): DayJournal =>
  ({ day_id: 1, content_markdown: content, updated_at, updated_by: 1 })

beforeEach(() => { upd.mockReset(); getj.mockReset() })

describe('journalSlice save race', () => {
  it('serializes overlapping saves so the second sends a fresh precondition (no 409, no lost text)', async () => {
    const { slice, journals } = makeStore(j('', 'T0'))
    // First save resolves slowly; second is fired while it is still in flight.
    upd.mockImplementationOnce(async () => { await new Promise(r => setTimeout(r, 20)); return { journal: j('First', 'T1') } })
    upd.mockImplementationOnce(async () => ({ journal: j('First Second', 'T2') }))

    const a = slice.updateJournal(1, 1, 'First')
    const b = slice.updateJournal(1, 1, 'First Second')
    await Promise.all([a, b])

    expect(upd).toHaveBeenCalledTimes(2)
    // The SECOND save must carry T1 — the timestamp the first save committed —
    // not the stale T0 it would have read without serialization.
    expect(upd.mock.calls[0][3]).toBe('T0')
    expect(upd.mock.calls[1][3]).toBe('T1')
    expect(journals()['1']?.content_markdown).toBe('First Second')
  })

  it('recovers from a 409 by refetching the timestamp and retrying (last-write-wins)', async () => {
    const { slice, journals } = makeStore(j('old', 'T0'))
    upd.mockRejectedValueOnce({ response: { status: 409 } })
    getj.mockResolvedValueOnce({ journal: j('theirs', 'Tnew') })
    upd.mockResolvedValueOnce({ journal: j('mine wins', 'T2') })

    await slice.updateJournal(1, 1, 'mine wins') // must NOT throw

    expect(getj).toHaveBeenCalledTimes(1)
    expect(upd).toHaveBeenCalledTimes(2)
    expect(upd.mock.calls[1][3]).toBe('Tnew') // retried with the server's current stamp
    expect(journals()['1']?.content_markdown).toBe('mine wins')
  })

  it('offline (network error) is swallowed for the M5 queue, not surfaced', async () => {
    const { slice } = makeStore(j('', 'T0'))
    upd.mockRejectedValueOnce({ message: 'Network Error' }) // no response → queueable
    await expect(slice.updateJournal(1, 1, 'typed offline')).resolves.toBeUndefined()
  })
})
