import { describe, it, expect, beforeEach } from 'vitest'
import { _resetForTests } from './localDb'
import {
  enqueue,
  process,
  peek,
  count,
  clear,
  BACKOFF_FIRST_DELAY_MS,
  MAX_ATTEMPTS,
  type MutationTransport,
} from './mutationQueue'

beforeEach(async () => {
  await _resetForTests()
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase('460tp-local')
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error)
    req.onblocked = () => resolve()
  })
})

function transportThat(handlers: Array<(callIndex: number) => Awaited<ReturnType<MutationTransport['send']>>>): MutationTransport {
  let i = 0
  return {
    send: async () => {
      const handler = handlers[i] ?? handlers[handlers.length - 1]
      const result = handler(i)
      i++
      return result
    },
  }
}

describe('mutationQueue', () => {
  it('enqueue persists; peek returns the same record', async () => {
    const m = await enqueue({ endpoint: '/trips/1/days/2', method: 'PUT', payload: { title: 'x' } })
    expect(m.status).toBe('pending')
    expect(m.attempts).toBe(0)
    const all = await peek()
    expect(all).toHaveLength(1)
    expect(all[0].id).toBe(m.id)
  })

  it('process: ok response deletes the row, returns succeeded=1', async () => {
    await enqueue({ endpoint: '/x', method: 'POST' })
    const result = await process(transportThat([() => ({ kind: 'ok', status: 200, body: {} })]))
    expect(result).toMatchObject({ processed: 1, succeeded: 1, deferred: 0, failed: 0 })
    expect(await count()).toBe(0)
  })

  it('process: retryable response keeps the row pending with next_attempt_at scheduled', async () => {
    const m = await enqueue({ endpoint: '/x', method: 'POST' })
    const now = m.next_attempt_at // process exactly when the row is due
    const result = await process(transportThat([() => ({ kind: 'retryable', error: 'network' })]), now)
    expect(result.deferred).toBe(1)
    expect(result.succeeded).toBe(0)

    const [row] = await peek()
    expect(row.status).toBe('pending')
    expect(row.attempts).toBe(1)
    expect(row.next_attempt_at).toBe(now + BACKOFF_FIRST_DELAY_MS)
    expect(row.last_error).toBe('network')
  })

  it('process: skips rows whose next_attempt_at is in the future', async () => {
    const m = await enqueue({ endpoint: '/x', method: 'POST' })
    let now = m.next_attempt_at
    await process(transportThat([() => ({ kind: 'retryable', error: 'fail' })]), now)
    // Process again at the same instant: row not due yet, transport not called.
    let calls = 0
    const t = { send: async () => { calls++; return { kind: 'ok' as const, status: 200, body: {} } } }
    const result = await process(t, now)
    expect(calls).toBe(0)
    expect(result.processed).toBe(0)
    // Advance past backoff: row processes.
    now += BACKOFF_FIRST_DELAY_MS + 1
    await process(t, now)
    expect(calls).toBe(1)
  })

  it('process: permanent failure flips status to failed', async () => {
    await enqueue({ endpoint: '/x', method: 'POST' })
    await process(transportThat([() => ({ kind: 'permanent', status: 400, error: 'bad input' })]))
    const [row] = await peek()
    expect(row.status).toBe('failed')
    expect(row.last_error).toBe('bad input')
  })

  it('process: failed rows are not retried', async () => {
    await enqueue({ endpoint: '/x', method: 'POST' })
    await process(transportThat([() => ({ kind: 'permanent', status: 400, error: 'nope' })]))
    let calls = 0
    const t = { send: async () => { calls++; return { kind: 'ok' as const, status: 200, body: {} } } }
    await process(t, Number.MAX_SAFE_INTEGER - 1)
    expect(calls).toBe(0)
  })

  it('process: gives up after MAX_ATTEMPTS retries', async () => {
    const m = await enqueue({ endpoint: '/x', method: 'POST' })
    let now = m.next_attempt_at
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      await process(transportThat([() => ({ kind: 'retryable', error: 'flake' })]), now)
      const [row] = await peek()
      // Advance to the next due time so the next iteration runs.
      now = row.next_attempt_at
    }
    const [row] = await peek()
    expect(row.status).toBe('failed')
    expect(row.attempts).toBe(MAX_ATTEMPTS)
  })

  it('count() and clear()', async () => {
    await enqueue({ endpoint: '/a', method: 'POST' })
    await enqueue({ endpoint: '/b', method: 'POST' })
    expect(await count()).toBe(2)
    await clear()
    expect(await count()).toBe(0)
  })
})
