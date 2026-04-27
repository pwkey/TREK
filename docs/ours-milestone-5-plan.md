# Milestone 5 Implementation Plan — Offline-first writes

**Status:** all 5 slices shipped on 2026-04-27. Browser-test pass deferred — slices are individually unit/integration-tested but the end-to-end "edit offline → reconnect → see sync" walkthrough has not been done in a real browser yet. Add a checklist analogous to `docs/ours-m4-browser-test-checklist.md` before declaring M5 done. Honest scope cuts vs the original plan: per-callsite optimistic UI was pushed off slice 3 (see commit body), and Workbox Background Sync was deferred from slice 5 (we have an in-page sync worker + Capacitor lifecycle hook, but not a service-worker-level Background Sync queue) — both noted because they're real gaps for Safari-PWA users.
**Date:** 2026-04-27
**Feature spec:** `CLAUDE.md` §6 Milestone 5 + §7 (the offline-first architecture spec)
**Architecture context:** `docs/ours-architecture-map.md`
**Precedent:** `docs/ours-milestone-3-plan.md`, `docs/ours-milestone-4-plan.md`

This is the largest engineering milestone in the fork roadmap. CLAUDE.md §12 explicitly flags "budget 2-3× whatever the initial estimate is" — that warning is real, and the slicing here errs toward small, separately-shippable steps even when each slice individually does less than feels satisfying.

---

## Orientation notes (material findings that shaped the plan)

- **Today's mutation flow is direct `fetch`/axios from components → API → optimistic local update on response.** Every write fails offline. There is no client-side persistence between page loads beyond what TREK's existing Workbox SW caches (read-only API GETs and static assets).
- **Most server tables already carry `updated_at` and `updated_by`** (`schema.ts` + later migrations). Trips, days, places, assignments, day_notes, packing_items, todo_items, budget_items, reservations all have this. Last-write-wins on the record level is therefore expressible without schema changes.
- **TREK's existing `client_mutation_id` plumbing is partial** — Milestones 2 and 3 already added idempotency to a handful of endpoints (reservation imports, partner invites, segment create). The pattern is established but uneven. M5 makes it universal.
- **WebSocket is the existing real-time channel** (`websocket.ts`). It's what currently keeps two collaborators' state aligned. Offline-first does NOT replace it — when online, WS still drives live updates. The mutation queue is what fills the offline gap and the brief-network-blip case.
- **Capacitor is scaffolded but not actually shipping yet** (Milestone 1 phase A only). The native lifecycle hooks for sync flush land here as part of slice 5 even though we're not running on a real iOS/Android device yet — the hooks degrade to no-ops on web.
- **Existing axios interceptor at `client/src/api/client.ts`** — single chokepoint for auth-redirects + socket-id header. Mutation queue piggybacks here cleanly: every write either hits the queue first or is replayed from the queue.

---

## 1. Commit slicing (5 commits + a follow-up if needed)

| # | Commit title | What works after it lands | What still doesn't |
|---|---|---|---|
| 1 | `feat(offline): IndexedDB local mirror + online/offline indicator (read path)` | `idb`-backed local store mirrors trips/days/places/assignments/dayNotes for any trip the user opens. `useOnlineStatus` hook + a small navbar indicator (green dot / red dot). On cold start while offline, the planner hydrates from IndexedDB so a refreshed tab still shows what was last loaded. No write-side changes yet — mutations still fail when offline, but reads now survive. | No queue. No optimistic offline writes. |
| 2 | `feat(offline): server-wide client_mutation_id idempotency middleware + client mutation queue + one wired mutation` | Server has a global idempotency middleware that consults a SQLite-backed `client_mutations` table. Replays of the same `X-Client-Mutation-Id` return the cached response. Client has a `mutationQueue` (IndexedDB-backed) with enqueue / process / retry-with-backoff. **One** representative mutation — `PUT /api/trips/:tripId/days/:id` — is wired through it end-to-end as a working example. Pending-sync count badge in the navbar. | Other mutations still bypass the queue. |
| 3 | `feat(offline): migrate the remaining write paths through the queue` | Places, assignments, day notes, reservations, packing items, todo items, budget items, segments (re-route the calls already added in M4) all flow through `enqueueMutation`. Optimistic UI is universal: writes apply locally first, sync in background, retry on failure, surface errors as toasts. | Conflict surface still implicit (last-write-wins, no review UI). |
| 4 | `feat(offline): conflict review panel + GET /api/conflicts` | Server detects when an enqueued mutation's `If-Match` precondition (record's `updated_at` at queue time) doesn't match current state and stashes it as a "conflict" instead of applying. Conflict list endpoint returns `{ id, record_type, mine, theirs, mine_at, theirs_at }`. Settings → "Pending conflicts" panel offers Keep mine / Take theirs per row. | Background sync via service worker not yet — sync only fires while a tab is open. |
| 5 | `feat(offline): trip-level offline pre-cache + service-worker Background Sync + Capacitor lifecycle flush` | "Download for offline" button per trip pre-fetches everything (days, places, photos thumbnails, map tiles for the bounding box) into IndexedDB / Workbox caches. The service worker registers POST/PUT/DELETE to our mutation endpoints with the Background Sync API where supported (Chromium on web; Capacitor on native). On Capacitor, `App.addListener('resume', …)` flushes the queue. | iOS Safari PWA still won't background-sync (browser limitation, not our code). |

Slice 1 is the read-side foundation — it's the smallest possible thing that proves the wiring without changing user-visible behaviour for online users. Slice 2 is the architecture skeleton: queue + idempotency. Slice 3 is the bulk of the migration work. Slice 4 is the user-visible conflict UX. Slice 5 is the polish + native integration.

Each slice ships independently green: the app stays functional after each commit lands, and existing online behaviour is preserved.

---

## 2. Per-slice details

### Slice 1 — Local mirror + offline indicator

**Files added:**
- `client/src/db/localDb.ts` — `idb` setup, schema versioning, object stores for `trips`, `days`, `places`, `assignments`, `dayNotes`, `reservations`, `_meta`.
- `client/src/hooks/useOnlineStatus.ts` — wraps `navigator.onLine` + `'online'`/`'offline'` events.
- `client/src/components/Sync/SyncIndicator.tsx` — small dot in the navbar with hover tooltip.
- `client/src/db/__tests__/localDb.test.ts` — schema upgrade test.

**Files modified:**
- `client/src/store/tripStore.ts` ⚠️ — on every server fetch, also write through to `localDb`. On cold start, hydrate from `localDb` first if a network call hasn't completed yet (so a refresh while offline shows the last-loaded trip).
- `client/src/components/Layout/Navbar.tsx` ⚠️ (upstream-hot) — render `<SyncIndicator />` next to the user menu. `[460-fork]` markered.
- `package.json` — add `idb` (`^8.x`).

**Out of scope:** mutation queue, write-through to local on user actions, optimistic UI. Reads are the only thing that improves.

---

### Slice 2 — Idempotency middleware + mutation queue + one wired mutation

**Server side:**

- New `server/src/db/migrations.ts` migration: `client_mutations` table.
  ```sql
  CREATE TABLE IF NOT EXISTS client_mutations (
    client_mutation_id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    endpoint TEXT NOT NULL,
    method TEXT NOT NULL,
    status_code INTEGER NOT NULL,
    response_body TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX idx_client_mutations_user_created ON client_mutations(user_id, created_at);
  ```
- `server/src/middleware/idempotency.ts` — Express middleware. Reads `X-Client-Mutation-Id` header. If seen for this `user_id`, returns the cached response. Else passes through and a wrapper around `res.json` records the response on the way out.
- `server/src/scheduler.ts` — daily cleanup of `client_mutations` rows older than 30 days.
- Apply the middleware globally in `app.ts` to every authenticated mutation route (POST/PUT/DELETE). Existing endpoints that already do their own idempotency check (reservation imports, partner invites, segment create) keep theirs as a no-op-when-already-cached short-circuit; the global middleware handles everything else.

**Client side:**

- `client/src/db/mutationQueue.ts`:
  ```ts
  interface QueuedMutation {
    id: string;        // client_mutation_id (uuid)
    endpoint: string;  // '/trips/5/days/12'
    method: 'POST' | 'PUT' | 'DELETE';
    payload: unknown;
    createdAt: number;
    attempts: number;
    lastError: string | null;
  }
  ```
  API: `enqueue(m)`, `process()`, `peek()`, `count()`, `clear()`. Uses `idb`. Exponential backoff (1s, 2s, 4s, 8s, … cap 5min). Max attempts: 20, then surface as a permanent failure.
- `client/src/api/client.ts` ⚠️ — every axios mutation now sets `X-Client-Mutation-Id`. Default flow: fire request → on success, done; on network error, enqueue. Optimistic-update helpers introduced as a reusable shape.
- `client/src/store/slices/daysSlice.ts` (or whatever surface owns updateDay today) — wire `updateDay` through the new helper. Optimistic local update + enqueue + reconcile-on-success.
- `client/src/components/Sync/SyncIndicator.tsx` — gains pending-count badge.

**Tests:**
- Unit: idempotency middleware on the server (replay returns cached body, status code, headers).
- Unit: mutationQueue (enqueue, process happy path, process retry, dedupe by id).
- Integration: PUT /api/trips/:id/days/:id replayed with same `X-Client-Mutation-Id` returns identical body.

**[460-fork] markers** on every modified upstream file, so future rebases can spot the M5 hooks at a glance.

---

### Slice 3 — Migrate the rest of the writes

**Approach:** one resource at a time, in roughly this order so the ones we use most-often on a real trip land first:
1. Day notes (heavy use on the road).
2. Day assignments (drag-and-drop; already needs deduping).
3. Places (create, update, delete).
4. Reservations.
5. Packing items.
6. Todo items.
7. Budget items.
8. Segments mutations (create / accept / leave / dissolve / mint-invite all flow through the queue too).

For each: switch the api/client.ts wrapper from a direct call to `enqueueMutation`, add the optimistic-update side, ensure the server endpoint still works (it already gets idempotency from the global middleware in slice 2).

**Files modified:** ~20 client files, mostly small.

**Tests:** integration replays for each migrated endpoint.

---

### Slice 4 — Conflict review

**Concept:** when a queued mutation reaches the server, it carries the `updated_at` it observed at queue time as an `If-Unmodified-Since` header (or a body field). If the server's current `updated_at` is newer, the mutation is parked in a `client_mutation_conflicts` table instead of applied. Client polls (on resume / on online) for new conflicts.

**Server side:**
- New table `client_mutation_conflicts(id, user_id, mutation_id, record_type, record_id, mine_payload, theirs_snapshot, observed_at, server_at, created_at)`.
- New endpoint `GET /api/conflicts` — list pending conflicts for the caller.
- New endpoints `POST /api/conflicts/:id/resolve` — accepts `{ choice: 'mine' | 'theirs' }`. If 'mine', re-apply the mutation overriding the server snapshot. If 'theirs', delete the conflict record (server state already reflects "theirs"). Custom merges are out of scope for MVP — user can manually edit after taking theirs.

**Client side:**
- `client/src/components/Settings/ConflictsSection.tsx` — list with side-by-side diff (left = "Yours, written 12 min ago"; right = "Server, last updated 5 min ago by {who}"). Two buttons per row, plus a third "Combine" for text-only fields (day notes, place notes, journal entries) that concatenates yours + a separator + theirs and saves the result via a fresh `POST /api/conflicts/:id/resolve` with `{ choice: 'combine', merged_text }`.
- Sync indicator adds a yellow dot when conflicts > 0.

---

### Slice 5 — Pre-cache + Background Sync + Capacitor lifecycle

**Server side:** a new endpoint `GET /api/trips/:id/offline-bundle` that returns a single JSON of everything the trip needs: days+assignments+places+notes+reservations+budget+packing+todo+files-metadata+(thumbnails inline as base64 below 100KB each). Larger files get URLs the client can pre-fetch into the SW cache.

**Client side:**
- `client/src/components/Trips/DownloadForOffline.tsx` — button on the trip detail page. Tap → fetches the bundle, populates IndexedDB, asks the SW to pre-cache the trip's map tile bounding box.
- `client/src/sw.ts` (Workbox extension): registers Background Sync queue for our mutation endpoints. Web-only (Chromium); on Safari this is a no-op and we fall back to the in-page retry already added in slice 2.
- `client/src/capacitor.ts` (NEW): centralises Capacitor plugin imports behind feature-detect so web builds remain functional. `App.addListener('resume', () => mutationQueue.process())`.

---

## 3. Key architectural choices

- **Library: `idb`** (4kb, low ceremony, promise-friendly). Rejected Dexie — heavier and mostly useful for query patterns we don't need.
- **Persistence shape: object stores per resource type, NOT one big "objects" store.** Keeps queries cheap and migration manageable.
- **Per-record LWW**, not per-field. Existing `updated_at` columns suffice. Per-field would require a schema rework that is out of proportion for current scale (household).
- **Idempotency at the server is universal middleware**, not per-route. Endpoints that already do it (reservation imports, partner invites, segment create) keep theirs — both layers are now idempotent. The middleware short-circuits before the route runs, so no double-work.
- **Optimistic UI by default.** Every wired mutation applies locally before the network round-trip. On permanent failure (max retries reached or conflict) the local state rolls back and a toast/conflict-row appears.
- **Mutation queue is per-tab.** Cross-tab coordination via `BroadcastChannel` could prevent N tabs replaying the same mutation, but the server idempotency catches duplicates anyway. Defer the optimisation.
- **Background Sync is best-effort.** Real coverage = Chromium web + Capacitor native. Safari (web) and iOS PWA fall back to "process on next tab visibility".
- **Conflict UI is opt-in.** Users see a yellow indicator and a Settings panel; we don't pop modals interrupting their flow. They review when convenient.
- **Three-tier storage model** (per OQ-D). Tier 1 (app data + thumbnails) is the only thing M5 directly touches and is capped at 50 MB. Tiers 2 (phone full-res photos via Capacitor filesystem) and 3 (web full-res via opt-in Workbox precache) are documented here but ship in M6 alongside the journal feature. Phone-to-laptop photo sync is server-mediated — the mutation queue uploads when online and the laptop pulls on demand.

---

## 4. Open questions

### Must decide before coding starts

_All resolved 2026-04-27. See §9 decision log._

### Can be deferred (out of scope unless they bite us)

- **OQ-G — Cross-tab queue dedup** via BroadcastChannel.
- **OQ-H — Per-field LWW** (requires schema overhaul).
- **OQ-I — CRDT migration** path.
- **OQ-J — Encrypted-at-rest IndexedDB** (low priority — local data is no more sensitive than what's already in the SW cache).

---

## 5. Upstream contribution strategy

This whole milestone is a strong upstream candidate per CLAUDE.md §4.3 — every TREK user has the offline-write gap. But the surface area is huge and our particular slicing reflects our use case (couples + occasional groups, not enterprise teams). Plan:

1. Land all 5 slices on `personal`. Bake on at least one real trip with intentionally-flaky connectivity (e.g. airplane mode for stretches).
2. Identify which pieces would be drop-in for upstream (likely: idempotency middleware, IndexedDB mirror, queue) vs which are ours-only (conflict UI styled to our settings panel; offline bundle endpoint).
3. Propose upstream as **multiple smaller PRs** — server idempotency is its own PR, client mutation queue another, conflict review a third. Avoids one giant unmergeable change.

Realistic timeline: months, not weeks. Upstream maintainer's call on appetite.

---

## 6. File touch / upstream merge-risk table

| File | Slice | Change type | Upstream hot? | Mitigation |
|---|---|---|---|---|
| `client/package.json` | 1 | Adds `idb` | Low | Single dep |
| `client/src/db/localDb.ts` | 1 | New | No | — |
| `client/src/hooks/useOnlineStatus.ts` | 1 | New | No | — |
| `client/src/components/Sync/SyncIndicator.tsx` | 1 | New | No | — |
| `client/src/store/tripStore.ts` | 1, 3 | Hydrate from localDb on start; write-through on every fetch | Medium | `[460-fork]` markers around the new hydrate + write-through blocks |
| `client/src/components/Layout/Navbar.tsx` | 1 | Render SyncIndicator | **HIGH** | `[460-fork]` marker, single render addition |
| `client/src/api/client.ts` | 2, 3 | Every mutation now goes via enqueue helper | **HIGH** | `[460-fork]` markered; non-mutation behavior byte-identical to upstream |
| `server/src/middleware/idempotency.ts` | 2 | New | No | — |
| `server/src/db/migrations.ts` | 2, 4 | Append migrations 120 (`client_mutations`) and 121 (`client_mutation_conflicts`) | High | At tail with idempotency guards |
| `server/src/db/schema.ts` | 2, 4 | Mirror new tables in fresh-install bundle | High | Same conditional pattern as M4 |
| `server/src/app.ts` | 2 | Mount idempotency middleware globally | Medium | Single insert above route mounts |
| `server/src/scheduler.ts` | 2 | Daily cleanup job | Low | Additive entry |
| `client/src/db/mutationQueue.ts` | 2 | New | No | — |
| `client/src/store/slices/*.ts` | 2, 3 | Each slice's mutation calls flow through enqueue | Medium | `[460-fork]` markers in each |
| `server/src/routes/conflicts.ts` | 4 | New | No | — |
| `client/src/components/Settings/ConflictsSection.tsx` | 4 | New | No | — |
| `server/src/routes/trips.ts` | 5 | Adds GET /:id/offline-bundle | Medium | Single endpoint, marked |
| `client/src/sw.ts` | 5 | Workbox extension | Medium | `[460-fork]` markers |
| `client/src/capacitor.ts` | 5 | New | No | — |

---

## 7. Test matrix (acceptance bar before committing each slice)

| Slice | Key test | Verifies |
|---|---|---|
| 1 | Cold-start tab while offline shows the last-loaded trip from IndexedDB | Read-side hydration |
| 1 | Indicator dot turns red on `'offline'` event, green on `'online'` | Hook works |
| 2 | Replaying same `X-Client-Mutation-Id` returns identical body | Idempotency middleware |
| 2 | Offline → toggle a day title → toggle online → server has the new title | One mutation through the queue |
| 2 | mutationQueue retries with backoff on 5xx, surfaces permanent failure on 4xx (except 409 conflict) | Queue logic |
| 3 | Place / assignment / note / reservation / packing / todo / budget / segment edits all survive offline | Full migration |
| 4 | Two tabs both edit the same day title offline; one comes online first; second's mutation lands as a conflict, NOT silent overwrite | Conflict detection |
| 4 | Choosing "mine" reapplies; choosing "theirs" discards; both clear from the conflicts panel | Resolution flow |
| 5 | "Download for offline" populates IndexedDB from the bundle endpoint and the SW's tile cache | Pre-cache |
| 5 | Capacitor `App.resume` triggers `mutationQueue.process()` | Native lifecycle |

---

## 8. What's explicitly NOT in Milestone 5

- Per-field LWW or CRDT (deferred indefinitely).
- Cross-tab mutation deduplication via BroadcastChannel.
- Encrypted-at-rest IndexedDB.
- Full peer-to-peer sync without a server.
- A merge-editor for conflicts (mine-or-theirs only for MVP).
- Standalone offline bundle viewer (Milestone 7's piece).

---

## 9. Decision log

- **2026-04-27 — OQ-A resolved = `idb`.** Lightweight (~4 kB), promise-friendly, no query patterns we don't already get for free. Dexie's extras would be unused weight.
- **2026-04-27 — OQ-B resolved = mine-or-theirs + Combine for text fields.** Two buttons (Keep mine / Take theirs) for every conflicted record; a third button (Combine) for text-only fields (day notes, place notes, journal entries) that simply concatenates with a separator and saves the result, leaving the user to clean up afterward. No generic merge editor; full CRDT remains out of scope per CLAUDE.md §7.3.
- **2026-04-27 — OQ-C resolved = navbar dot + pending-count badge.** A red/green/yellow dot with a small numeric badge for pending mutations and conflicts. Hover tooltip lists the next-to-sync; click navigates to a fuller status panel (Settings → Pending sync).
- **2026-04-27 — OQ-D resolved = three-tier storage model.** The "50 MB cap" only applies to tier 1 (app data + thumbnails ≤300 px). Photo originals get their own tiers and lifecycle, deferred to Milestone 6:
  - **Tier 1** (IndexedDB on web; same on Capacitor) — trips, days, places, notes, expenses, plus journal thumbnails. Cap **50 MB** total. LRU evict oldest non-active trip on quota errors.
  - **Tier 2** (Capacitor filesystem on phone, M6) — full-resolution photos taken in-app, copied into the app sandbox at capture time (NOT linked to camera roll: too easy to orphan when the user cleans up their camera roll). No app-imposed cap; OS-managed.
  - **Tier 3** (Workbox precache on web/laptop, M6) — photo originals only when the user clicks "Download for offline" for a specific trip. Per-trip explicit consent, with usage MB displayed and a "Clear cache for this trip" action. No automatic eviction.
  - Phone-to-laptop photo sync is **server-mediated**, not P2P. Phone uploads to server in the background via the same mutation queue; laptop pulls from server when online. The "Download for offline" button on the laptop populates Tier 3 from the server.
- **2026-04-27 — OQ-E resolved = `updated_at` snapshot.** When a mutation is enqueued client-side, capture the record's `updated_at` at that moment and send it as a header (`If-Unmodified-Since` semantics) when the queue eventually replays the mutation. Server compares to current `updated_at`; mismatch parks as conflict. No new monotonic version-counter column — every record we touch already has `updated_at`.
- **2026-04-27 — OQ-F resolved = defer to M7.** The standalone offline bundle viewer is part of Milestone 7 (JSON export/import). M5's "Download for offline" reuses the eventual M7 bundle endpoint shape, but the standalone HTML viewer doesn't ship until M7.
