// [460-fork] Offline auth: a network failure during loadUser must NOT log the
// user out (they'd be locked out of their cached trip offline); only a real 401
// clears auth.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../api/client', () => ({ authApi: { me: vi.fn() } }))
vi.mock('../api/websocket', () => ({ connect: vi.fn(), disconnect: vi.fn() }))

import { useAuthStore } from './authStore'
import { authApi } from '../api/client'

const me = authApi.me as unknown as ReturnType<typeof vi.fn>

beforeEach(() => {
  me.mockReset()
  useAuthStore.setState({
    user: { id: 1, email: 'a@b.c' } as never,
    isAuthenticated: true,
    isLoading: false,
  })
})

describe('offline auth', () => {
  it('stays authenticated when /auth/me fails with a network error (offline)', async () => {
    me.mockRejectedValueOnce({ message: 'Network Error' }) // no .response → not a 401
    await useAuthStore.getState().loadUser()
    expect(useAuthStore.getState().isAuthenticated).toBe(true)
    expect(useAuthStore.getState().user).not.toBeNull()
  })

  it('clears auth on a genuine 401 (expired/invalid token)', async () => {
    me.mockRejectedValueOnce({ response: { status: 401 } })
    await useAuthStore.getState().loadUser()
    expect(useAuthStore.getState().isAuthenticated).toBe(false)
    expect(useAuthStore.getState().user).toBeNull()
  })

  it('confirms auth when the server responds', async () => {
    useAuthStore.setState({ user: null, isAuthenticated: false })
    me.mockResolvedValueOnce({ user: { id: 2, email: 'x@y.z' } })
    await useAuthStore.getState().loadUser()
    expect(useAuthStore.getState().isAuthenticated).toBe(true)
    expect(useAuthStore.getState().user?.id).toBe(2)
  })
})
