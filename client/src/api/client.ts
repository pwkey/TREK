import axios, { AxiosInstance } from 'axios'
import { getSocketId } from './websocket'

const apiClient: AxiosInstance = axios.create({
  baseURL: '/api',
  withCredentials: true,
  headers: {
    'Content-Type': 'application/json',
  },
})

// Request interceptor - add socket ID + auto-generate mutation id
apiClient.interceptors.request.use(
  (config) => {
    const sid = getSocketId()
    if (sid) {
      config.headers['X-Socket-Id'] = sid
    }
    // [460-fork] Milestone 5 — auto-attach a fresh client_mutation_id to
    // every state-changing request (POST/PUT/PATCH/DELETE) so the server
    // idempotency middleware can dedupe retries. Callers that want to
    // control the id (e.g. queue replays) set it explicitly and we leave
    // their value alone.
    const method = (config.method || 'get').toLowerCase()
    if (method !== 'get' && method !== 'head' && method !== 'options') {
      const headers = config.headers as Record<string, unknown>
      const existing = (headers['X-Client-Mutation-Id'] || headers['x-client-mutation-id']) as string | undefined
      if (!existing) {
        const id = (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
          ? (crypto as Crypto).randomUUID()
          : `mid-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`
        config.headers['X-Client-Mutation-Id'] = id
      }
      // [460-fork] Milestone 5 — stash the raw payload BEFORE axios's
      // dispatchRequest mutates config.data into a JSON string. The
      // response interceptor needs the original object so the queued
      // mutation can be replayed faithfully; without this stash, replays
      // re-send the JSON string body under the default form-urlencoded
      // Content-Type and the server can't parse the fields.
      ;(config as { _460OriginalData?: unknown })._460OriginalData = config.data
    }
    return config
  },
  (error) => Promise.reject(error)
)

// Response interceptor - handle 401, MFA, and queue retryable mutation failures
apiClient.interceptors.response.use(
  (response) => response,
  async (error) => {
    if (error.response?.status === 401 && (error.response?.data as { code?: string } | undefined)?.code === 'AUTH_REQUIRED') {
      if (!window.location.pathname.includes('/login') && !window.location.pathname.includes('/register') && !window.location.pathname.startsWith('/shared/') && !window.location.pathname.startsWith('/poll/')) {
        const currentPath = window.location.pathname + window.location.search
        window.location.href = '/login?redirect=' + encodeURIComponent(currentPath)
      }
    }
    if (
      error.response?.status === 403 &&
      (error.response?.data as { code?: string } | undefined)?.code === 'MFA_REQUIRED' &&
      !window.location.pathname.startsWith('/settings')
    ) {
      window.location.href = '/settings?mfa=required'
    }

    // [460-fork] Milestone 5 — auto-queue retryable mutation failures.
    // Network unreachable, 5xx, 408 (timeout), 429 (rate-limited) → the
    // mutation goes into the IndexedDB queue and the syncWorker replays it
    // when connectivity / load improves. The original error still propagates
    // to the caller so existing toasts continue to fire; subsequent slices
    // will introduce optimistic UX that suppresses the error when the call
    // succeeds in queueing.
    try {
      const config = error.config as { method?: string; url?: string; data?: unknown; headers?: Record<string, unknown> } | undefined
      const method = (config?.method || 'get').toLowerCase()
      const isMutation = method !== 'get' && method !== 'head' && method !== 'options'
      const status = error.response?.status as number | undefined
      const isRetryable = status === undefined || status >= 500 || status === 408 || status === 429
      if (isMutation && isRetryable && config?.url) {
        const headers = config.headers || {}
        const mutationId = (headers['X-Client-Mutation-Id'] || headers['x-client-mutation-id']) as string | undefined
        if (mutationId) {
          const stashed = (config as { _460OriginalData?: unknown })._460OriginalData
          const ifUnmodified = (headers['If-Unmodified-Since'] || headers['if-unmodified-since']) as string | undefined
          const { enqueue } = await import('../db/mutationQueue')
          await enqueue({
            id: mutationId,
            endpoint: config.url,
            method: method.toUpperCase() as 'POST' | 'PUT' | 'DELETE',
            payload: stashed !== undefined ? stashed : config.data,
            observed_updated_at: ifUnmodified ?? null,
          })
        }
      }
    } catch (queueErr) {
      // If queueing itself fails, let the original network error propagate
      // unchanged — there is nothing useful we can do here.
      console.error('[client] failed to enqueue retryable mutation:', queueErr)
    }

    return Promise.reject(error)
  }
)

export const authApi = {
  register: (data: { username: string; email: string; password: string; invite_token?: string }) => apiClient.post('/auth/register', data).then(r => r.data),
  validateInvite: (token: string) => apiClient.get(`/auth/invite/${token}`).then(r => r.data),
  login: (data: { email: string; password: string }) => apiClient.post('/auth/login', data).then(r => r.data),
  verifyMfaLogin: (data: { mfa_token: string; code: string }) => apiClient.post('/auth/mfa/verify-login', data).then(r => r.data),
  mfaSetup: () => apiClient.post('/auth/mfa/setup', {}).then(r => r.data),
  mfaEnable: (data: { code: string }) => apiClient.post('/auth/mfa/enable', data).then(r => r.data as { success: boolean; mfa_enabled: boolean; backup_codes?: string[] }),
  mfaDisable: (data: { password: string; code: string }) => apiClient.post('/auth/mfa/disable', data).then(r => r.data),
  me: () => apiClient.get('/auth/me').then(r => r.data),
  updateMapsKey: (key: string | null) => apiClient.put('/auth/me/maps-key', { maps_api_key: key }).then(r => r.data),
  updateApiKeys: (data: Record<string, string | null>) => apiClient.put('/auth/me/api-keys', data).then(r => r.data),
  updateSettings: (data: Record<string, unknown>) => apiClient.put('/auth/me/settings', data).then(r => r.data),
  getSettings: () => apiClient.get('/auth/me/settings').then(r => r.data),
  listUsers: () => apiClient.get('/auth/users').then(r => r.data),
  uploadAvatar: (formData: FormData) => apiClient.post('/auth/avatar', formData, { headers: { 'Content-Type': 'multipart/form-data' } }).then(r => r.data),
  deleteAvatar: () => apiClient.delete('/auth/avatar').then(r => r.data),
  getAppConfig: () => apiClient.get('/auth/app-config').then(r => r.data),
  updateAppSettings: (data: Record<string, unknown>) => apiClient.put('/auth/app-settings', data).then(r => r.data),
  validateKeys: () => apiClient.get('/auth/validate-keys').then(r => r.data),
  travelStats: () => apiClient.get('/auth/travel-stats').then(r => r.data),
  changePassword: (data: { current_password: string; new_password: string }) => apiClient.put('/auth/me/password', data).then(r => r.data),
  deleteOwnAccount: () => apiClient.delete('/auth/me').then(r => r.data),
  demoLogin: () => apiClient.post('/auth/demo-login').then(r => r.data),
  mcpTokens: {
    list: () => apiClient.get('/auth/mcp-tokens').then(r => r.data),
    create: (name: string) => apiClient.post('/auth/mcp-tokens', { name }).then(r => r.data),
    delete: (id: number) => apiClient.delete(`/auth/mcp-tokens/${id}`).then(r => r.data),
  },
  // [460-fork] Partner pairing (Milestone 3)
  partner: {
    get: () => apiClient.get('/auth/me/partner').then(r => r.data),
    invite: (data: { identifier: string; message?: string; clientMutationId?: string }) =>
      apiClient.post('/auth/me/partner/invites', { identifier: data.identifier, message: data.message }, {
        headers: data.clientMutationId ? { 'X-Client-Mutation-Id': data.clientMutationId } : undefined,
      }).then(r => r.data),
    cancelInvite: (inviteId: string) =>
      apiClient.delete(`/auth/me/partner/invites/${inviteId}`).then(r => r.data),
    respond: (notificationId: number, response: 'positive' | 'negative') =>
      apiClient.post(`/notifications/in-app/${notificationId}/respond`, { response }).then(r => r.data),
    unpair: () => apiClient.delete('/auth/me/partner').then(r => r.data),
    backfillTrips: () => apiClient.post('/auth/me/partner/backfill-trips').then(r => r.data),
  },
}

// [460-fork] Milestone 7 slice 3 — shape of the dry-run / apply report.
export interface ImportReport {
  schema_version: number
  format: 'metadata-only' | 'bundle' | 'unknown'
  source_trip: { title: string; start_date: string | null; end_date: string | null }
  would_create: {
    trip: number
    days: number
    places: number
    reservations: number
    photos_with_binary: number
    photos_metadata_only: number
    journals: number
    budget_items: number
    packing_items: number
    todo_items: number
    accommodations: number
  }
  warnings: string[]
  errors: string[]
}

export const tripsApi = {
  list: (params?: Record<string, unknown>) => apiClient.get('/trips', { params }).then(r => r.data),
  create: (data: Record<string, unknown>) => apiClient.post('/trips', data).then(r => r.data),
  get: (id: number | string) => apiClient.get(`/trips/${id}`).then(r => r.data),
  update: (id: number | string, data: Record<string, unknown>) => apiClient.put(`/trips/${id}`, data).then(r => r.data),
  delete: (id: number | string) => apiClient.delete(`/trips/${id}`).then(r => r.data),
  uploadCover: (id: number | string, formData: FormData) => apiClient.post(`/trips/${id}/cover`, formData, { headers: { 'Content-Type': 'multipart/form-data' } }).then(r => r.data),
  archive: (id: number | string) => apiClient.put(`/trips/${id}`, { is_archived: true }).then(r => r.data),
  unarchive: (id: number | string) => apiClient.put(`/trips/${id}`, { is_archived: false }).then(r => r.data),
  getMembers: (id: number | string) => apiClient.get(`/trips/${id}/members`).then(r => r.data),
  addMember: (id: number | string, identifier: string) => apiClient.post(`/trips/${id}/members`, { identifier }).then(r => r.data),
  removeMember: (id: number | string, userId: number) => apiClient.delete(`/trips/${id}/members/${userId}`).then(r => r.data),
  copy: (id: number | string, data?: { title?: string; include_partner?: boolean }) => apiClient.post(`/trips/${id}/copy`, data || {}).then(r => r.data),
  offlineBundle: (id: number | string) => apiClient.get(`/trips/${id}/offline-bundle`).then(r => r.data),
  // [460-fork] Milestone 7 slice 3 — import a previously-exported trip.
  // Two-phase: first call dryRun (default), inspect the report, then
  // call apply if the user confirms.
  importDryRun: (file: File) => {
    const fd = new FormData()
    fd.append('file', file)
    return apiClient.post('/trips/import', fd, {
      headers: { 'Content-Type': 'multipart/form-data' },
    }).then(r => r.data as { dry_run: true; report: ImportReport })
  },
  importApply: (file: File) => {
    const fd = new FormData()
    fd.append('file', file)
    return apiClient.post('/trips/import?dry_run=false', fd, {
      headers: { 'Content-Type': 'multipart/form-data' },
    }).then(r => r.data as { dry_run: false; report: ImportReport; result: { trip_id: number; created: ImportReport['would_create'] } })
  },

  // [460-fork] Milestone 7 slices 1+2 — JSON-only or zip-bundle export.
  // Returns true when the user actually saved a file, false when they
  // cancelled. Throws on network/server failure so callers can toast.
  exportTripDownload: async (id: number | string, mode: 'json' | 'bundle' = 'json'): Promise<boolean> => {
    const path = mode === 'bundle' ? `/trips/${id}/export/bundle` : `/trips/${id}/export`
    const resp = await apiClient.get(path, { responseType: 'blob' })
    const blob = resp.data as Blob
    // Server sets Content-Disposition with the filename; pull it out so
    // the browser save dialog defaults to a sensible name.
    const cd = (resp.headers['content-disposition'] || '') as string
    const m = cd.match(/filename="([^"]+)"/)
    const fallbackExt = mode === 'bundle' ? 'zip' : 'json'
    const filename = m ? m[1] : `trip-${id}.${fallbackExt}`

    // Prefer the File System Access API (Chrome/Edge) so the user picks
    // where to save and the file definitely lands there. Falls back to
    // the anchor-click pattern on browsers without showSaveFilePicker
    // (Firefox, Safari).
    const w = window as unknown as {
      showSaveFilePicker?: (opts: {
        suggestedName?: string
        types?: { description: string; accept: Record<string, string[]> }[]
      }) => Promise<FileSystemFileHandle>
    }
    if (typeof w.showSaveFilePicker === 'function') {
      try {
        const handle = await w.showSaveFilePicker({
          suggestedName: filename,
          types: [
            mode === 'bundle'
              ? { description: '460 Trip Planner bundle', accept: { 'application/zip': ['.zip'] } }
              : { description: '460 Trip Planner export', accept: { 'application/json': ['.json'] } },
          ],
        })
        const writable = await (handle as unknown as { createWritable: () => Promise<{ write: (b: Blob) => Promise<void>; close: () => Promise<void> }> }).createWritable()
        await writable.write(blob)
        await writable.close()
        return true
      } catch (err: unknown) {
        // AbortError = user cancelled the save dialog. Anything else =
        // fall through to the anchor-click fallback so we still try.
        if ((err as { name?: string })?.name === 'AbortError') return false
      }
    }

    // Fallback: anchor-click. Don't revoke the object URL synchronously —
    // Chrome can race the revoke against the actual download commit and
    // the file silently never lands. 60 s gives the browser plenty of
    // time to finish writing before we free the memory.
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    setTimeout(() => URL.revokeObjectURL(url), 60_000)
    return true
  },
}

export const daysApi = {
  list: (tripId: number | string) => apiClient.get(`/trips/${tripId}/days`).then(r => r.data),
  create: (tripId: number | string, data: Record<string, unknown>) => apiClient.post(`/trips/${tripId}/days`, data).then(r => r.data),
  // [460-fork] Milestone 5 slice 4 — `observedUpdatedAt` opts the caller into
  // stale-write conflict detection: the server compares to the record's
  // current updated_at and parks the mutation as a conflict on mismatch.
  update: (tripId: number | string, dayId: number | string, data: Record<string, unknown>, observedUpdatedAt?: string | null) => {
    const headers: Record<string, string> = {}
    if (observedUpdatedAt) headers['If-Unmodified-Since'] = observedUpdatedAt
    return apiClient.put(`/trips/${tripId}/days/${dayId}`, data, { headers }).then(r => r.data)
  },
  delete: (tripId: number | string, dayId: number | string) => apiClient.delete(`/trips/${tripId}/days/${dayId}`).then(r => r.data),
}

export const placesApi = {
  list: (tripId: number | string, params?: Record<string, unknown>) => apiClient.get(`/trips/${tripId}/places`, { params }).then(r => r.data),
  create: (tripId: number | string, data: Record<string, unknown>) => apiClient.post(`/trips/${tripId}/places`, data).then(r => r.data),
  get: (tripId: number | string, id: number | string) => apiClient.get(`/trips/${tripId}/places/${id}`).then(r => r.data),
  update: (tripId: number | string, id: number | string, data: Record<string, unknown>) => apiClient.put(`/trips/${tripId}/places/${id}`, data).then(r => r.data),
  delete: (tripId: number | string, id: number | string) => apiClient.delete(`/trips/${tripId}/places/${id}`).then(r => r.data),
  searchImage: (tripId: number | string, id: number | string) => apiClient.get(`/trips/${tripId}/places/${id}/image`).then(r => r.data),
  importGpx: (tripId: number | string, file: File) => {
    const fd = new FormData(); fd.append('file', file)
    return apiClient.post(`/trips/${tripId}/places/import/gpx`, fd, { headers: { 'Content-Type': 'multipart/form-data' } }).then(r => r.data)
  },
  importGoogleList: (tripId: number | string, url: string) =>
    apiClient.post(`/trips/${tripId}/places/import/google-list`, { url }).then(r => r.data),
}

export const assignmentsApi = {
  list: (tripId: number | string, dayId: number | string) => apiClient.get(`/trips/${tripId}/days/${dayId}/assignments`).then(r => r.data),
  create: (tripId: number | string, dayId: number | string, data: { place_id: number | string }) => apiClient.post(`/trips/${tripId}/days/${dayId}/assignments`, data).then(r => r.data),
  delete: (tripId: number | string, dayId: number | string, id: number) => apiClient.delete(`/trips/${tripId}/days/${dayId}/assignments/${id}`).then(r => r.data),
  reorder: (tripId: number | string, dayId: number | string, orderedIds: number[]) => apiClient.put(`/trips/${tripId}/days/${dayId}/assignments/reorder`, { orderedIds }).then(r => r.data),
  move: (tripId: number | string, assignmentId: number, newDayId: number | string, orderIndex: number | null) => apiClient.put(`/trips/${tripId}/assignments/${assignmentId}/move`, { new_day_id: newDayId, order_index: orderIndex }).then(r => r.data),
  update: (tripId: number | string, dayId: number | string, id: number, data: Record<string, unknown>) => apiClient.put(`/trips/${tripId}/days/${dayId}/assignments/${id}`, data).then(r => r.data),
  getParticipants: (tripId: number | string, id: number) => apiClient.get(`/trips/${tripId}/assignments/${id}/participants`).then(r => r.data),
  setParticipants: (tripId: number | string, id: number, userIds: number[]) => apiClient.put(`/trips/${tripId}/assignments/${id}/participants`, { user_ids: userIds }).then(r => r.data),
  updateTime: (tripId: number | string, id: number, times: Record<string, unknown>) => apiClient.put(`/trips/${tripId}/assignments/${id}/time`, times).then(r => r.data),
}

export const packingApi = {
  list: (tripId: number | string) => apiClient.get(`/trips/${tripId}/packing`).then(r => r.data),
  create: (tripId: number | string, data: Record<string, unknown>) => apiClient.post(`/trips/${tripId}/packing`, data).then(r => r.data),
  bulkImport: (tripId: number | string, items: { name: string; category?: string; quantity?: number }[]) => apiClient.post(`/trips/${tripId}/packing/import`, { items }).then(r => r.data),
  update: (tripId: number | string, id: number, data: Record<string, unknown>) => apiClient.put(`/trips/${tripId}/packing/${id}`, data).then(r => r.data),
  delete: (tripId: number | string, id: number) => apiClient.delete(`/trips/${tripId}/packing/${id}`).then(r => r.data),
  reorder: (tripId: number | string, orderedIds: number[]) => apiClient.put(`/trips/${tripId}/packing/reorder`, { orderedIds }).then(r => r.data),
  getCategoryAssignees: (tripId: number | string) => apiClient.get(`/trips/${tripId}/packing/category-assignees`).then(r => r.data),
  setCategoryAssignees: (tripId: number | string, categoryName: string, userIds: number[]) => apiClient.put(`/trips/${tripId}/packing/category-assignees/${encodeURIComponent(categoryName)}`, { user_ids: userIds }).then(r => r.data),
  applyTemplate: (tripId: number | string, templateId: number) => apiClient.post(`/trips/${tripId}/packing/apply-template/${templateId}`).then(r => r.data),
  saveAsTemplate: (tripId: number | string, name: string) => apiClient.post(`/trips/${tripId}/packing/save-as-template`, { name }).then(r => r.data),
  setBagMembers: (tripId: number | string, bagId: number, userIds: number[]) => apiClient.put(`/trips/${tripId}/packing/bags/${bagId}/members`, { user_ids: userIds }).then(r => r.data),
  listBags: (tripId: number | string) => apiClient.get(`/trips/${tripId}/packing/bags`).then(r => r.data),
  createBag: (tripId: number | string, data: { name: string; color?: string }) => apiClient.post(`/trips/${tripId}/packing/bags`, data).then(r => r.data),
  updateBag: (tripId: number | string, bagId: number, data: Record<string, unknown>) => apiClient.put(`/trips/${tripId}/packing/bags/${bagId}`, data).then(r => r.data),
  deleteBag: (tripId: number | string, bagId: number) => apiClient.delete(`/trips/${tripId}/packing/bags/${bagId}`).then(r => r.data),
}

export const todoApi = {
  list: (tripId: number | string) => apiClient.get(`/trips/${tripId}/todo`).then(r => r.data),
  create: (tripId: number | string, data: Record<string, unknown>) => apiClient.post(`/trips/${tripId}/todo`, data).then(r => r.data),
  update: (tripId: number | string, id: number, data: Record<string, unknown>) => apiClient.put(`/trips/${tripId}/todo/${id}`, data).then(r => r.data),
  delete: (tripId: number | string, id: number) => apiClient.delete(`/trips/${tripId}/todo/${id}`).then(r => r.data),
  reorder: (tripId: number | string, orderedIds: number[]) => apiClient.put(`/trips/${tripId}/todo/reorder`, { orderedIds }).then(r => r.data),
  getCategoryAssignees: (tripId: number | string) => apiClient.get(`/trips/${tripId}/todo/category-assignees`).then(r => r.data),
  setCategoryAssignees: (tripId: number | string, categoryName: string, userIds: number[]) => apiClient.put(`/trips/${tripId}/todo/category-assignees/${encodeURIComponent(categoryName)}`, { user_ids: userIds }).then(r => r.data),
}

export const tagsApi = {
  list: () => apiClient.get('/tags').then(r => r.data),
  create: (data: Record<string, unknown>) => apiClient.post('/tags', data).then(r => r.data),
  update: (id: number, data: Record<string, unknown>) => apiClient.put(`/tags/${id}`, data).then(r => r.data),
  delete: (id: number) => apiClient.delete(`/tags/${id}`).then(r => r.data),
}

export const categoriesApi = {
  list: () => apiClient.get('/categories').then(r => r.data),
  create: (data: Record<string, unknown>) => apiClient.post('/categories', data).then(r => r.data),
  update: (id: number, data: Record<string, unknown>) => apiClient.put(`/categories/${id}`, data).then(r => r.data),
  delete: (id: number) => apiClient.delete(`/categories/${id}`).then(r => r.data),
}

export const adminApi = {
  users: () => apiClient.get('/admin/users').then(r => r.data),
  createUser: (data: Record<string, unknown>) => apiClient.post('/admin/users', data).then(r => r.data),
  updateUser: (id: number, data: Record<string, unknown>) => apiClient.put(`/admin/users/${id}`, data).then(r => r.data),
  deleteUser: (id: number) => apiClient.delete(`/admin/users/${id}`).then(r => r.data),
  stats: () => apiClient.get('/admin/stats').then(r => r.data),
  saveDemoBaseline: () => apiClient.post('/admin/save-demo-baseline').then(r => r.data),
  getOidc: () => apiClient.get('/admin/oidc').then(r => r.data),
  updateOidc: (data: Record<string, unknown>) => apiClient.put('/admin/oidc', data).then(r => r.data),
  addons: () => apiClient.get('/admin/addons').then(r => r.data),
  updateAddon: (id: number | string, data: Record<string, unknown>) => apiClient.put(`/admin/addons/${id}`, data).then(r => r.data),
  checkVersion: () => apiClient.get('/admin/version-check').then(r => r.data),
  getBagTracking: () => apiClient.get('/admin/bag-tracking').then(r => r.data),
  updateBagTracking: (enabled: boolean) => apiClient.put('/admin/bag-tracking', { enabled }).then(r => r.data),
  packingTemplates: () => apiClient.get('/admin/packing-templates').then(r => r.data),
  getPackingTemplate: (id: number) => apiClient.get(`/admin/packing-templates/${id}`).then(r => r.data),
  createPackingTemplate: (data: { name: string }) => apiClient.post('/admin/packing-templates', data).then(r => r.data),
  updatePackingTemplate: (id: number, data: { name: string }) => apiClient.put(`/admin/packing-templates/${id}`, data).then(r => r.data),
  deletePackingTemplate: (id: number) => apiClient.delete(`/admin/packing-templates/${id}`).then(r => r.data),
  addTemplateCategory: (templateId: number, data: { name: string }) => apiClient.post(`/admin/packing-templates/${templateId}/categories`, data).then(r => r.data),
  updateTemplateCategory: (templateId: number, catId: number, data: { name: string }) => apiClient.put(`/admin/packing-templates/${templateId}/categories/${catId}`, data).then(r => r.data),
  deleteTemplateCategory: (templateId: number, catId: number) => apiClient.delete(`/admin/packing-templates/${templateId}/categories/${catId}`).then(r => r.data),
  addTemplateItem: (templateId: number, catId: number, data: { name: string }) => apiClient.post(`/admin/packing-templates/${templateId}/categories/${catId}/items`, data).then(r => r.data),
  updateTemplateItem: (templateId: number, itemId: number, data: { name: string }) => apiClient.put(`/admin/packing-templates/${templateId}/items/${itemId}`, data).then(r => r.data),
  deleteTemplateItem: (templateId: number, itemId: number) => apiClient.delete(`/admin/packing-templates/${templateId}/items/${itemId}`).then(r => r.data),
  listInvites: () => apiClient.get('/admin/invites').then(r => r.data),
  createInvite: (data: { max_uses: number; expires_in_days?: number }) => apiClient.post('/admin/invites', data).then(r => r.data),
  deleteInvite: (id: number) => apiClient.delete(`/admin/invites/${id}`).then(r => r.data),
  auditLog: (params?: { limit?: number; offset?: number }) =>
    apiClient.get('/admin/audit-log', { params }).then(r => r.data),
  mcpTokens: () => apiClient.get('/admin/mcp-tokens').then(r => r.data),
  deleteMcpToken: (id: number) => apiClient.delete(`/admin/mcp-tokens/${id}`).then(r => r.data),
  getPermissions: () => apiClient.get('/admin/permissions').then(r => r.data),
  updatePermissions: (permissions: Record<string, string>) => apiClient.put('/admin/permissions', { permissions }).then(r => r.data),
  rotateJwtSecret: () => apiClient.post('/admin/rotate-jwt-secret').then(r => r.data),
  sendTestNotification: (data: Record<string, unknown>) =>
    apiClient.post('/admin/dev/test-notification', data).then(r => r.data),
  getNotificationPreferences: () => apiClient.get('/admin/notification-preferences').then(r => r.data),
  updateNotificationPreferences: (prefs: Record<string, Record<string, boolean>>) => apiClient.put('/admin/notification-preferences', prefs).then(r => r.data),
  // [460-fork] Smart Import (Milestone 2)
  getImportSettings: () => apiClient.get('/admin/import-settings').then(r => r.data),
  updateImportSettings: (data: Record<string, unknown>) => apiClient.put('/admin/import-settings', data).then(r => r.data),
}

export const addonsApi = {
  enabled: () => apiClient.get('/addons').then(r => r.data),
}

export const mapsApi = {
  search: (query: string, lang?: string) => apiClient.post(`/maps/search?lang=${lang || 'en'}`, { query }).then(r => r.data),
  details: (placeId: string, lang?: string) => apiClient.get(`/maps/details/${encodeURIComponent(placeId)}`, { params: { lang } }).then(r => r.data),
  placePhoto: (placeId: string, lat?: number, lng?: number, name?: string) => apiClient.get(`/maps/place-photo/${encodeURIComponent(placeId)}`, { params: { lat, lng, name } }).then(r => r.data),
  reverse: (lat: number, lng: number, lang?: string) => apiClient.get('/maps/reverse', { params: { lat, lng, lang } }).then(r => r.data),
  resolveUrl: (url: string) => apiClient.post('/maps/resolve-url', { url }).then(r => r.data),
}

export const budgetApi = {
  list: (tripId: number | string) => apiClient.get(`/trips/${tripId}/budget`).then(r => r.data),
  create: (tripId: number | string, data: Record<string, unknown>) => apiClient.post(`/trips/${tripId}/budget`, data).then(r => r.data),
  update: (tripId: number | string, id: number, data: Record<string, unknown>) => apiClient.put(`/trips/${tripId}/budget/${id}`, data).then(r => r.data),
  delete: (tripId: number | string, id: number) => apiClient.delete(`/trips/${tripId}/budget/${id}`).then(r => r.data),
  setMembers: (tripId: number | string, id: number, userIds: number[]) => apiClient.put(`/trips/${tripId}/budget/${id}/members`, { user_ids: userIds }).then(r => r.data),
  togglePaid: (tripId: number | string, id: number, userId: number, paid: boolean) => apiClient.put(`/trips/${tripId}/budget/${id}/members/${userId}/paid`, { paid }).then(r => r.data),
  perPersonSummary: (tripId: number | string) => apiClient.get(`/trips/${tripId}/budget/summary/per-person`).then(r => r.data),
  settlement: (tripId: number | string) => apiClient.get(`/trips/${tripId}/budget/settlement`).then(r => r.data),
}

export const filesApi = {
  list: (tripId: number | string, trash?: boolean) => apiClient.get(`/trips/${tripId}/files`, { params: trash ? { trash: 'true' } : {} }).then(r => r.data),
  upload: (tripId: number | string, formData: FormData) => apiClient.post(`/trips/${tripId}/files`, formData, {
    headers: { 'Content-Type': 'multipart/form-data' }
  }).then(r => r.data),
  update: (tripId: number | string, id: number, data: Record<string, unknown>) => apiClient.put(`/trips/${tripId}/files/${id}`, data).then(r => r.data),
  delete: (tripId: number | string, id: number) => apiClient.delete(`/trips/${tripId}/files/${id}`).then(r => r.data),
  toggleStar: (tripId: number | string, id: number) => apiClient.patch(`/trips/${tripId}/files/${id}/star`).then(r => r.data),
  restore: (tripId: number | string, id: number) => apiClient.post(`/trips/${tripId}/files/${id}/restore`).then(r => r.data),
  permanentDelete: (tripId: number | string, id: number) => apiClient.delete(`/trips/${tripId}/files/${id}/permanent`).then(r => r.data),
  emptyTrash: (tripId: number | string) => apiClient.delete(`/trips/${tripId}/files/trash/empty`).then(r => r.data),
  addLink: (tripId: number | string, fileId: number, data: { reservation_id?: number; assignment_id?: number }) => apiClient.post(`/trips/${tripId}/files/${fileId}/link`, data).then(r => r.data),
  removeLink: (tripId: number | string, fileId: number, linkId: number) => apiClient.delete(`/trips/${tripId}/files/${fileId}/link/${linkId}`).then(r => r.data),
  getLinks: (tripId: number | string, fileId: number) => apiClient.get(`/trips/${tripId}/files/${fileId}/links`).then(r => r.data),
}

export const reservationsApi = {
  list: (tripId: number | string) => apiClient.get(`/trips/${tripId}/reservations`).then(r => r.data),
  create: (tripId: number | string, data: Record<string, unknown>) => apiClient.post(`/trips/${tripId}/reservations`, data).then(r => r.data),
  update: (tripId: number | string, id: number, data: Record<string, unknown>) => apiClient.put(`/trips/${tripId}/reservations/${id}`, data).then(r => r.data),
  delete: (tripId: number | string, id: number) => apiClient.delete(`/trips/${tripId}/reservations/${id}`).then(r => r.data),
  updatePositions: (tripId: number | string, positions: { id: number; day_plan_position: number }[], dayId?: number) => apiClient.put(`/trips/${tripId}/reservations/positions`, { positions, day_id: dayId }).then(r => r.data),
}

// [460-fork] Smart Import (Milestone 2 slice 3)
export const reservationImportsApi = {
  extract: (
    tripId: number | string,
    opts: { file?: File; emailText?: string; autoAttach?: boolean; clientMutationId?: string },
  ) => {
    const form = new FormData()
    if (opts.file) form.append('file', opts.file)
    if (opts.emailText !== undefined) form.append('email_text', opts.emailText)
    if (opts.autoAttach !== undefined) form.append('auto_attach', String(opts.autoAttach))
    const headers: Record<string, string> = { 'Content-Type': 'multipart/form-data' }
    if (opts.clientMutationId) headers['X-Client-Mutation-Id'] = opts.clientMutationId
    return apiClient.post(`/trips/${tripId}/reservation-imports/extract`, form, { headers }).then(r => r.data)
  },
}

// [460-fork] Milestone 9 — pre-trip availability polls.
export interface PollOption {
  id: number
  poll_id: number
  start_date: string
  end_date: string
  sort_order: number
}
export interface PollVote {
  id: number
  poll_id: number
  option_id: number
  voter_name: string
  voter_email: string | null
  voter_browser_id: string
  choice: 'yes' | 'no' | 'maybe'
  comment: string | null
  updated_at: string
}
export interface Poll {
  id: number
  owner_user_id?: number
  title: string
  description: string | null
  share_token: string
  created_at: string
  expires_at: string | null
  finalised_trip_id?: number | null
  options: PollOption[]
  votes?: PollVote[]
}
export const pollsApi = {
  list: () => apiClient.get('/polls').then(r => r.data as { polls: Poll[] }),
  create: (data: { title: string; description?: string | null; options: { start_date: string; end_date: string }[]; expires_at?: string | null }) =>
    apiClient.post('/polls', data).then(r => r.data as { poll: Poll }),
  get: (id: number) => apiClient.get(`/polls/${id}`).then(r => r.data as { poll: Poll }),
  delete: (id: number) => apiClient.delete(`/polls/${id}`).then(r => r.data),
  // Public — no auth headers needed but axios's defaults are harmless on a public endpoint.
  getPublic: (token: string) => apiClient.get(`/polls/share/${token}`).then(r => r.data as { poll: Poll }),
  submitVotes: (token: string, payload: { voter_name: string; voter_email?: string | null; voter_browser_id: string; choices: { option_id: number; choice: 'yes' | 'no' | 'maybe'; comment?: string | null }[] }) =>
    apiClient.post(`/polls/share/${token}/votes`, payload).then(r => r.data as { votes: PollVote[] }),
  // [460-fork] Milestone 9 slice 3 — convert a poll's winning option into a trip.
  convertToTrip: (id: number, payload: { option_id: number; title?: string }) =>
    apiClient.post(`/polls/${id}/convert`, payload).then(r => r.data as {
      trip_id: number
      invited_user_ids: number[]
      manual_invite_hints: { name: string; email: string | null; choice: 'yes' | 'maybe' }[]
    }),
  // [460-fork] Milestone 9 slice 4 — Vacay-addon pre-fill (auth required).
  vacayPrefill: (token: string) =>
    apiClient.get(`/polls/share/${token}/vacay-prefill`).then(r => r.data as {
      prefill: { option_id: number; suggested: 'yes' | 'no' | 'maybe'; total_days: number; vacay_days: number }[]
    }),
}

export const weatherApi = {
  get: (lat: number, lng: number, date: string) => apiClient.get('/weather', { params: { lat, lng, date } }).then(r => r.data),
  getDetailed: (lat: number, lng: number, date: string, lang?: string) => apiClient.get('/weather/detailed', { params: { lat, lng, date, lang } }).then(r => r.data),
}

export const settingsApi = {
  get: () => apiClient.get('/settings').then(r => r.data),
  set: (key: string, value: unknown) => apiClient.put('/settings', { key, value }).then(r => r.data),
  setBulk: (settings: Record<string, unknown>) => apiClient.post('/settings/bulk', { settings }).then(r => r.data),
}

export const accommodationsApi = {
  list: (tripId: number | string) => apiClient.get(`/trips/${tripId}/accommodations`).then(r => r.data),
  create: (tripId: number | string, data: Record<string, unknown>) => apiClient.post(`/trips/${tripId}/accommodations`, data).then(r => r.data),
  update: (tripId: number | string, id: number, data: Record<string, unknown>) => apiClient.put(`/trips/${tripId}/accommodations/${id}`, data).then(r => r.data),
  delete: (tripId: number | string, id: number) => apiClient.delete(`/trips/${tripId}/accommodations/${id}`).then(r => r.data),
}

// [460-fork] Milestone 6 slice 2 — per-day photo associations.
export const dayPhotosApi = {
  list: (tripId: number | string, dayId: number | string) =>
    apiClient.get(`/trips/${tripId}/days/${dayId}/photos`).then(r => r.data),
  upload: (
    tripId: number | string,
    dayId: number | string,
    blob: Blob,
    opts?: {
      caption?: string
      takenAt?: string | null
      lat?: number | null
      lng?: number | null
      altitude?: number | null
      camera?: string | null
      filename?: string
    },
  ) => {
    const fd = new FormData()
    fd.append('file', blob, opts?.filename ?? 'photo.jpg')
    if (opts?.caption !== undefined) fd.append('caption', opts.caption)
    if (opts?.takenAt) fd.append('taken_at', opts.takenAt)
    if (opts?.lat !== undefined && opts.lat !== null) fd.append('lat', String(opts.lat))
    if (opts?.lng !== undefined && opts.lng !== null) fd.append('lng', String(opts.lng))
    if (opts?.altitude !== undefined && opts.altitude !== null) fd.append('altitude', String(opts.altitude))
    if (opts?.camera) fd.append('camera', opts.camera)
    return apiClient.post(`/trips/${tripId}/days/${dayId}/photos`, fd, {
      headers: { 'Content-Type': 'multipart/form-data' },
    }).then(r => r.data)
  },
  update: (tripId: number | string, dayId: number | string, id: number, data: { caption?: string | null; position?: number; taken_at?: string | null }) =>
    apiClient.put(`/trips/${tripId}/days/${dayId}/photos/${id}`, data).then(r => r.data),
  delete: (tripId: number | string, dayId: number | string, id: number) =>
    apiClient.delete(`/trips/${tripId}/days/${dayId}/photos/${id}`).then(r => r.data),
  reorder: (tripId: number | string, dayId: number | string, orderedIds: number[]) =>
    apiClient.put(`/trips/${tripId}/days/${dayId}/photos/reorder`, { orderedIds }).then(r => r.data),
}

// [460-fork] M6 follow-up — uploaded GPS tracks (.gpx) attached to a trip.
// One track is one polyline; multiple tracks can render simultaneously
// alongside the auto-derived photo route.
export const gpxTracksApi = {
  list: (tripId: number | string) =>
    apiClient.get(`/trips/${tripId}/gpx-tracks`).then(r => r.data),
  upload: (tripId: number | string, file: File, name?: string) => {
    const fd = new FormData()
    fd.append('file', file, file.name)
    if (name) fd.append('name', name)
    return apiClient.post(`/trips/${tripId}/gpx-tracks`, fd, {
      headers: { 'Content-Type': 'multipart/form-data' },
    }).then(r => r.data)
  },
  rename: (tripId: number | string, id: number, name: string) =>
    apiClient.patch(`/trips/${tripId}/gpx-tracks/${id}`, { name }).then(r => r.data),
  remove: (tripId: number | string, id: number) =>
    apiClient.delete(`/trips/${tripId}/gpx-tracks/${id}`).then(r => r.data),
}

// [460-fork] M6 follow-up — per-segment photo-route waypoint overrides.
// All mutations get auto-queued for offline replay via the response
// interceptor at the top of this file.
export const photoRouteOverridesApi = {
  list: (tripId: number | string) =>
    apiClient.get(`/trips/${tripId}/photo-route-overrides`).then(r => r.data),
  upsert: (tripId: number | string, fromPhotoId: number, toPhotoId: number, waypoints: [number, number][]) =>
    apiClient.put(`/trips/${tripId}/photo-route-overrides/${fromPhotoId}/${toPhotoId}`, { waypoints }).then(r => r.data),
  remove: (tripId: number | string, fromPhotoId: number, toPhotoId: number) =>
    apiClient.delete(`/trips/${tripId}/photo-route-overrides/${fromPhotoId}/${toPhotoId}`).then(r => r.data),
}

// [460-fork] Milestone 6 slice 1 — per-day journal text.
export const journalApi = {
  get: (tripId: number | string, dayId: number | string) =>
    apiClient.get(`/trips/${tripId}/days/${dayId}/journal`).then(r => r.data),
  update: (
    tripId: number | string,
    dayId: number | string,
    contentMarkdown: string,
    observedUpdatedAt?: string | null,
  ) => {
    const headers: Record<string, string> = {}
    if (observedUpdatedAt) headers['If-Unmodified-Since'] = observedUpdatedAt
    return apiClient.put(
      `/trips/${tripId}/days/${dayId}/journal`,
      { content_markdown: contentMarkdown },
      { headers },
    ).then(r => r.data)
  },
}

export const dayNotesApi = {
  list: (tripId: number | string, dayId: number | string) => apiClient.get(`/trips/${tripId}/days/${dayId}/notes`).then(r => r.data),
  create: (tripId: number | string, dayId: number | string, data: Record<string, unknown>) => apiClient.post(`/trips/${tripId}/days/${dayId}/notes`, data).then(r => r.data),
  update: (tripId: number | string, dayId: number | string, id: number, data: Record<string, unknown>) => apiClient.put(`/trips/${tripId}/days/${dayId}/notes/${id}`, data).then(r => r.data),
  delete: (tripId: number | string, dayId: number | string, id: number) => apiClient.delete(`/trips/${tripId}/days/${dayId}/notes/${id}`).then(r => r.data),
}

export const collabApi = {
  getNotes: (tripId: number | string) => apiClient.get(`/trips/${tripId}/collab/notes`).then(r => r.data),
  createNote: (tripId: number | string, data: Record<string, unknown>) => apiClient.post(`/trips/${tripId}/collab/notes`, data).then(r => r.data),
  updateNote: (tripId: number | string, id: number, data: Record<string, unknown>) => apiClient.put(`/trips/${tripId}/collab/notes/${id}`, data).then(r => r.data),
  deleteNote: (tripId: number | string, id: number) => apiClient.delete(`/trips/${tripId}/collab/notes/${id}`).then(r => r.data),
  uploadNoteFile: (tripId: number | string, noteId: number, formData: FormData) => apiClient.post(`/trips/${tripId}/collab/notes/${noteId}/files`, formData, { headers: { 'Content-Type': 'multipart/form-data' } }).then(r => r.data),
  deleteNoteFile: (tripId: number | string, noteId: number, fileId: number) => apiClient.delete(`/trips/${tripId}/collab/notes/${noteId}/files/${fileId}`).then(r => r.data),
  getPolls: (tripId: number | string) => apiClient.get(`/trips/${tripId}/collab/polls`).then(r => r.data),
  createPoll: (tripId: number | string, data: Record<string, unknown>) => apiClient.post(`/trips/${tripId}/collab/polls`, data).then(r => r.data),
  votePoll: (tripId: number | string, id: number, optionIndex: number) => apiClient.post(`/trips/${tripId}/collab/polls/${id}/vote`, { option_index: optionIndex }).then(r => r.data),
  closePoll: (tripId: number | string, id: number) => apiClient.put(`/trips/${tripId}/collab/polls/${id}/close`).then(r => r.data),
  deletePoll: (tripId: number | string, id: number) => apiClient.delete(`/trips/${tripId}/collab/polls/${id}`).then(r => r.data),
  getMessages: (tripId: number | string, before?: string) => apiClient.get(`/trips/${tripId}/collab/messages${before ? `?before=${before}` : ''}`).then(r => r.data),
  sendMessage: (tripId: number | string, data: Record<string, unknown>) => apiClient.post(`/trips/${tripId}/collab/messages`, data).then(r => r.data),
  deleteMessage: (tripId: number | string, id: number) => apiClient.delete(`/trips/${tripId}/collab/messages/${id}`).then(r => r.data),
  reactMessage: (tripId: number | string, id: number, emoji: string) => apiClient.post(`/trips/${tripId}/collab/messages/${id}/react`, { emoji }).then(r => r.data),
  linkPreview: (tripId: number | string, url: string) => apiClient.get(`/trips/${tripId}/collab/link-preview?url=${encodeURIComponent(url)}`).then(r => r.data),
}

export const backupApi = {
  list: () => apiClient.get('/backup/list').then(r => r.data),
  create: () => apiClient.post('/backup/create').then(r => r.data),
  download: async (filename: string): Promise<void> => {
    const res = await fetch(`/api/backup/download/${filename}`, {
      credentials: 'include',
    })
    if (!res.ok) throw new Error('Download failed')
    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.click()
    URL.revokeObjectURL(url)
  },
  delete: (filename: string) => apiClient.delete(`/backup/${filename}`).then(r => r.data),
  restore: (filename: string) => apiClient.post(`/backup/restore/${filename}`).then(r => r.data),
  uploadRestore: (file: File) => {
    const form = new FormData()
    form.append('backup', file)
    return apiClient.post('/backup/upload-restore', form, { headers: { 'Content-Type': 'multipart/form-data' } }).then(r => r.data)
  },
  getAutoSettings: () => apiClient.get('/backup/auto-settings').then(r => r.data),
  setAutoSettings: (settings: Record<string, unknown>) => apiClient.put('/backup/auto-settings', settings).then(r => r.data),
}

export const shareApi = {
  getLink: (tripId: number | string) => apiClient.get(`/trips/${tripId}/share-link`).then(r => r.data),
  createLink: (tripId: number | string, perms?: Record<string, boolean>) => apiClient.post(`/trips/${tripId}/share-link`, perms || {}).then(r => r.data),
  deleteLink: (tripId: number | string) => apiClient.delete(`/trips/${tripId}/share-link`).then(r => r.data),
  getSharedTrip: (token: string) => apiClient.get(`/shared/${token}`).then(r => r.data),
}

export const notificationsApi = {
  getPreferences: () => apiClient.get('/notifications/preferences').then(r => r.data),
  updatePreferences: (prefs: Record<string, Record<string, boolean>>) => apiClient.put('/notifications/preferences', prefs).then(r => r.data),
  testSmtp: (email?: string) => apiClient.post('/notifications/test-smtp', { email }).then(r => r.data),
  testWebhook: (url?: string) => apiClient.post('/notifications/test-webhook', { url }).then(r => r.data),
}

export const inAppNotificationsApi = {
  list: (params?: { limit?: number; offset?: number; unread_only?: boolean }) =>
    apiClient.get('/notifications/in-app', { params }).then(r => r.data),
  unreadCount: () =>
    apiClient.get('/notifications/in-app/unread-count').then(r => r.data),
  markRead: (id: number) =>
    apiClient.put(`/notifications/in-app/${id}/read`).then(r => r.data),
  markUnread: (id: number) =>
    apiClient.put(`/notifications/in-app/${id}/unread`).then(r => r.data),
  markAllRead: () =>
    apiClient.put('/notifications/in-app/read-all').then(r => r.data),
  delete: (id: number) =>
    apiClient.delete(`/notifications/in-app/${id}`).then(r => r.data),
  deleteAll: () =>
    apiClient.delete('/notifications/in-app/all').then(r => r.data),
  respond: (id: number, response: 'positive' | 'negative') =>
    apiClient.post(`/notifications/in-app/${id}/respond`, { response }).then(r => r.data),
}

export default apiClient
