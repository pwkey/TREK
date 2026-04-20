// [460-fork] Shared segments (Milestone 4) — typed axios wrappers.
import apiClient from './client'

export interface SegmentRow {
  id: string
  title: string
  start_date: string | null
  end_date: string | null
  created_at: string
  updated_at: string
  created_by: number
  updated_by: number | null
}

export interface SegmentView {
  segment: SegmentRow
  linked_trip_ids: number[]
  home_trip_id: number
  day_ids: number[]
}

export interface CreateInviteResult {
  id: string
  token: string
  expires_at: string
}

export interface LeaveResult {
  segment_id: string
  cloned_day_ids: number[]
}

export interface InvitePreview {
  segment: { id: string; title: string; start_date: string | null; end_date: string | null }
  expires_at: string
  accepted: boolean
}

export interface SegmentSummaryForTrip extends SegmentRow {
  is_home: boolean
  linked_trip_count: number
}

export const segmentsApi = {
  listForTrip: (tripId: number) =>
    apiClient.get(`/trips/${tripId}/segments`).then(r => r.data as { segments: SegmentSummaryForTrip[] }),

  create: (data: { trip_id: number; day_ids: number[]; title: string }) =>
    apiClient.post('/segments', data).then(r => r.data as SegmentView),

  get: (id: string) =>
    apiClient.get(`/segments/${id}`).then(r => r.data as SegmentView),

  createInvite: (segmentId: string) =>
    apiClient.post(`/segments/${segmentId}/invites`).then(r => r.data as CreateInviteResult),

  getInvitePreview: (token: string) =>
    apiClient.get(`/segments/invite/${token}`).then(r => r.data as InvitePreview),

  accept: (data: { token: string; target_trip_id: number }) =>
    apiClient.post('/segments/accept', data).then(r => r.data as SegmentView),

  leave: (segmentId: string, tripId: number) =>
    apiClient.delete(`/segments/${segmentId}/trips/${tripId}`).then(r => r.data as LeaveResult),
}
