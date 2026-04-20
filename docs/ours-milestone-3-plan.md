# Milestone 3 Implementation Plan — Partner Pairing

**Status:** draft, pending approval
**Date:** 2026-04-20
**Feature spec:** `CLAUDE.md` §6 Milestone 3
**Architecture context:** `docs/ours-architecture-map.md`
**Precedent:** `docs/ours-milestone-2-plan.md` (structure template + merge-pain approach)

Update this doc as the implementation proceeds (mark slices as done, strike out discarded options, move answered open questions to a decision log). Milestone 3 starts on `personal` branch after Milestone 2 slices 1-4 land and have seen at least one real booking imported (both now satisfied).

---

## Orientation notes (material findings that shaped the plan)

- **`users.id` is `INTEGER PRIMARY KEY AUTOINCREMENT`** (`schema.ts:5-30`). The partner relationship is a **self-referencing column** on `users`, not a new table. The CLAUDE.md §9 UUID mandate applies only to *new* tables — Milestone 2 already documented this exemption. A small **new** `partner_invites` table *does* get a UUID PK plus `created_at/updated_at/created_by/updated_by` per §9.
- **Membership is a single table**: `trip_members(trip_id, user_id, invited_by, added_at)` with `UNIQUE(trip_id, user_id)` (`schema.ts:182-189`). No role column today — "owner vs member" is computed at read time (`tripService.ts:296`). Auto-adding a partner means an additional `trip_members` row written at trip-create time, with `invited_by = trip owner id`. Fully additive.
- **Trip creation entry point** is `createTrip(userId, data, maxDays?)` in `server/src/services/tripService.ts:146-161`, called from `POST /api/trips`. Auto-add-partner hooks in at the service layer.
- **Invite/accept precedent** is the vacay flow (`vacayService.ts:318-350`) — uses `broadcastToUser` + `notificationService.send`. The in-app boolean notification with positive/negative callbacks via `inAppNotificationActions.ts` is exactly the shape we want. Pair-invite accept/decline hook into this with two new registered actions (`partner_invite_accept`, `partner_invite_decline`) — no new accept/decline endpoints required.
- **`client_mutation_id` passthrough** is already wired for Milestone 2. Extend to all new Milestone 3 mutations. No-op for offline queue until Milestone 5.
- **Auth is sensitive.** CLAUDE.md §2.5. Nothing in this plan touches `middleware/auth.ts` or `middleware/mfaPolicy.ts`. We extend `authService.ts` (service, not middleware) with partner logic in a dedicated `partnerService.ts`.
- **Last migration** is Migration 113 `reservation_imports`. Milestone 3 appends **two** more thunks — migration 114 (`users.partner_user_id` ALTER) and 115 (`partner_invites` CREATE) — at the tail.
- **Smart-import extractor returns `passenger_names: string[]`** already. Fuzzy-match is a pure compute step; no schema change on reservations. Returns a parallel `matched_user_ids: (number | null)[]` in the extract response.

---

## 1. Commit slicing (5 commits)

| # | Commit title | What works after it lands | What still doesn't |
|---|---|---|---|
| 1 | `feat(account): partner_user_id column + partner_invites table + backend pairing service (no routes)` | Migrations run cleanly. `partnerService.ts` exposes `getPartner/sendInvite/acceptInvite/declineInvite/unpair` with symmetry enforced in a transaction. Covered by unit tests. | No HTTP routes, no UI. |
| 2 | `feat(account): partner pair/unpair REST endpoints + notification wiring` | User can hit `/api/auth/me/partner` endpoints end-to-end: send invite → other user receives an in-app boolean notification → accept/decline via the existing respond endpoint. `GET /api/auth/me` returns a `partner` field. Integration tests cover happy path + symmetry + race conditions + expiry. | No UI yet. No auto-add to trips. |
| 3 | `feat(account): partner-pairing UI in Settings → Account` | Settings flow works on web: search partner by email/username → invite → recipient sees request in notification bell → accept → both Account tabs show pair status. Unpair works. | Trip auto-add still absent. Backfill still absent. |
| 4 | `feat(trips): on trip create, auto-add partner as trip member; opt-in one-time backfill` | Creating a trip while paired auto-inserts a `trip_members` row for the partner, with a broadcast + notification. `POST /api/auth/me/partner/backfill-trips` applies the partner to all currently-owned trips. "Apply to existing trips" button in Account tab. | Smart-import tagging not yet wired. |
| 5 | `feat(reservations): smart-import extractor fuzzy-matches passenger names against user + partner` | Extract response gains `matched_user_ids`. Reservation review form renders a "You / Partner / Both / Unknown" pill per passenger. Audit row records matches. | — |

Slices 1-3 are the pairing MVP. Slice 4 delivers the friction fix from the spec. Slice 5 is the smart-import enhancement.

---

## 2. Per-slice details

### Slice 1 — Schema + service, no routes

**Files added:**
- `server/src/services/partnerService.ts` — the fat service:
  - `getPartner(userId): { partner_user_id, username, email, avatar_url } | null`
  - `sendInvite(inviterId, inviterEmail, targetIdentifier): { invite_id } | { error, status }` (finds user by email or username; rejects self; rejects if either side already paired or has a pending invite; writes `partner_invites` row; dispatches notification; returns UUID)
  - `acceptInvite(inviteId, respondingUserId): { partner } | { error, status }` (validates expiry, writes symmetric partner link atomically, marks invite `accepted`, notifies inviter)
  - `declineInvite(inviteId, respondingUserId): { ok: true } | { error }`
  - `unpair(userId): { ok: true }` (clears `partner_user_id` on both rows; **no `trip_members` mutation** — history stays)
  - `listOutgoingInvites(userId)`, `listIncomingInvites(userId)`
  - `expirePartnerInvites()` — idempotent sweep, called from scheduler (future); for now expiry is lazy-checked on accept
- `server/tests/unit/partnerService.test.ts` — symmetry invariant, self-invite rejection, re-invite-while-pending, expired invite, unpair idempotency, concurrent accept race.

**Files modified:**
- `server/src/db/schema.ts` — add `partner_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL` to `users` and add full `CREATE TABLE partner_invites` block (fresh-install parity).
- `server/src/db/migrations.ts` ⚠️ — append two migration thunks at the tail.

**Migrations 114 and 115** (append to `migrations` array after the current `reservation_imports` thunk at lines 867-896):

```ts
// [460-fork] Partner pairing (Milestone 3): symmetric spouse/partner link on users.
// Migration 114 — nullable self-reference; symmetry enforced in app logic + transaction.
() => {
  try {
    db.exec('ALTER TABLE users ADD COLUMN partner_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL');
  } catch (err: any) {
    if (!err.message?.includes('duplicate column name')) throw err;
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_users_partner ON users(partner_user_id);');
},

// [460-fork] Partner pairing (Milestone 3): time-limited invite tokens.
// Migration 115 — new table; UUID PK per CLAUDE.md §9. Keep at TAIL on rebase.
() => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS partner_invites (
      id TEXT PRIMARY KEY,                            -- UUID
      inviter_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      target_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'pending',         -- 'pending' | 'accepted' | 'declined' | 'expired' | 'cancelled'
      message TEXT,
      expires_at DATETIME NOT NULL,
      responded_at DATETIME,
      client_mutation_id TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_partner_invites_target ON partner_invites(target_user_id, status);
    CREATE INDEX IF NOT EXISTS idx_partner_invites_inviter ON partner_invites(inviter_user_id, status);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_partner_invites_cmid
      ON partner_invites(client_mutation_id) WHERE client_mutation_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_partner_invites_pending_pair
      ON partner_invites(inviter_user_id, target_user_id) WHERE status = 'pending';
  `);
},
```

**Tests:** symmetry after accept, self-invite rejection, double-invite-while-pending blocked, expired invite returns specific error code, unpair is idempotent and leaves `trip_members` alone, concurrent-accept race handled via transactional UPDATE with `.changes` check.

**Dependencies:** none.

**Upstream:** Upstream-ready.

---

### Slice 2 — REST endpoints + notification wiring

**Files added:** `server/tests/integration/partner.test.ts`.

**Files modified:**
- `server/src/routes/auth.ts` ⚠️ — five new routes in a contiguous marked block at the bottom.
- `server/src/services/authService.ts` ⚠️ — `getCurrentUser` returns additional `partner: { ... } | null` via `partnerService.getPartner(userId)`. Minimal diff.
- `server/src/services/notificationPreferencesService.ts` ⚠️ — add `partner_invite` to `NotifEventType` and `IMPLEMENTED_COMBOS`.
- `server/src/services/notificationService.ts` ⚠️ — add `partner_invite` to `EVENT_NOTIFICATION_CONFIG`.
- `server/src/services/inAppNotificationActions.ts` — register `partner_invite_accept` and `partner_invite_decline` action handlers delegating to `partnerService`.
- `server/src/services/notifications.ts` ⚠️ — i18n lookup entries.
- `server/locales/en.json` (+ de if trivially translatable) — strings for email/webhook copy.

**API endpoints (all under `/api/auth`):**

```ts
GET    /api/auth/me/partner
// {
//   partner: { id, username, email, avatar_url } | null;
//   incoming: Array<{ id, inviter: {...}, expires_at, message }>;
//   outgoing: Array<{ id, target: {...}, expires_at, message }>;
// }

POST   /api/auth/me/partner/invites
// Body: { identifier: string; message?: string }
// Header (optional): X-Client-Mutation-Id
// 201 { invite }
// 400 invalid identifier / self-invite
// 404 target not found
// 409 ALREADY_PAIRED | PENDING_INVITE_EXISTS

DELETE /api/auth/me/partner/invites/:inviteId
// Cancel outgoing invite. Idempotent.
// 200 { ok: true }

DELETE /api/auth/me/partner
// Unpair. Idempotent.
// 200 { ok: true }
```

**Accept/decline** goes through the existing `POST /api/notifications/in-app/:id/respond` endpoint via the registered callback actions — no new accept endpoint.

**WebSocket:** `broadcastToUser(targetUserId, { type: 'partner:invite', from: {id,username}, inviteId })` on send, `broadcastToUser(inviterId, { type: 'partner:response', inviteId, status })` on accept/decline. Mirrors vacay pattern.

**Authorization:** `authenticate` on all routes. No `requireTripAccess` (partner is global). No new `PERMISSION_ACTIONS` entry.

**Tests:** 401 unauth; happy-path invite→accept with symmetric result; 409 already-paired; 409 pending-invite-exists; 404 unknown identifier; 410 GONE on expired invite; unpair leaves pre-existing `trip_members` rows intact.

**Dependencies:** none.

**Upstream:** Upstream-ready.

---

### Slice 3 — Settings UI

**Files added:**
- `client/src/components/Settings/PartnerSection.tsx` — states: not-paired, pending-outgoing, pending-incoming, paired. Search by email/username, optional message up to 200 chars, unpair with confirmation modal matching the delete-account style.
- `client/src/types/partner.ts` — TS types mirroring server response.
- `client/src/store/slices/partnerSlice.ts` — Zustand slice: `{ partner, incomingInvites, outgoingInvites, isLoading }` with `refreshPartner`, `sendInvite`, `cancelInvite`, `respondToInvite`, `unpair`. Kept separate from `authStore` (upstream-active file) — mounted via `useEffect` in `PartnerSection`.

**Files modified:**
- `client/src/api/client.ts` ⚠️ — `authApi.partner` namespace.
- `client/src/components/Settings/AccountTab.tsx` — render `<PartnerSection />` (~3-line JSX addition + one import).
- `client/src/i18n/translations/en.ts` (+ de) — `settings.partner.*`, `notif.partner_invite.*` keys.

**Tests:** frontend tests optional per CLAUDE.md §2.4. Two-session browser walkthrough is the acceptance bar.

**Dependencies:** none.

**Upstream:** Upstream-ready.

---

### Slice 4 — Auto-add to trips + opt-in backfill

**Files modified:**
- `server/src/services/tripService.ts` ⚠️ — in `createTrip`, after the trip INSERT and `generateDays`, read `users.partner_user_id`; if non-null, `INSERT INTO trip_members ... ON CONFLICT DO NOTHING`, plus `broadcastToUser(partnerId, ...)` and `notificationService.send({ event: 'trip_invite', ... })` — reusing the existing `trip_invite` event type (semantically: partner was invited, just automatically). ~10-line block marked `[460-fork] partner auto-add — BEGIN/END`.
- `server/src/services/partnerService.ts` — add `backfillTrips(userId): { added, skipped, trip_ids }`. Iterates owned trips, conflict-safe inserts. Aggregate-or-per-trip notification volume per the open question.
- `server/src/routes/auth.ts` ⚠️ — `POST /api/auth/me/partner/backfill-trips`.
- `client/src/api/client.ts` ⚠️ — `authApi.partner.backfillTrips()`.
- `client/src/components/Settings/PartnerSection.tsx` — "Apply partnering to my existing trips" one-time button, tracked via a `settings` per-user key `partner_backfill_done`.

**API endpoint:**

```ts
POST   /api/auth/me/partner/backfill-trips
// Body: {}  (MVP all-or-nothing)
// Header: X-Client-Mutation-Id
// 200 { added, skipped, trip_ids }
// 409 NOT_PAIRED
```

**Partner permission level (decision):** **Plain `trip_members` row, no new role column.** Rationale: fully additive, zero upstream pain, keeps the permission matrix untouched. Trip permissions default to `trip_owner` for `trip_edit/archive/cover_upload` — instance admin can flip these to `trip_member` globally in one setting if households want partners editing trip metadata. A `partner` role would cascade through listMembers, checkPermission, UI, and every permission check for marginal benefit.

**Tests:** pair → create trip → trip_members includes partner with `invited_by = creator`; unpaired creator → no auto-add; unpair after creation → trip_members row persists (no prune); backfill adds all owned trips; idempotent; partner-already-member skipped; `/trips/:id/copy` path does NOT auto-add (regression test).

**Dependencies:** none.

**Upstream:** Upstream-ready.

---

### Slice 5 — Smart-import passenger fuzzy-match

**Files added:**
- `server/src/services/reservationImport/passengerMatcher.ts` — pure function `matchPassengers(names, candidates): (number | null)[]`. Case-insensitive, diacritic-normalised, Levenshtein-threshold for close matches. ~30 lines, no library.
- `server/tests/unit/passengerMatcher.test.ts` — exact, case, diacritics, first-last-name split, double-match, no-match.

**Files modified:**
- `server/src/services/reservationImport/extractor.ts` — after LLM returns draft, call `matchPassengers(draft.passenger_names, [user, partner].filter(Boolean))` and attach `matched_user_ids` to the extract result. Record on the audit `parsed_json` (already stringifies the full payload; no schema change).
- `server/src/routes/reservationImport.ts` — response shape adds `matched_user_ids`.
- `client/src/types/reservationImport.ts` — add the new field.
- `client/src/components/Planner/ReservationImportSheet.tsx` — "Matched: You, Partner" pill row.
- `client/src/components/Planner/ReservationModal.tsx` ⚠️ — passenger-match chip row, minimal diff.

**Dependencies:** none (Levenshtein is a ~30-line function; don't pull a library).

**Upstream:** Partial. Matcher is generic; the UI delta depends on the partner concept existing upstream.

---

## 3. Key architectural choices

- **Symmetry enforcement:** application-level, inside a `db.transaction(...)`. Vacay-invite-accept precedent. CHECK can't express cross-row; trigger would add an invisible DB-side mutation and worsen rebase.
- **Pairing flow:** invite/accept via existing boolean-notification + callback registry. Direct-set rejected (consent).
- **Partner without an account — "register first" MVP.** Magic-link registration auto-pair is appealing but couples too tightly with the MFA policy for first-version scope.
- **Backfill:** opt-in, one-time, tracked via `settings.partner_backfill_done`. No auto-run on pair.
- **Unpair semantics:** clear `partner_user_id` on both rows. **No trip_members mutation.** Trip history preserved.
- **Partner permission level:** plain trip_member. No new role column, no new permission key.
- **Smart Import match enhancement:** slice 5, keep it — small, additive.
- **Notifications:** new `partner_invite` event type. Auto-add-to-trip reuses `trip_invite` (same semantic). Two new in-app action handlers (`partner_invite_accept`, `partner_invite_decline`) — no new accept/decline endpoints.

---

## 4. Open questions

### Must decide before coding starts

1. **Target must have an account** (no magic-link registration): OK for this MVP?
2. **Single partner only** (enforced by unique indexes): confirm the semantic.
3. **Backfill notification volume:** aggregate > 5 trips + per-trip otherwise, or always aggregate?
4. **`POST /trips/:id/copy` auto-add:** exclude copied trips from partner auto-add (plan's choice), or include?
5. **`partner_user_id` in export/import schema (Milestone 7):** flag as known TODO rather than designing it here — acceptable?

### Can decide during

6. Invite message max length (200 chars).
7. Visual partner indicator in trip members list (small pair-of-rings icon).
8. Scheduler-based cleanup of expired `partner_invites` (lazy-on-accept is enough for MVP).
9. Rate-limit on `sendInvite` (one per minute per user).
10. Email i18n coverage for `de.json`.
11. Silent vs notified auto-add (reusing `trip_invite` event).
12. Per-trip opt-out of auto-add at create time (no for MVP).

---

## 5. Environment prerequisites

None new.

---

## 6. Upstream contribution stance

| Slice | Upstream? | Notes |
|---|---|---|
| 1 — schema + service | Yes | Generic. |
| 2 — REST + notifications | Yes | Reuses upstream primitives. |
| 3 — Settings UI | Yes | Additive; i18n-clean. |
| 4 — trip auto-add + backfill | Yes | Small hook in `createTrip`. |
| 5 — smart-import match | Partial | Matcher is generic; UI depends on partner concept. |

Propose slices 1-4 as **one PR** titled "Add optional household partner pairing" after baking on `personal` for 2-3 weeks. Slice 5 as a follow-up PR after Milestone 2 (smart import) itself is upstream.

---

## 7. Merge-pain hotspots

| File | Slice | Why | Mitigation |
|---|---|---|---|
| `server/src/db/migrations.ts` | 1 | Two new thunks | Keep at TAIL; `[460-fork] Partner pairing` marker. |
| `server/src/db/schema.ts` | 1 | One column + one new CREATE TABLE | Adjacent to `users` definition. |
| `server/src/routes/auth.ts` | 2, 4 | 6 new routes | Single contiguous marked block. |
| `server/src/services/authService.ts` | 2 | `getCurrentUser` spreads in partner | Minimal diff. |
| `server/src/services/notificationService.ts` | 2 | Event-config entry | Grouped with our additions. |
| `server/src/services/notificationPreferencesService.ts` | 2 | Event type union + map | Tiny diff. |
| `server/src/services/notifications.ts` | 2 | i18n entries | Grouped. |
| `server/src/services/tripService.ts` | 4 | `createTrip` hook | `[460-fork] partner auto-add — BEGIN/END` markers. |
| `client/src/api/client.ts` | 2, 3, 4 | `authApi.partner` namespace | Single block. |
| `client/src/components/Settings/AccountTab.tsx` | 3 | Render `<PartnerSection />` | 3-line JSX addition. |
| `client/src/components/Planner/ReservationModal.tsx` | 5 | Passenger-match chips | Additive near Milestone-2 auto-filled pill. |
| `client/src/i18n/translations/en.ts`, `de.ts` | 2, 3 | New keys | Dedicated `partner` sub-keys. |

Files deliberately **not** touched: `middleware/auth.ts`, `middleware/mfaPolicy.ts`, `middleware/tripAccess.ts`, `services/permissions.ts`, `websocket.ts`.

---

## 8. Test coverage summary

| Slice | Unit | Integration | Client |
|---|---|---|---|
| 1 | partnerService symmetry, expiry, races | — | — |
| 2 | — | Full invite/accept/decline/unpair/cancel, 404/409/410, notification dispatch | — |
| 3 | — | — | Optional slice tests; mandatory two-session walkthrough |
| 4 | backfillTrips idempotency | Auto-add, backfill, post-unpair persistence | Manual walkthrough |
| 5 | passengerMatcher (exact, case, diacritic, Levenshtein) | Extract-endpoint fixture with user+partner | — |

---

## Critical files for implementation

- `server/src/db/migrations.ts` — append migrations 114 + 115 (slice 1).
- `server/src/services/partnerService.ts` — new; fat service for pairing (slices 1, 2, 4).
- `server/src/routes/auth.ts` — five new routes contiguous block (slices 2, 4).
- `server/src/services/tripService.ts` — `createTrip` auto-add hook (slice 4).
- `client/src/components/Settings/PartnerSection.tsx` — new; Settings → Account UI (slice 3).
