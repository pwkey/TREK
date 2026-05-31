// [460-fork] Milestone 11 — Household types (replaces /types/partner.ts).
//
// A household groups N user accounts (each with their own login) and M
// named non-account members ("kids etc"). Single household per user;
// `users.household_id` is the nullable FK on the server side.

export interface UserSnapshot {
  id: number
  username: string
  email: string
  avatar_url: string | null
}

export interface HouseholdMember {
  id: number
  household_id: number
  name: string
  dob: string | null
  relationship: string | null
  created_at: string
  created_by: number
  updated_at: string
  updated_by: number | null
}

export interface HouseholdSnapshot {
  id: number
  name: string | null
  created_at: string
  created_by: number
  users: UserSnapshot[]
  members: HouseholdMember[]
}

export interface HouseholdInviteView {
  id: string
  household_id: number
  household_name: string | null
  invitee_email: string
  invited_by: UserSnapshot | null
  token: string
  status: 'pending' | 'accepted' | 'declined' | 'expired' | 'cancelled'
  message: string | null
  expires_at: string
  created_at: string
}

export interface HouseholdGetResponse {
  household: HouseholdSnapshot | null
  incoming: HouseholdInviteView[]
  outgoing: HouseholdInviteView[]
}
