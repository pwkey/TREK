// Tests focus on the transport-result classification — the timer + window
// listener wiring is exercised manually in the browser. We import _transport
// for direct invocation and stub out axios via vi.mock.
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock axios BEFORE importing the worker so the module-level import picks
// up the mock.
vi.mock('axios', () => ({
  default: { request: vi.fn() },
}))
vi.mock('../api/websocket', () => ({ getSocketId: () => null }))

import axios from 'axios'
import { _transport } from './syncWorker'
import type { QueuedMutationRecord } from './localDb'

const mockedRequest = (axios as unknown as { request: ReturnType<typeof vi.fn> }).request

const baseMutation: QueuedMutationRecord = {
  id: 'm-1', endpoint: '/trips/1/days/2', method: 'PUT', payload: { title: 'x' },
  observed_updated_at: null, created_at: 0, attempts: 0, next_attempt_at: 0, last_error: null, status: 'pending',
}

beforeEach(() => {
  mockedRequest.mockReset()
})

describe('syncWorker.transport.send', () => {
  it('returns ok on a 2xx response', async () => {
    mockedRequest.mockResolvedValue({ status: 200, data: { day: { id: 2 } } })
    const result = await _transport.send(baseMutation)
    expect(result.kind).toBe('ok')
    if (result.kind === 'ok') {
      expect(result.status).toBe(200)
      expect(result.body).toEqual({ day: { id: 2 } })
    }
  })

  it('classifies 5xx as retryable', async () => {
    mockedRequest.mockRejectedValue({ response: { status: 503 }, message: 'unavailable' })
    const result = await _transport.send(baseMutation)
    expect(result.kind).toBe('retryable')
    if (result.kind === 'retryable') expect(result.status).toBe(503)
  })

  it('classifies 408 + 429 as retryable', async () => {
    mockedRequest.mockRejectedValueOnce({ response: { status: 408 }, message: 'timeout' })
    expect((await _transport.send(baseMutation)).kind).toBe('retryable')
    mockedRequest.mockRejectedValueOnce({ response: { status: 429 }, message: 'rate limit' })
    expect((await _transport.send(baseMutation)).kind).toBe('retryable')
  })

  it('classifies network unreachable as retryable', async () => {
    mockedRequest.mockRejectedValue({ message: 'Network Error' })
    const result = await _transport.send(baseMutation)
    expect(result.kind).toBe('retryable')
  })

  it('classifies 4xx (other than 408/429) as permanent', async () => {
    mockedRequest.mockRejectedValue({ response: { status: 400, data: { error: 'bad' } } })
    const result = await _transport.send(baseMutation)
    expect(result.kind).toBe('permanent')
    if (result.kind === 'permanent') {
      expect(result.status).toBe(400)
      expect(result.error).toBe('bad')
    }
  })

  it('forwards X-Client-Mutation-Id and If-Unmodified-Since headers', async () => {
    mockedRequest.mockResolvedValue({ status: 200, data: {} })
    await _transport.send({ ...baseMutation, observed_updated_at: '2027-06-10T12:00:00Z' })
    const call = mockedRequest.mock.calls[0][0]
    expect(call.headers['X-Client-Mutation-Id']).toBe('m-1')
    expect(call.headers['If-Unmodified-Since']).toBe('2027-06-10T12:00:00Z')
  })
})
