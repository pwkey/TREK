// [460-fork] Milestone 5 slice 4 — pending-conflict review.
import apiClient from './client'

export interface ConflictView {
  id: string
  client_mutation_id: string
  endpoint: string
  method: string
  record_type: string
  record_id: number
  mine: Record<string, unknown> | null
  theirs: Record<string, unknown> | null
  observed_at: string
  server_at: string
  created_at: string
}

export type ResolveChoice = 'mine' | 'theirs' | 'combine'

export const conflictsApi = {
  list: () => apiClient.get('/conflicts').then(r => r.data as { conflicts: ConflictView[]; count: number }),
  resolve: (id: string, choice: ResolveChoice, merged?: Record<string, unknown>) =>
    apiClient.post(`/conflicts/${id}/resolve`, choice === 'combine' ? { choice, merged } : { choice }).then(r => r.data),
}
