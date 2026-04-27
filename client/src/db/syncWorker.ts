// [460-fork] Milestone 5 slice 3 — drain the mutation queue while the tab is open.
//
// Lives in the page (no service-worker Background Sync yet — slice 5).
// Triggers:
//   - Once at startup so anything left over from a previous session replays.
//   - Whenever the browser fires the 'online' event.
//   - On a 30s interval as a fallback for transient backend unavailability.
//
// The HTTP transport is a real axios call; status mapping mirrors what the
// interceptor in api/client.ts does so that retryable vs permanent stays
// consistent across the two paths.
import axios, { type AxiosError, type Method } from 'axios'
import { process as processQueue, type MutationTransport, type TransportResult } from './mutationQueue'
import { getSocketId } from '../api/websocket'

const TICK_INTERVAL_MS = 30_000

const transport: MutationTransport = {
  send: async (m): Promise<TransportResult> => {
    try {
      const sid = getSocketId()
      const headers: Record<string, string> = { 'X-Client-Mutation-Id': m.id }
      if (sid) headers['X-Socket-Id'] = sid
      if (m.observed_updated_at) headers['If-Unmodified-Since'] = m.observed_updated_at
      const resp = await axios.request({
        method: m.method as Method,
        url: m.endpoint,
        data: m.payload,
        baseURL: '/api',
        withCredentials: true,
        headers,
      })
      return { kind: 'ok', status: resp.status, body: resp.data }
    } catch (err) {
      const ax = err as AxiosError
      const status = ax.response?.status
      if (status === undefined) return { kind: 'retryable', error: ax.message || 'network error' }
      if (status >= 500 || status === 408 || status === 429) {
        return { kind: 'retryable', status, error: `HTTP ${status}` }
      }
      const body = ax.response?.data as { error?: string } | undefined
      return { kind: 'permanent', status, error: body?.error || `HTTP ${status}` }
    }
  },
}

let intervalId: number | null = null
let onlineHandler: (() => void) | null = null

export function startSyncWorker(): void {
  if (intervalId !== null) return
  const tick = () => {
    void processQueue(transport).catch((err) => {
      console.error('[syncWorker] queue process failed:', err)
    })
  }
  onlineHandler = tick
  if (typeof window !== 'undefined') window.addEventListener('online', onlineHandler)
  intervalId = (typeof window !== 'undefined' ? window.setInterval(tick, TICK_INTERVAL_MS) : null) as number | null
  // Try once immediately so leftovers from a previous session replay fast.
  tick()
}

export function stopSyncWorker(): void {
  if (intervalId !== null && typeof window !== 'undefined') window.clearInterval(intervalId)
  if (onlineHandler && typeof window !== 'undefined') window.removeEventListener('online', onlineHandler)
  intervalId = null
  onlineHandler = null
}

/** Test-only — exported so unit tests can call the same transport without
 *  having to start the timer. */
export const _transport = transport
