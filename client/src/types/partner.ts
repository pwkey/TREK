export interface PartnerSnapshot {
  id: number
  username: string
  email: string
  avatar_url: string | null
}

export interface PartnerInviteView {
  id: string
  inviter: PartnerSnapshot
  target: PartnerSnapshot
  message: string | null
  expires_at: string
  created_at: string
}

export interface PartnerGetResponse {
  partner: PartnerSnapshot | null
  incoming: PartnerInviteView[]
  outgoing: PartnerInviteView[]
  backfill_done: boolean
}

export interface BackfillTripsResponse {
  added: number
  skipped: number
  trip_ids: number[]
}
