// [460-fork] Milestone 5 — regression for the response-interceptor queueing.
//
// Before the fix, error.config.data had already been transformed to a JSON
// string by axios's dispatchRequest, so the queued payload arrived as
// `'{"title":"x"}'`. Replays then re-sent that string under the default
// form-urlencoded Content-Type and the server silently dropped the fields.
//
// These tests fail without the request-interceptor stash that captures
// config.data + If-Unmodified-Since at request time.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import apiClient from './client'
import { _resetForTests } from '../db/localDb'
import { peek } from '../db/mutationQueue'

const originalAdapter = apiClient.defaults.adapter

beforeEach(async () => {
  await _resetForTests()
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase('460tp-local')
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error)
    req.onblocked = () => resolve()
  })
  apiClient.defaults.adapter = (config) => {
    const err = new Error('Network Error') as Error & { config: typeof config }
    err.config = config
    return Promise.reject(err)
  }
})

afterEach(() => {
  apiClient.defaults.adapter = originalAdapter
})

describe('apiClient response interceptor — offline queueing', () => {
  it('queues the original object payload, not the JSON-stringified body', async () => {
    await apiClient.put('/trips/1/days/2', { title: 'new title' }).catch(() => undefined)
    const all = await peek()
    expect(all).toHaveLength(1)
    expect(all[0].endpoint).toBe('/trips/1/days/2')
    expect(all[0].method).toBe('PUT')
    expect(all[0].payload).toEqual({ title: 'new title' })
  })

  it('forwards If-Unmodified-Since as observed_updated_at on the queued row', async () => {
    await apiClient.put(
      '/trips/1/days/2',
      { title: 'x' },
      { headers: { 'If-Unmodified-Since': '2027-06-10T12:00:00Z' } },
    ).catch(() => undefined)
    const all = await peek()
    expect(all).toHaveLength(1)
    expect(all[0].observed_updated_at).toBe('2027-06-10T12:00:00Z')
  })

  it('does not queue GET requests', async () => {
    await apiClient.get('/trips/1').catch(() => undefined)
    const all = await peek()
    expect(all).toHaveLength(0)
  })
})
