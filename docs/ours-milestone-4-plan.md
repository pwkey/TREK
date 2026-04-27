# Milestone 4 Implementation Plan — Shared Segments

**Status:** all 5 slices shipped + manually verified end-to-end on 2026-04-27. Browser-test pass surfaced (a) a startup bug in slice 1's schema.ts (fixed), (b) a string-vs-number tripId on POST /api/segments (fixed), (c) a missing inviter on the accept page (added), (d) a stale "Adventure with Bob" entry that prompted auto-dissolve when the last sibling leaves (added), (e) a missing path to mint additional invite tokens for an existing segment (added), (f) a missing home-owner escape hatch when siblings won't leave (added: dissolveSegment + DELETE /api/segments/:id + UI). All in `docs/ours-m4-browser-test-checklist.md`.
**Date:** 2026-04-20
**Feature spec:** `CLAUDE.md` §6 Milestone 4
**Architecture context:** `docs/ours-architecture-map.md`
**Precedent:** `docs/ours-milestone-3-plan.md`

This is the flagship cross-household feature — the reason the fork exists. Scope is larger than M2/M3 and touches upstream-hot files (`days` table, `listDays` query, day UI). Treat the upstream-merge-risk column of §7 as first-class.

---

## Orientation notes (material findings that shaped the plan)

- **`days` is `(id PK, trip_id FK NOT NULL, day_number, date, notes, title) UNIQUE(trip_id, day_number)`** (`schema.ts:77-85`). No cross-trip concept today. Adding `segment_id INTEGER NULL REFERENCES segments(id) ON DELETE SET NULL` is a pure ALTER — no constraint rework.
- **Day reads flow through `listDays(tripId)` in `dayService.ts:77`** — single query `SELECT * FROM days WHERE trip_id = ? ORDER BY day_number`. Every planner surface routes through this. Extending it with a UNION that also pulls segment-linked days is the surgical spot; upstream touches this file frequently so a clearly-marked `[460-fork]` block is mandatory.
- **WebSocket broadcast is room-scoped by trip_id** (`websocket.ts:177-190`). `broadcast(tripId, eventType, payload)` fans out to subscribers of one room. Segment fan-out is a new helper `broadcastToSegment(segmentId, …)` that looks up linked trips and loops — does NOT change the core `broadcast` signature, minimising merge surface.
- **Invite-link precedent exists.** Share links on the collab addon (`shareService.ts`) produce time-limited signed URLs. Segment invite links can reuse the same signing approach without a new crypto surface.
- **Last migration is 115** (`partner_invites`). M4 appends **three** thunks — 116 (`segments`), 117 (`trip_segments`), 118 (ALTER `days`) — at the tail, each behind an idempotency guard.
- **Home-trip concept is load-bearing.** SQLite cascades `days` rows when their `trip_id` trip is deleted. A segment day therefore always has exactly one "home trip" (where it was created). If that home trip is deleted, the day cascades — the segment would lose rows from under its sibling-trip viewers. We must either (a) block trip delete while it hosts segment days referenced by other trips, or (b) rehome such days on delete. See OQ-B.
- **No addon scaffolding.** Segments are core (affects every trip), not an addon. Place feature flags at the service / route layer, not in `addon_registry`.

---

## 1. Commit slicing (5 commits)

| # | Commit title | What works after it lands | What still doesn't |
|---|---|---|---|
| 1 | `feat(segments): schema + service (no routes, no UI)` | Migrations 116-118 run. `segmentService.ts` exposes `createSegment / addTripToSegment / removeTripFromSegment / listSegmentsForTrip / listTripIdsForSegment / createInvite / acceptInvite`. Symmetry + authorisation logic unit-tested. | No HTTP routes. No day-merge. No UI. |
| 2 | `feat(segments): REST + day-list union + WebSocket fan-out` | `POST /api/segments`, `GET /api/segments/:id`, `POST /api/segments/:id/invites`, `POST /api/segments/accept`, `DELETE /api/segments/:id/trips/:tripId`. `listDays(tripId)` returns own-trip days UNIONED with segment-linked days. Every mutation on a segment-linked day fans out over WebSocket to all linked trips. Integration tests cover fan-out and authorisation. | No UI yet. |
| 3 | `feat(segments): create-segment UI + invite link copy` | Trip-detail overflow menu → "Create shared segment from these days" → date-range picker → title → generates a signed invite link → copy-to-clipboard. Caller's own days get `segment_id` set (no cloning). | No accept flow yet. |
| 4 | `feat(segments): accept flow + visual markers on shared days` | Invite link opens a landing page → "Attach to which of your trips?" picker → on attach, recipient's overlapping days are replaced or extended with confirmation, and the trip starts seeing the shared segment days via the union. Day cards show a chip ("Shared with Smith Europe 2027") and a tooltip listing linked trips. WebSocket events for a segment-day update both households live. | No unlink UI. |
| 5 | `feat(segments): leave/unlink + delete-safety + audit log` | `DELETE /api/segments/:id/trips/:tripId` clones the segment days into plain trip-owned days for the leaving trip (memento). Segment continues for the remaining trips. Delete-trip confirmation blocks when the trip hosts segment days referenced by siblings, with a "dissolve segment or rehome first" hint. All segment actions write to `auditLog`. | — |

Slices 1-2 are server-only. Slice 3 is write-path UI. Slice 4 is read-path UI + real-time. Slice 5 is the lifecycle cleanup. Each slice compiles, tests, and ships.

---

## 2. Per-slice details

### Slice 1 — Schema + service, no routes

**Migrations (at tail of `migrations.ts`, marked `[460-fork] Milestone 4`):**

```sql
-- 116
CREATE TABLE IF NOT EXISTS segments (
  id TEXT PRIMARY KEY,                      -- UUID per CLAUDE.md §9
  title TEXT NOT NULL,
  start_date TEXT,                           -- summary only, not a constraint
  end_date TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL
);

-- 117
CREATE TABLE IF NOT EXISTS trip_segments (
  trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  segment_id TEXT NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
  is_home INTEGER NOT NULL DEFAULT 0,        -- exactly one home-trip per segment
  joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  joined_by INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  PRIMARY KEY (trip_id, segment_id)
);
CREATE INDEX IF NOT EXISTS idx_trip_segments_segment ON trip_segments(segment_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_trip_segments_home
  ON trip_segments(segment_id) WHERE is_home = 1;

-- 118  (ALTER — idempotent guard, marked [460-fork])
ALTER TABLE days ADD COLUMN segment_id TEXT REFERENCES segments(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_days_segment ON days(segment_id) WHERE segment_id IS NOT NULL;
```

Also: a small `segment_invites` table (signed-link pattern). Sketch:
```sql
CREATE TABLE IF NOT EXISTS segment_invites (
  id TEXT PRIMARY KEY,
  segment_id TEXT NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,                -- HMAC-signed, single use
  expires_at DATETIME NOT NULL,
  accepted_at DATETIME,
  accepted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE
);
```

**Files added:**
- `server/src/services/segmentService.ts` — fat service. Core API:
  - `createSegment({ userId, tripId, dayIds, title })` — assigns `segment_id` to the specified day rows (must all belong to tripId; enforce contiguous date range). Returns `{ segment, home_trip_id }`.
  - `listSegmentsForTrip(tripId)` — joins via `trip_segments`.
  - `listTripIdsForSegment(segmentId)` — reverse of the above; used by `broadcastToSegment`.
  - `createInvite({ segmentId, userId })` — signed token, 7-day expiry.
  - `acceptInvite({ token, userId, targetTripId, overlapStrategy })` — validates token, resolves overlap strategy (`'replace' | 'keep_own' | 'error'`), inserts `trip_segments` row, sets `segment_id` on the target trip's overlapping days (or inserts new day rows when the target trip doesn't cover those dates).
  - `removeTripFromSegment({ segmentId, tripId, userId })` — leaves; clones segment days into plain trip-owned days so the leaver keeps a memento. If the last non-home trip leaves, the segment persists with only the home trip (functionally equivalent to never having been shared).
  - `canDeleteTrip(tripId)` — used by the trip delete path to block when the trip hosts segment days referenced by siblings. Returns `{ ok: true } | { ok: false, reason, blocking_segment_ids }`.
- `server/tests/unit/segmentService.test.ts` — CRUD, symmetry of home-trip flag, overlap strategy correctness, cloning on leave, delete-safety.

**Files modified:**
- `server/src/db/schema.ts` — add the three new tables to the fresh-install bundle (keeping migrations-as-source-of-truth convention per §1 of the architecture map).

**Out of scope for this slice:** routes, UI, WebSocket fan-out, auditing. Slice 2 does those.

---

### Slice 2 — REST + day-list union + WebSocket fan-out

**Files added:**
- `server/src/routes/segments.ts` — endpoints:
  ```
  POST   /api/segments                        { trip_id, day_ids, title }
  GET    /api/segments/:id                    { segment, linked_trips, days }
  POST   /api/segments/:id/invites            → { token, url, expires_at }
  POST   /api/segments/accept                 { token, target_trip_id, overlap_strategy }
  DELETE /api/segments/:id/trips/:tripId      (leave)
  ```
- `server/tests/integration/segments.test.ts` — create, link, accept, fan-out, unlink, delete-safety.

**Files modified:**
- `server/src/services/dayService.ts` ⚠️ **high merge risk** — `listDays(tripId)` becomes:
  ```sql
  SELECT d.* FROM days d
   WHERE d.trip_id = :tripId
      OR d.segment_id IN (SELECT segment_id FROM trip_segments WHERE trip_id = :tripId)
   ORDER BY d.date, d.day_number
  ```
  Wrap the changed block in `// [460-fork] shared-segments union — BEGIN/END`.
- `server/src/websocket.ts` — add `broadcastToSegment(segmentId, eventType, payload)` that fetches the linked-trip list and delegates to `broadcast` for each. Additive; upstream won't touch it.
- `server/src/services/dayService.ts` day-mutation paths (`updateDay`, `createDay`, `deleteDay`): when the affected row has a `segment_id`, call `broadcastToSegment` instead of `broadcast`. Keep the non-segment path unchanged for upstream-diff parity.
- `server/src/app.ts` — mount the new router.
- `server/src/routes/trips.ts` — plug `canDeleteTrip` gate into the DELETE path. Return 409 `SEGMENT_REFERENCES_BLOCK_DELETE` when applicable.

**WebSocket event types (new):**
- `segment:attached` — someone linked a trip to a segment we're in.
- `segment:detached` — someone left.
- `segment:day_updated` — day mutation fanned out across linked trips.

---

### Slice 3 — Create-segment UI

**Files added:**
- `client/src/components/Segments/CreateSegmentModal.tsx` — date-range picker restricted to the current trip's date range. Preview: "N days will be shared: Jun 10, Jun 11, Jun 12". Title input. On submit: POST `/api/segments`, then POST `/api/segments/:id/invites`, show the signed URL with a copy-to-clipboard button.
- `client/src/api/segments.ts` — typed axios wrappers.

**Files modified:**
- `client/src/components/Planner/DayPlanSidebar.tsx` ⚠️ (upstream-hot) — overflow menu gains "Share these days with another household…". Behind a feature-flag so baseline users don't see it if we need to hide it pre-approval.
- `client/src/store/tripStore.ts` — optimistic update of `days[i].segment_id` after creation.

---

### Slice 4 — Accept flow + visual markers

**Files added:**
- `client/src/pages/SegmentAcceptPage.tsx` — route `/segments/accept/:token`. Shows segment summary, lists caller's trips, date-overlap warning, overlap strategy chooser (`replace_own` default / `keep_own` / `cancel`), confirm. Covers unauthenticated case (prompt login, preserve token).
- `client/src/components/Planner/SharedDayChip.tsx` — small pill showing "Shared · {title}" + tooltip with the list of linked trips.

**Files modified:**
- `client/src/App.tsx` — add the accept route.
- `client/src/components/Planner/DayCard.tsx` ⚠️ (upstream-hot) — render the chip when `day.segment_id` is set. Wrap in `// [460-fork]` markers to keep the diff obvious on rebase.
- `client/src/store/slices/remoteEventHandler.ts` — handle `segment:day_updated`, `segment:attached`, `segment:detached` — triggering targeted store patches rather than a full reload.

---

### Slice 5 — Leave/unlink + delete safety + audit

**Files modified:**
- `client/src/pages/SegmentsPanel.tsx` (new, modest) or inline inside trip settings — list segments this trip is part of, with a "Leave segment" action per row. Confirm-dialog: "Your trip will keep a copy of these days but they will no longer sync with Smith Europe 2027."
- `server/src/services/segmentService.ts` — `removeTripFromSegment` clones-on-leave.
- `server/src/services/auditLog.ts` — new action codes `segment.create`, `segment.invite_create`, `segment.accept`, `segment.leave`, `segment.day_update`.

---

## 3. Key architectural choices

- **Model A — single canonical day row per segment-date.** No cloning at attach time. `days.segment_id` is the pointer. Every linked trip sees the day via the union query. Simplest, lowest write-amplification, cleanest conflict story.
- **Home trip concept.** Every segment has exactly one `is_home = 1` `trip_segments` row — the trip where the segment was born. Deletion of the home trip is either blocked or triggers a rehome/dissolve prompt (OQ-B). Keeps the FK cascade honest.
- **Authorisation — any linked-trip member = full edit.** The segment-creator-only model would undersell the "stays in sync" promise. A bad-actor risk exists but these are household-scale groups by construction. See OQ-A.
- **Overlap strategy on accept** is user-chosen (`replace_own` / `keep_own` / `cancel`), never silent. Default is `replace_own` — the common case is "we're adding days we don't have yet or have nothing on."
- **Real-time fan-out** piggybacks on existing WebSocket rooms. `broadcastToSegment` loops over linked trip rooms. No new subscription semantics — a user who has the segment's sibling trip open sees updates because they're already subscribed to that trip's room.
- **Expenses on shared days are trip-scoped.** A budget row on a shared day belongs to the trip it was created in; only that trip's members see it. Defer cross-household settle-up to Milestone 8.
- **Timezone/currency** follow the viewing trip's own settings. The shared day data itself carries no timezone. Each household sees their own view over the shared underlying place/note data.
- **Places and day-assignments on shared days are cross-visible (OQ-K = option a).** The whole value of a shared day is joint planning. A place pinned to a shared day by household A is visible on household B's planner for that day and vice versa. Any linked-trip member can edit or delete either pin. Each place row keeps its original `trip_id` (the trip of whichever household created it) — visibility expands via the assignment → day → segment → linked-trips join, NOT via a schema change to `places`. Places NOT yet assigned to any day remain private to their home trip.
- **Tags stay trip-scoped.** Each household sees only its own tags on a shared place. Prevents a tag-merge rabbit hole and keeps each household's organisational system independent.
- **Upstream-diff discipline.** Every modified upstream-hot file gets a `[460-fork] shared-segments — BEGIN/END` marker around our changes. Matches the pattern introduced in Milestone 2 and 3.

---

## 4. Open questions

### Must decide before coding starts

_All resolved 2026-04-20. See §9 decision log._

### Can be deferred

- **OQ-G — Cross-household expense reconciliation** — deferred to Milestone 8.
- **OQ-H — Per-field LWW / CRDT** — deferred to Milestone 5 (offline-first). Slice 2's fan-out uses last-write-wins by `updated_at` which is what the online path already effectively does.
- **OQ-I — Journal entries on shared days** — deferred to Milestone 6 (per-day journal). At that time we decide per-trip vs shared journal.
- **OQ-J — "Shared with {N households}" badge on the trip dashboard card** — visual polish, slot into Milestone 10+ if we want it.

---

## 5. Upstream contribution strategy

Shared segments is the headline feature that most likely justifies an upstream PR per CLAUDE.md §4.3. Plan:

1. Complete all 5 slices on `personal`.
2. Ship to our household for at least two real trips (one same-household, one cross-household) before upstream discussion.
3. Propose upstream as a single PR titled **"Add shared segments: days that appear in multiple trips"**, with the 5 commits squash-preserved where possible.
4. Expect upstream pushback on the ALTER to `days` (the hot-file concern). Prepare a fallback — if upstream insists on no schema change to `days`, we can maintain the column as a fork-only migration and loop the extension through the service layer only.

---

## 6. File touch / upstream merge-risk table

| File | Slice | Change type | Upstream hot? | Mitigation |
|---|---|---|---|---|
| `server/src/db/schema.ts` | 1 | Additive (3 new CREATE TABLE, 1 ALTER) | Medium — upstream evolves schema | Append to the tail; preserve ordering |
| `server/src/db/migrations.ts` | 1 | Append 3 thunks | High — every release adds migrations | Keep at the numbered tail, behind idempotency guards. Expect rebase conflicts; resolve by renumbering our appended thunks to the new tail |
| `server/src/services/segmentService.ts` | 1 | New file | No | — |
| `server/src/services/dayService.ts` | 2 | Modify listDays + mutation paths | **HIGH** — upstream touches this often | Wrap changed blocks in `[460-fork]` BEGIN/END markers. Keep non-segment code paths byte-identical with upstream |
| `server/src/services/placeService.ts` | 2 | Expand read path: include places assigned to any day in our linked segments | Medium | `[460-fork]` markers |
| `server/src/services/assignmentService.ts` | 2 | Expand read path: include assignments on shared days | Medium | `[460-fork]` markers |
| `server/src/routes/segments.ts` | 2 | New file | No | — |
| `server/src/routes/trips.ts` | 2 | Add canDeleteTrip gate | Medium | Single-line check, marked |
| `server/src/websocket.ts` | 2 | Add broadcastToSegment | Low | Purely additive export |
| `server/src/app.ts` | 2 | Mount new router | Low | Single-line addition |
| `server/src/services/auditLog.ts` | 5 | New action codes | Low | Enum append |
| `client/src/api/segments.ts` | 3 | New file | No | — |
| `client/src/components/Segments/*` | 3,4,5 | New files | No | — |
| `client/src/components/Planner/DayPlanSidebar.tsx` | 3 | Overflow menu entry | **HIGH** | Feature-flag + `[460-fork]` markers |
| `client/src/components/Planner/DayCard.tsx` | 4 | Render chip | **HIGH** | `[460-fork]` markers around the chip render block |
| `client/src/store/tripStore.ts` | 3,4 | New segment-day state + remote event handler | Medium | Additive slice; wrap in marker |
| `client/src/store/slices/remoteEventHandler.ts` | 4 | Handle new event types | Medium | Case-arm extension, marker |
| `client/src/App.tsx` | 4 | New route | Low | Single-line addition |
| `client/src/pages/SegmentAcceptPage.tsx` | 4 | New file | No | — |

---

## 7. Test matrix (acceptance bar before committing each slice)

| Slice | Key test | Verifies |
|---|---|---|
| 1 | `createSegment` validates contiguous date range, single trip | Rejects mixed-trip input, rejects gaps |
| 1 | `acceptInvite(replace_own)` replaces target-trip's overlapping day rows with pointers | Target trip now sees source trip's days via union |
| 1 | `acceptInvite(keep_own)` extends the segment with target-trip day rows | Source trip now sees target trip's overlapping days |
| 1 | `removeTripFromSegment` clones days → leaver keeps memento, siblings unchanged | Leaver's `days` rows have `segment_id = NULL`, same content |
| 1 | `canDeleteTrip` blocks when trip is home for a segment with siblings | Returns `ok: false, reason: 'SEGMENT_REFERENCES'` |
| 2 | `GET /trips/:id/days` returns union of own + segment days | Integration test with two trips linked via one segment |
| 2 | Day-update WebSocket event reaches sockets subscribed to either trip room | Fan-out |
| 2 | Non-member cannot read segment via `GET /api/segments/:id` | 403 |
| 3 | Manual walkthrough — create a segment from 3 days, copy link | UI path works end-to-end |
| 4 | Manual walkthrough — accept via link, see days populate in target trip | Union + WebSocket |
| 4 | Unauth'd accept redirects through login and resumes | Signed-link UX |
| 5 | Leave segment: my trip keeps a memento, sibling trip still sees the segment | Cloning correctness |
| 5 | Attempted home-trip delete shows blocking modal with rehome/dissolve options | Delete safety |

---

## 8. What's explicitly NOT in Milestone 4

These are tempting and deferred:

- Cross-household expense splits / settle-up across a segment (Milestone 8).
- Offline-first writes on shared days (Milestone 5).
- Journals on shared days (Milestone 6).
- Notifying the other household when one side edits a shared day (covered by existing trip activity log; no new notification type).
- Multi-level nesting (segments of segments).
- Public read-only view of a shared segment (Milestone 10+ shareable guide).

---

## 9. Decision log

- **2026-04-20 — OQ-D dropped.** No hard cap on segment length. A 90-day trip shared end-to-end is the user's call. Realistic use cases (e.g. two 1-2-week adventures inside a 3-month trip) are well inside any sensible cap, so an arbitrary limit just gets in the way.
- **2026-04-20 — OQ-K resolved = option (a).** Places and day-assignments on a shared day are cross-visible to all linked trips. Any linked-trip member can edit/delete. Tags stay trip-scoped. Places not yet assigned to any day remain private to their home trip. Drives additional changes in Slice 2 to `placeService.ts` and `assignmentService.ts` read paths.
- **2026-04-20 — OQ-A resolved.** Any linked-trip member can edit a shared day, matching the "stays in sync" core promise. Household-scale use, not public. Audit log records all edits with the actor's identity.
- **2026-04-20 — OQ-B resolved.** Deleting a trip that hosts segment days referenced by sibling trips is blocked until the user either dissolves the segment or rehomes the segment to another linked trip. Surfaced as a confirm-dialog with a clear explanation, not a silent 409.
- **2026-04-20 — OQ-C resolved.** Accept-with-overlap defaults to `replace_own`, with an always-visible preview ("3 days on your trip currently have pinned places / notes and will be replaced by the shared segment's content"). User can toggle to `keep_own` before confirming.
- **2026-04-20 — OQ-E resolved.** A signed segment-invite link opened by an unauthenticated user redirects to login/signup with `?next=/segments/accept/{token}`. After auth, the flow auto-resumes at the accept page. No anonymous segment membership.
- **2026-04-20 — OQ-F resolved.** Only a linked-trip owner can mint a new invite link for an existing segment. Plain trip members cannot. Keeps segment expansion a deliberate owner decision.
