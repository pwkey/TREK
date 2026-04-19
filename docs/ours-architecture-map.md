# ours-architecture-map.md — 460 Trip Planner

**Purpose.** This is the orientation map for any Claude Code session starting cold in this repo. It tells you where trip data, real-time sync, auth, addons, migrations, and the PWA service worker all live, and which file you would touch to extend each area. Skim it before making changes; refer back to it when uncertain.

**Last updated:** 2026-04-19 (initial version).

**Scope.** Only the TREK codebase we have inherited from upstream. Our planned additions (Capacitor wrappers, offline mutation queue, shared segments, journals, JSON export, settle-up, availability poll) are not covered here — see `CLAUDE.md` §6 for those. When those land, update this file so it stays the single reference.

**Maintenance rule.** Any PR that touches schema, adds a new addon, a new WebSocket message type, a new Zustand slice, or a new Express middleware must also update the relevant section here in the same commit. Out-of-date architecture docs are worse than no docs — they actively mislead.

---

## 0. Top-of-repo layout (30-second orientation)

```
E:/code projects/460 trip planner/
├── client/                 React 18 + Vite + Tailwind + Zustand PWA
│   ├── src/
│   │   ├── App.tsx         Routes + dark-mode + global config bootstrap
│   │   ├── api/            axios client, WebSocket singleton, auth URLs
│   │   ├── components/     Feature-scoped UI (Planner, Budget, Collab, …)
│   │   ├── hooks/          Custom hooks (useTripWebSocket, etc.)
│   │   ├── i18n/           Translation provider + locale JSON
│   │   ├── pages/          Route-level screens
│   │   ├── store/          Zustand stores + slices + remote-event router
│   │   ├── services/       photoService (client-side only)
│   │   ├── types.ts        Shared TS types mirroring server responses
│   │   └── utils/
│   ├── public/             Static assets, PWA icons
│   └── vite.config.js      vite-plugin-pwa (Workbox) config lives here
├── server/                 Node 22 + Express + better-sqlite3
│   ├── src/
│   │   ├── index.ts        Process bootstrap + graceful shutdown
│   │   ├── app.ts          createApp(): all middleware + route mounting
│   │   ├── websocket.ts    WS server, room management, broadcast fns
│   │   ├── scheduler.ts    node-cron jobs (reminders, demo reset, …)
│   │   ├── config.ts       JWT_SECRET / ENCRYPTION_KEY derivation
│   │   ├── db/
│   │   │   ├── database.ts Singleton SQLite handle, WAL, helpers
│   │   │   ├── schema.ts   createTables() — full CREATE TABLE bundle
│   │   │   ├── migrations.ts Forward-only migration list (numbered)
│   │   │   └── seeds.ts    Admin user, default categories, default addons
│   │   ├── routes/         One file per resource (auth.ts, trips.ts, …)
│   │   ├── services/       Business logic (<resource>Service.ts)
│   │   ├── middleware/     auth, mfaPolicy, tripAccess, validate
│   │   ├── mcp/            Model Context Protocol handler
│   │   ├── demo/           Demo-mode seed + reset
│   │   ├── types.ts        Server-side TS types
│   │   └── utils/
│   ├── data/               SQLite file + logs + backups (runtime only)
│   ├── uploads/            Avatars, covers, photos, files (runtime only)
│   └── tests/              Vitest suites (unit / integration / websocket)
├── charts/                 Helm chart for Kubernetes deployment
├── docs/                   This file lives here. Our docs use `ours-*` prefix
├── Dockerfile, docker-compose.yml
└── CLAUDE.md               Project bible — read first
```

**Key invariants:**

- There is exactly one Express app (`createApp` in `server/src/app.ts`). All routes mount onto it. Tests use supertest against this same app factory.
- There is exactly one SQLite connection (`db` in `server/src/db/database.ts`), wrapped in a `Proxy` so backup-restore can swap the underlying handle without updating every import.
- There is exactly one WebSocket server, attached to the HTTP server after it starts listening (`server/src/index.ts:53`).
- The client has one axios instance (`client/src/api/client.ts`) and one WebSocket singleton (`client/src/api/websocket.ts`). All components and stores go through these; nothing calls `fetch()` directly.

---

## 1. Data model — SQLite tables, where defined, where accessed

All tables are defined inside one big `CREATE TABLE IF NOT EXISTS …` block in `server/src/db/schema.ts:3` (function `createTables`). New tables added later live in `server/src/db/migrations.ts` as anonymous migration thunks (see §6). The schema.ts file carries the canonical baseline for a **fresh** install; migrations.ts catches up **existing** installs. The two must remain consistent — if you add a column in migrations, add it to schema.ts too, otherwise fresh installs will diverge from migrated ones.

Every CRUD path for every entity flows through the same shape:

1. `server/src/routes/<resource>.ts` — thin Express handler, validates, calls service.
2. `server/src/services/<resource>Service.ts` — SQL queries and business logic.
3. `server/src/db/database.ts` — shared helpers (`canAccessTrip`, `isOwner`, `getPlaceWithTags`).

### 1.1 Core planning hierarchy

| Table | Columns (key ones) | Defined | Service | Route |
|---|---|---|---|---|
| `users` | `id`, `username`, `email`, `password_hash`, `role`, `mfa_*`, OIDC fields, per-user API keys | `schema.ts:5-30` | `authService.ts` | `routes/auth.ts`, `routes/oidc.ts` |
| `trips` | `id`, `user_id` (owner), `title`, `start_date`, `end_date`, `currency`, `cover_image`, `is_archived`, `reminder_days` | `schema.ts:40-53` | `tripService.ts` | `routes/trips.ts` |
| `trip_members` | `trip_id`, `user_id`, `invited_by`, `added_at` — unique(trip_id, user_id) | `schema.ts:182-189` | `tripService.ts` (members fns) | `routes/trips.ts` |
| `days` | `id`, `trip_id`, `day_number`, `date`, `notes`, `title` — unique(trip_id, day_number) | `schema.ts:55-63` | `dayService.ts` | `routes/days.ts` |
| `places` | `id`, `trip_id`, `name`, `lat/lng`, `address`, `category_id`, `price/currency`, `place_time/end_time`, `duration_minutes`, `image_url`, `google_place_id`, `osm_id`, `website`, `phone`, `transport_mode` | `schema.ts:82-107` | `placeService.ts` | `routes/places.ts` |
| `day_assignments` | Join of places onto days. `day_id`, `place_id`, `order_index`, per-assignment `reservation_*` fields, `assignment_time/end_time` | `schema.ts:115-125`, migrations 22 and 30 for extra cols | `assignmentService.ts` | `routes/assignments.ts` (mounted at `/api` — see note below) |
| `assignment_participants` | `assignment_id`, `user_id` — "who's going to this activity" | `schema.ts:410-415` | `assignmentService.ts` | part of `routes/assignments.ts` |
| `categories` | Global: `id`, `name`, `color`, `icon`, optional `user_id` | `schema.ts:65-72` | `categoryService.ts` | `routes/categories.ts` |
| `tags` | Per-user: `user_id`, `name`, `color` | `schema.ts:74-80` | `tagService.ts` | `routes/tags.ts` |
| `place_tags` | M:N join. Primary key (place_id, tag_id) | `schema.ts:109-113` | `tagService.ts` | via tags/places |

**Trip → Day → Place → Assignment is the central hierarchy.** A `place` is owned by a `trip` (trip-scoped, not global). A `day_assignment` places a specific place into a specific day with an order. Places can also appear in the library without being assigned to a day (the sidebar view).

**Mount quirk to know about:** `routes/assignments.ts` is mounted at `/api` (not `/api/trips/:tripId/...`) because its endpoints include cross-day moves. See `app.ts:192`. When adding assignment endpoints, prefer `/api/assignments/*` or `/api/days/:dayId/assignments/*` to keep things discoverable.

### 1.2 Reservations and travel logistics

| Table | Columns | Defined | Service | Route |
|---|---|---|---|---|
| `reservations` | `id`, `trip_id`, `day_id?`, `place_id?`, `assignment_id?`, `accommodation_id?`, `title`, `reservation_time/end_time`, `location`, `confirmation_number`, `status`, `type` (flight/hotel/restaurant/other), `metadata` JSON | `schema.ts:164-180` plus migrations 23, 35, 36 | `reservationService.ts` | `routes/reservations.ts` |
| `reservation_day_positions` | Per-day position for multi-day reservations: `reservation_id`, `day_id`, `position` | migration ~112 (`migrations.ts:848-855`) | `reservationService.ts` | n/a |
| `day_accommodations` | Multi-day hotel stay. `trip_id`, `place_id`, `start_day_id`, `end_day_id`, `check_in/out`, `confirmation` | `schema.ts:329-340` | `dayService.ts` (accommodation fns) | `routes/days.ts` (accommodationsRouter, mounted at `/api/trips/:tripId/accommodations`) |

Reservations have three optional parents: a day, a place, or an assignment. The `accommodation_id` column links a hotel reservation to a `day_accommodations` row that spans multiple days.

### 1.3 Files, photos, day notes

| Table | Columns | Defined | Service | Route |
|---|---|---|---|---|
| `trip_files` | `trip_id`, `place_id?`, `reservation_id?`, `note_id?`, `filename`, `original_name`, `file_size`, `mime_type`, `description`, `uploaded_by`, `starred`, `deleted_at` | `schema.ts:151-162` plus migrations 29, 33 | `fileService.ts` | `routes/files.ts` |
| `file_links` | M:N linking a file to multiple reservations / assignments / places | migration ~43 (`migrations.ts:321-331`) | `fileService.ts` | via files route |
| `photos` | Legacy per-trip photo metadata: `trip_id`, `day_id?`, `place_id?`, `filename`, `original_name`, `caption`, `taken_at` | `schema.ts:137-149` | touched by memories services | (no dedicated route — consumed by memories/unified) |
| `trip_photos` | External (Immich/Synology) photo references: `trip_id`, `user_id`, `immich_asset_id`, `shared` | migration ~40 (`migrations.ts:303-311`) | `services/memories/*` | `routes/memories/{immich,synology,unified}.ts` |
| `day_notes` | Per-day timeline notes: `day_id`, `trip_id`, `text`, `time`, `icon`, `sort_order` | `schema.ts:191-200` | `dayNoteService.ts` | `routes/dayNotes.ts` |

**Journals (our planned feature) do not exist yet.** The legacy `photos` table covers caption/taken_at but has no rich-text body. When implementing Milestone 4 (per-day journal), add a `day_journals` table rather than shoe-horning into `day_notes` (which is a timeline of short entries, not long-form prose).

### 1.4 Budget, packing, todo

| Table | Columns | Defined | Service | Route |
|---|---|---|---|---|
| `budget_items` | `trip_id`, `category`, `name`, `total_price`, `persons`, `days`, `note`, `paid_by_user_id` | `schema.ts:207-218`, migration 38 added `paid_by_user_id` | `budgetService.ts` | `routes/budget.ts` |
| `budget_item_members` | Per-user split: `budget_item_id`, `user_id`, `paid` | migration 26 (`migrations.ts:167-176`) | `budgetService.ts` | via budget route |
| `packing_items` | `trip_id`, `name`, `checked`, `category`, `sort_order`, `quantity`, `weight_grams`, `bag_id` | `schema.ts:127-135` plus migrations 42, 112 | `packingService.ts` | `routes/packing.ts` |
| `packing_bags` | `trip_id`, `name`, `color`, `weight_limit_grams`, per-bag optional `user_id` | migration 42 | `packingService.ts` | via packing route |
| `packing_bag_members` | M:N bag_id/user_id (replaces single user_id) | migration 112 (`migrations.ts:833-840`) | `packingService.ts` | via packing route |
| `packing_category_assignees` | `trip_id`, `category_name`, `user_id` — "Alice owns the Toiletries category" | migration 41 | `packingService.ts` | via packing route |
| `packing_templates`, `packing_template_categories`, `packing_template_items` | Admin-managed reusable templates | migration 42 | `adminService.ts` | `routes/admin.ts` + applied via packing route |
| `todo_items` (not shown in schema.ts — added via migration) | Simple per-trip task list | migrations (grep `todo_items`) | `todoService.ts` | `routes/todo.ts` |

TODO: verify `todo_items` exact schema — it was added via migration, not `schema.ts`, so reading `migrations.ts` is required to see current columns.

### 1.5 Addons

**Addons are first-class entities in the DB.** Do not hardcode "is feature X turned on" — always query the `addons` table.

| Table | Columns | Purpose |
|---|---|---|
| `addons` | `id` (string PK), `name`, `description`, `type`, `icon`, `enabled`, `config` (JSON blob), `sort_order` | One row per feature toggle. Types: `trip`, `global`, `integration`, `photo_provider` (special-cased). |
| `photo_providers` | `id`, `name`, `description`, `icon`, `enabled`, `sort_order` | Pluggable photo sources (Immich, Synology). Each exposes config `fields` via `photo_provider_fields`. |
| `photo_provider_fields` | per-provider form fields shown in the Admin panel | UI-driven config so new providers don't require client code changes for settings. |

Default addons are seeded in `server/src/db/seeds.ts:82` (`seedAddons`). See §5 for the full list and how to add one.

### 1.6 Collab addon tables

| Table | Purpose | Defined |
|---|---|---|
| `collab_notes` | Trip-scoped sticky notes with category, colour, pinning, optional website preview | `schema.ts:343-354` |
| `collab_polls` | `question`, `options` (JSON), `multiple`, `closed`, `deadline` | `schema.ts:356-366` |
| `collab_poll_votes` | Per-user option votes | `schema.ts:368-375` |
| `collab_messages` | Group chat, with `reply_to`, soft-delete | `schema.ts:377-384`, `deleted` column added by migration 28 |
| `collab_message_reactions` | Emoji reactions per (message, user) | migration 27 |

**Polls especially are worth reading** before you start the Milestone 7 availability-poll work — they already model "question + options + close-by-deadline + per-user votes". Our availability poll may be a thin extension rather than a new system.

### 1.7 Vacay addon tables

All defined in `schema.ts:257-327`:

- `vacay_plans`: the plan, owned by one user, configures block_weekends/holidays/carry_over.
- `vacay_plan_members`: other users invited into the same plan (fused planning).
- `vacay_user_colors`, `vacay_user_years`, `vacay_years`: per-user annotations.
- `vacay_entries`: the actual (user_id, plan_id, date) vacation-day records.
- `vacay_company_holidays`, `vacay_holiday_calendars`: external inputs.

Service: `vacayService.ts`. Route: `routes/vacay.ts` (mounted at `/api/addons/vacay`).

### 1.8 Atlas addon tables

- `visited_countries`: per-user `country_code` set. Migration 43.
- `bucket_list`: user's destinations with optional `target_date` (migration 78) and country_code/lat/lng.

Service: `atlasService.ts`. Route: `routes/atlas.ts` (mounted at `/api/addons/atlas`).

**Atlas stats are per-user, not per-trip.** When building the planned "memoir mode" timeline (Milestone 4), do not conflate with Atlas visited-countries. They are adjacent but distinct.

### 1.9 Cross-cutting tables

| Table | Purpose | Defined |
|---|---|---|
| `audit_log` | Security audit trail (`user_id`, `action`, `resource`, `details` JSON, `ip`) | `schema.ts:418-426` |
| `notifications` | In-app notifications with typed callbacks | `schema.ts:429-449`. Service: `inAppNotifications.ts` + `inAppNotificationActions.ts` |
| `notification_channel_preferences` | Per-(user, event_type, channel) opt-in | `schema.ts:453-459` |
| `notification_preferences` | Separate per-user pref table added in migration ~46 | see `migrations.ts:346` |
| `invite_tokens` | Registration invite links with max_uses / expires_at | migration 37 |
| `share_tokens` | Public read-only trip-share links (referenced in `app.ts:166`) | migration (grep `share_tokens`) |
| `app_settings` | Key-value bag for global settings (permissions, MFA policy, etc.) | `schema.ts:202-205` |
| `settings` | Per-user key-value settings | `schema.ts:32-38` |
| `schema_version` | Single row tracking current migration number | created at top of `runMigrations` |

### How to extend (data model)

To add a new table:

1. Add the `CREATE TABLE` to `schema.ts` (for fresh installs) **and** append a migration thunk to the `migrations` array in `migrations.ts` (for existing installs). Both must run cleanly.
2. Create `services/<name>Service.ts` with CRUD functions using prepared statements (`db.prepare(...).run/get/all`).
3. Create `routes/<name>.ts` mounting thin handlers that call the service and emit a `broadcast(tripId, '<name>:created', ...)` after successful writes (see §2).
4. Register the route in `app.ts` next to the sibling resources.
5. Add a Zustand slice under `client/src/store/slices/` and wire it into `tripStore.ts`.
6. Add an entry in `remoteEventHandler.ts` for each new WS event type.

---

## 2. WebSocket realtime

### 2.1 Server

**File:** `server/src/websocket.ts` (219 lines — read the whole thing before touching).

- Single `WebSocketServer` at path `/ws`, attached to the HTTP server in `server/src/index.ts:53` after `listen()`.
- Auth: the client fetches a short-lived one-shot token via `POST /api/auth/ws-token`, then opens `ws?token=…`. The server calls `consumeEphemeralToken(token, 'ws')` (see `services/ephemeralTokens.ts`) — tokens are single-use.
- After auth, the server re-verifies the user row and, if `require_mfa` is on globally, rejects sockets for users without MFA enabled (`websocket.ts:86-91`).
- Rooms are per-trip: `rooms: Map<tripId, Set<WebSocket>>`. Sockets explicitly `join` and `leave` each trip (lines 129-147). Joining verifies trip access via `canAccessTrip`.
- Heartbeat: 30 s ping/pong; sockets that miss a pong are terminated (`websocket.ts:49-57`).
- Per-socket rate limit: 30 messages per 10 s (`websocket.ts:27-29`).
- Max payload: 64 KB.

The file exports three entrypoints used elsewhere:

```ts
broadcast(tripId, eventType, payload, excludeSid?)   // all sockets in a room
broadcastToUser(userId, payload, excludeSid?)         // user-targeted (trip invites, etc.)
getOnlineUserIds()                                    // presence
```

`excludeSid` is how we skip echoing an event back to the socket that triggered it. The client sends its `socketId` (from the `welcome` message) in the `X-Socket-Id` header on every axios request; routes forward it to `broadcast(..., req.headers['x-socket-id'])`. This avoids double-applying optimistic state.

### 2.2 Message shapes

All broadcasts are plain JSON objects: `{ type, tripId, ...payload }`. Types follow the `<resource>:<verb>` convention. From grepping `broadcast(` across `server/src/routes/`:

| Type | Payload | Emitted from |
|---|---|---|
| `welcome` | `{ socketId }` | on connect (`websocket.ts:98`) |
| `joined` / `left` | `{ tripId }` | reply to client join/leave |
| `error` | `{ message }` | rate-limit, access denied |
| `place:created` / `:updated` / `:deleted` | `{ place }` or `{ placeId }` | `routes/places.ts` |
| `day:created` / `:updated` / `:deleted` | `{ day }` or `{ dayId }` | `routes/days.ts` |
| `dayNote:created` / `:updated` / `:deleted` | `{ dayId, note }` or `{ noteId, dayId }` | `routes/dayNotes.ts` |
| `assignment:created` / `:updated` / `:deleted` / `:moved` / `:reordered` / `:participants` | varies | `routes/assignments.ts` |
| `accommodation:created` / `:updated` / `:deleted` | `{ accommodation }` or `{ accommodationId }` | `routes/days.ts` |
| `packing:created` / `:updated` / `:deleted`, `packing:bag-*`, `packing:template-applied`, `packing:assignees` | varies | `routes/packing.ts` |
| `todo:created` / `:updated` / `:deleted` | `{ item }` / `{ itemId }` | `routes/todo.ts` |
| `budget:created` / `:updated` / `:deleted` / `:members-updated` / `:member-paid-updated` | varies | `routes/budget.ts` |
| `reservation:created` / `:updated` / `:deleted` | `{ reservation }` / `{ reservationId }` | `routes/reservations.ts`, also triggered from `routes/days.ts` and `routes/budget.ts` |
| `file:created` / `:updated` / `:deleted` | `{ file }` / `{ fileId }` | `routes/files.ts` |
| `collab:note:*` (5 variants), `collab:poll:*` (4 variants), `collab:message:*` (3 variants) | varies | `routes/collab.ts` |
| `memories:updated` | `{ userId }` | `routes/memories/immich.ts`. Escape hatch — handled via `window.dispatchEvent`, not the normal store reducer (see `remoteEventHandler.ts:249`). |
| `trip:updated` | `{ trip }` | emitted via `broadcastToUser` on trip settings change |

### 2.3 Client

**File:** `client/src/api/websocket.ts` (singleton, 170 lines).

- Singleton socket, not a hook. Opens on login (`authStore.ts` calls `connect()`), closes on logout (`disconnect()`).
- Auto-reconnect with exponential backoff (1 s → 30 s cap).
- On reconnect, it re-joins every previously active trip and fires the `refetchCallback` for each so UI state re-hydrates from the server. This is a coarse, brute-force resync — when the offline-first mutation queue lands we will need a finer-grained diff.
- Exposes: `connect`, `disconnect`, `joinTrip`, `leaveTrip`, `addListener`, `removeListener`, `getSocketId`, `setRefetchCallback`.

### 2.4 Client event router

**File:** `client/src/store/slices/remoteEventHandler.ts` (257 lines, one big switch).

Every WS event type is a case. For each case, the handler computes a new `TripStoreState` slice (immutable update) and returns it; Zustand merges. A remote `place:created` that we already have (by id) is a no-op. Optimistic `assignment:created` with a negative temporary id gets swapped for the real one when the server's broadcast arrives (see the `hasTempVersion` branch at line 47-54).

The per-trip subscription hook is `client/src/hooks/useTripWebSocket.ts`. It:

1. Calls `joinTrip(tripId)` on mount.
2. Adds `useTripStore.getState().handleRemoteEvent` as a listener.
3. Adds a second listener that re-fetches `files` when a `collab:note:*` event fires (notes can carry file attachments, and the reducer doesn't know which files to refresh otherwise).
4. Cleans up on unmount.

### How to extend (WebSocket)

To add a new real-time-synced resource:

1. In the route handler, after the DB write, call `broadcast(tripId, 'foo:created', { foo }, req.headers['x-socket-id'])`.
2. Add a case in `client/src/store/slices/remoteEventHandler.ts` that mutates the appropriate state slice.
3. If the new data lives in a new Zustand slice (not `tripStore`), either add it to `tripStore` (preferred for anything trip-scoped) or add a second listener somewhere that routes to the other store.
4. Follow the `resource:verb` naming. Verbs used so far: `created`, `updated`, `deleted`, `moved`, `reordered`, `members-updated`, `member-paid-updated`, `template-applied`, `assignees`, `participants`, `voted`, `closed`, `reacted`.

---

## 3. Zustand stores

State is split into seven top-level stores. Five are tiny single-concern stores; the other two (`tripStore`, `vacayStore`) are large and slice-based.

### 3.1 Store inventory

| Store | File | Size | Concern | Primary subscribers |
|---|---|---|---|---|
| `useAuthStore` | `authStore.ts` | 250 lines | Auth state, current user, app-level config (demo mode, dev mode, MFA policy, timezone, `hasMapsKey`), login/logout/register/MFA flows | `App.tsx`, `LoginPage`, `DashboardPage`, `SettingsPage`, every `ProtectedRoute` |
| `useSettingsStore` | `settingsStore.ts` | 73 lines | Per-user display settings (dark mode, language, currency, map tiles, temperature unit, time format) | `App.tsx` (dark-mode effect), `SettingsPage`, most display components |
| `usePermissionsStore` | `permissionsStore.ts` | 52 lines | Permission levels by action key. Exposes `useCanDo()` hook for components | Anywhere that gates an action (forms, buttons, modals) |
| `useAddonStore` | `addonStore.ts` | 51 lines | Enabled-addons list, exposes `isEnabled(id)` | Navbar (hides disabled features), AdminPage, any addon-gated UI |
| `useInAppNotificationStore` | `inAppNotificationStore.ts` | 192 lines | In-app notification inbox with read/unread and response callbacks | `InAppNotificationBell`, `InAppNotificationsPage` |
| `useTripStore` | `tripStore.ts` + 8 slices | ~2100 lines total | Everything inside a single open trip | `TripPlannerPage` and ~25 Planner/Budget/Collab/Packing/Todo/Files components |
| `useVacayStore` | `vacayStore.ts` | 323 lines | Vacay addon state (standalone — not bundled into tripStore because Vacay is a separate page) | `VacayPage`, `VacaySettings`, `VacayCalendar`, etc. |

### 3.2 tripStore slices

`TripStoreState` is a single Zustand store whose shape is assembled from 8 slice modules under `client/src/store/slices/`. Each slice returns a `{ action1, action2, … }` partial, and `tripStore.ts:62` spreads them all into one store. Reason: one store is simpler for the WS remote-event handler (it can `set(state => ...)` over any field without store coordination), but each slice file stays small and focused.

| Slice | File | Shape | Key actions |
|---|---|---|---|
| Places | `placesSlice.ts` | `places: Place[]` | `refreshPlaces`, `addPlace`, `updatePlace`, `deletePlace` |
| Assignments | `assignmentsSlice.ts` | `assignments: { [dayId]: Assignment[] }` | `addAssignment`, `moveAssignment`, `reorderAssignments`, participant mgmt |
| Day Notes | `dayNotesSlice.ts` | `dayNotes: { [dayId]: DayNote[] }` | `addDayNote`, `updateDayNote`, `deleteDayNote`, `reorderDayNotes` |
| Packing | `packingSlice.ts` | `packingItems: PackingItem[]` | add/update/delete, bag ops via route |
| Todo | `todoSlice.ts` | `todoItems: TodoItem[]` | standard CRUD |
| Budget | `budgetSlice.ts` | `budgetItems: BudgetItem[]` | CRUD + members + paid toggling |
| Reservations | `reservationsSlice.ts` | `reservations: Reservation[]` | CRUD |
| Files | `filesSlice.ts` | `files: TripFile[]` | `loadFiles` (pull from server) |

Plus top-level fields owned by `tripStore.ts` itself: `trip`, `days`, `tags`, `categories`, `selectedDayId`, `isLoading`, `error`, and the meta actions `loadTrip`, `refreshDays`, `updateTrip`, `addTag`, `addCategory`, `handleRemoteEvent`.

`loadTrip(tripId)` issues **seven** parallel requests (trip, days, places, packing, todo, tags, categories) via `Promise.all` — this is the big initial page-load fan-out in `tripStore.ts:86-94`.

### 3.3 Remote events → store

See §2.4. The key fact: `useTripStore.getState().handleRemoteEvent` is the single entrypoint the WS listener calls, and it routes every event type to the right slice via the switch in `remoteEventHandler.ts`. This is also where the optimistic/canonical reconciliation lives — any future offline-queue logic must respect that pattern so a locally-created record isn't duplicated by a subsequent server broadcast.

### How to extend (stores)

To add a new slice:

1. Create `client/src/store/slices/fooSlice.ts` exporting a factory `createFooSlice(set, get)` that returns `FooSlice`.
2. In `tripStore.ts`, import the slice, add `FooSlice` to the `extends` list, and spread `createFooSlice(set, get)` into the store.
3. Add its initial fields (`fooItems: []`) at the top of the `create((set, get) => ({...}))` block.
4. Add remote-event cases to `remoteEventHandler.ts`.
5. Components read with `useTripStore(s => s.fooItems)`.

**Anti-pattern:** Do not call `fetch()` or `axios` directly from components. Always go through the slice action, which goes through `api/client.ts`. This matters for offline-first — when the mutation queue lands it will interpose at the axios layer.

---

## 4. Authorization

Three-layer defence: route-level middleware for who can reach the handler, permission checks inside the handler for what they can do, and an MFA policy middleware that applies globally.

### 4.1 Middleware

| Middleware | File | Purpose |
|---|---|---|
| `authenticate` | `middleware/auth.ts:15` | JWT from `trek_session` cookie (preferred) or `Authorization: Bearer` header. Verifies, loads user row, attaches `req.user`. Responds 401 with `{ code: 'AUTH_REQUIRED' }` on failure — the client axios interceptor redirects to `/login` on this. |
| `optionalAuth` | `middleware/auth.ts:39` | Same as above but allows anonymous. Used for public share-link routes. |
| `adminOnly` | `middleware/auth.ts:59` | Requires `req.user.role === 'admin'`. Used in `/api/admin/*`. |
| `demoUploadBlock` | `middleware/auth.ts:68` | Rejects uploads from the demo account in production demo mode. |
| `requireTripAccess` | `middleware/tripAccess.ts:6` | Calls `canAccessTrip(tripId, userId)` — trip owner OR trip member. 404 if not. Attaches `req.trip` (owner id only). |
| `requireTripOwner` | `middleware/tripAccess.ts:23` | Owner only. 403 otherwise. Used for destructive trip ops. |
| `enforceGlobalMfaPolicy` | `middleware/mfaPolicy.ts:32` | If `app_settings.require_mfa === 'true'`, blocks API access for users without MFA enabled, with carve-outs for public routes and the MFA-setup endpoints themselves. Mounted globally in `app.ts:110`. |

### 4.2 Action-level permissions

**File:** `server/src/services/permissions.ts`. This is the permission matrix that supplements the owner/member dichotomy.

- 16 action keys (`trip_create`, `trip_edit`, `trip_delete`, `member_manage`, `file_upload`, `place_edit`, `budget_edit`, `packing_edit`, `reservation_edit`, `day_edit`, `collab_edit`, `share_manage`, `trip_archive`, `trip_cover_upload`, `file_edit`, `file_delete`).
- Four levels: `admin` > `trip_owner` > `trip_member` > `everybody`. Higher includes lower.
- Admin role always passes (`permissions.ts:133`).
- Defaults live in `PERMISSION_ACTIONS` (lines 19-55). Overrides are stored in `app_settings` as `perm_<action>` rows and cached in memory (invalidated on save).

**Usage in a route handler** (pattern — see `routes/collab.ts:74-75`):

```ts
const access = verifyTripAccess(tripId, authReq.user.id);   // or canAccessTrip
if (!access) return res.status(404).json({ error: 'Trip not found' });
if (!checkPermission('collab_edit', authReq.user.role, access.user_id, authReq.user.id, access.user_id !== authReq.user.id))
  return res.status(403).json({ error: 'No permission' });
```

The client has a mirror: `usePermissionsStore` + `useCanDo()` in `client/src/store/permissionsStore.ts`. These are exposed via `GET /api/auth/app-config` (`App.tsx:88-95`) and used to hide disabled-action UI.

### 4.3 Trip ownership model

- `trips.user_id` is the **owner** — exactly one per trip.
- `trip_members` lists collaborators. `canAccessTrip(tripId, userId)` returns a row when the user is either the owner OR a member (`db/database.ts:119-125`).
- `isOwner(tripId, userId)` is strict owner-only (`database.ts:127-129`).

For Milestone 2 (shared segments), a segment with multiple parent trips means access becomes "is this user an owner/member of **any** linked trip". Don't bolt this onto `canAccessTrip` — add a parallel `canAccessSegment(segmentId, userId)` helper and use it from segment routes.

### 4.4 JWT, cookies, sessions

- Token is signed with `JWT_SECRET` (derived in `server/src/config.ts` from `ENCRYPTION_KEY`, with fallback to `data/.jwt_secret`).
- Token is set as an httpOnly cookie `trek_session` (see `services/cookie.ts:setAuthCookie`). The cookie is marked `secure` in production or when `FORCE_HTTPS=true`.
- WebSocket auth goes through `ephemeralTokens.ts` — the client POSTs to `/api/auth/ws-token`, gets a one-shot token, opens the socket with it. The cookie itself is NOT sent on WS handshake in all browsers; the ephemeral-token indirection works around this.

### How to extend (authz)

To add a new permissioned action:

1. Add an entry to `PERMISSION_ACTIONS` in `services/permissions.ts`.
2. Use `checkPermission` in every route that performs that action.
3. Expose it to the client by ensuring `/api/auth/app-config` includes the new action (it iterates all `PERMISSION_ACTIONS` automatically, so no client change is needed unless you want a default-off UI).
4. In React components, gate with `useCanDo()` — never invent a new permission check in the client.

**Do not edit** `middleware/auth.ts` or `middleware/mfaPolicy.ts` for normal feature work. CLAUDE.md §2.5 explicitly flags these as sensitive — our fork should avoid diverging from upstream unless we have a compelling reason.

---

## 5. Addons (Vacay, Atlas, Collab, and the extension surface)

### 5.1 The addon system

There is no plugin loader or dynamic import. "Addon" means:

1. A row in the `addons` table (see §1.5). The row's `enabled` column gates the feature.
2. A set of routes in `server/src/routes/` that are always mounted but check `isAddonEnabled(id)` via `adminService.isAddonEnabled` before doing anything.
3. A client page and/or set of components that check `useAddonStore().isEnabled(id)` before rendering.

Seeded defaults from `server/src/db/seeds.ts:82`:

| id | Name | Type | Default | Icon | Purpose |
|---|---|---|---|---|---|
| `packing` | Lists | trip | enabled | `ListChecks` | Packing list & todo (per trip) |
| `budget` | Budget Planner | trip | enabled | `Wallet` | Expenses & splits |
| `documents` | Documents | trip | enabled | `FileText` | `trip_files` |
| `collab` | Collab | trip | enabled | `Users` | Chat, notes, polls |
| `memories` | Photos | trip | disabled | `Image` | Immich/Synology photo integration |
| `vacay` | Vacay | global | enabled | `CalendarDays` | Vacation planner |
| `atlas` | Atlas | global | enabled | `Globe` | Visited countries + bucket list |
| `mcp` | MCP | integration | disabled | `Terminal` | Model Context Protocol endpoint |

Plus two `photo_providers` rows (Immich, Synology) with dynamic config fields in `photo_provider_fields`. These render settings forms from DB rather than component code.

### 5.2 What each shipped addon does

**Vacay** — a separate `/vacay` page; personal vacation-day planner with invited co-planners ("fused" mode), public-holiday overlays (100+ countries via a static data source), company-defined closure days, weekend configuration per plan, carry-over tracking per year. Data tables: eight `vacay_*` tables (§1.7). Routes: `/api/addons/vacay/*`. Service: `vacayService.ts`. Store: `useVacayStore`. Page: `pages/VacayPage.tsx`, components in `components/Vacay/`.

**Atlas** — a separate `/atlas` page; interactive world map of visited countries (with region granularity for larger nations), bucket list of wanted destinations with optional target dates, travel stats (continent breakdown, streaks). Data tables: `visited_countries`, `bucket_list`. Routes: `/api/addons/atlas/*`. Service: `atlasService.ts`. Page: `pages/AtlasPage.tsx`.

**Collab** — in-trip tab; sticky notes, polls, group chat with reactions and replies. Data tables: `collab_notes`, `collab_polls`, `collab_poll_votes`, `collab_messages`, `collab_message_reactions`. Routes: `/api/trips/:tripId/collab/*`. Components in `components/Collab/`. This is the most upstream-aligned addon and the closest existing match for our planned availability-poll feature (§1.6).

**Memories (Photos)** — integrates external photo sources (Immich, Synology Photos) rather than hosting photos itself. Admin enables a provider, fills its credentials; user attaches photos from the provider to a trip via `trip_photos.immich_asset_id`. Routes: `/api/integrations/memories/*`. See `server/src/services/memories/`.

**MCP** — a read-mostly JSON-over-HTTP endpoint at `/mcp` that implements the Model Context Protocol so external AI clients (Claude Desktop, etc.) can read trip data. See `server/src/mcp/`. Off by default.

### 5.3 Addon-enabled bits on the client

- `client/src/store/addonStore.ts` loads `/api/addons` (enabled list) on mount.
- Components gate rendering with `useAddonStore().isEnabled('vacay')`.
- Tabs and menu items in `components/Layout/Navbar.tsx` hide themselves when the addon is disabled.

### How to extend (addons)

Two ways to add a feature:

**Pattern A — as an addon** (recommended when the feature is optional or maps cleanly to an on/off toggle):

1. Insert a row into `addons` via a migration (e.g. `INSERT OR IGNORE INTO addons (id, name, type, icon, enabled, sort_order) VALUES (...)`).
2. Seed it in `seeds.ts` too, so fresh installs get it.
3. Build routes, service, client components. At the top of route handlers, short-circuit with `if (!isAddonEnabled('myAddon')) return res.status(404)`.
4. In the client, wrap render blocks in `useAddonStore().isEnabled('myAddon') && <MyAddon />`.

**Pattern B — as core** (only when the feature is always-on, like our planned shared segments and offline queue). Skip the `addons` row; just add tables, routes, services, slices.

Our Milestone roadmap: **Segments = core.** **Journal = core but backed by the `memories`/`photos` data path.** **Settle-up = core (pure read over existing budget tables).** **Availability poll = could be a new addon OR an extension of Collab polls — decide during Milestone 7 planning.**

---

## 6. Migrations

### 6.1 How they run

**File:** `server/src/db/migrations.ts:4` (`runMigrations`).

- A single table `schema_version` holds the current version number.
- On startup (`database.ts:31`), `runMigrations(db)` runs after `createTables(db)`. Fresh installs get all tables from schema.ts, then the migrations table starts at `0` (or `19` for installs that are detected as already-migrated — see the detection at `migrations.ts:9-20`).
- Migrations are an array of anonymous thunks (`() => void`). Each index in the array is a version.
- The loop runs every migration with index >= currentVersion, inside a `db.transaction(...)` wrapper (`migrations.ts:869-877`). If any migration throws, the transaction rolls back and the process exits with code 1.
- On success, `schema_version` is updated to the new index.

**Critical invariant:** migrations are **forward-only**, **never reordered**, **never deleted**. Appending is the only safe edit. If you need to fix a broken migration in-place, add a *new* migration that repairs the broken state.

### 6.2 Current migrations list

As of reading, there are ~112 migrations in the array. They include:

- ALTER TABLE column adds (most common; `try/catch` around "duplicate column" errors).
- New table creates (e.g. migration 42 adds packing_bags).
- Data backfills (e.g. migration 22 copies `reservation_*` from `places` to `day_assignments`).
- Table rebuilds via `CREATE TABLE new; INSERT; DROP; RENAME` (e.g. the early `budget_items` rebuild at line 42).
- Addon inserts (e.g. `INSERT OR IGNORE INTO addons ... 'collab' ...` at migration 24).

### 6.3 Naming convention

There isn't one — each migration is an anonymous arrow function with no name or comment header. Some have a short `//` comment above (see migrations.ts:295, 299, 333, 338, 342). **Our convention (for new migrations we add):** put a `// Migration N: <what>` comment above each new thunk so they're greppable.

### 6.4 How to add a migration

1. Append a new `() => { ... }` thunk to the end of the `migrations` array in `migrations.ts`.
2. Use `try { db.exec('ALTER TABLE ... ADD COLUMN ...'); } catch (err: any) { if (!err.message?.includes('duplicate column name')) throw err; }` for idempotent column additions.
3. For new tables, `CREATE TABLE IF NOT EXISTS`.
4. **Also add the change to `schema.ts`** so a fresh install gets the same end state without running the migration.
5. For large data backfills, wrap the thunk body in its own `db.transaction(() => { ... })()` — the outer wrapper already does, but nested transactions are no-ops in SQLite and make intent clear.
6. Do NOT delete or reorder anything in the array. Adding is the only legal edit.

---

## 7. PWA and service worker

### 7.1 Where it's configured

**File:** `client/vite.config.js:8-89`. The `vite-plugin-pwa` plugin generates a Workbox service worker at build time. No hand-written `sw.js` — all config is declarative here.

Manifest values at the top of the generated file (name, theme colour, icons, display mode `standalone`) will need **rebranding for Milestone 1** (currently `TREK \u2014 Travel Planner`; we want `460 Trip Planner`).

### 7.2 What is cached today

| Pattern | Strategy | Cache name | Expiration |
|---|---|---|---|
| Precache: `**/*.{js,css,html,svg,png,woff,woff2,ttf}` | precache-and-update | default | on new deploy |
| `basemaps.cartocdn.com/*` (Carto map tiles) | CacheFirst | `map-tiles` | 1000 entries / 30 days |
| `*.tile.openstreetmap.org/*` (OSM tiles) | CacheFirst | `map-tiles` | 1000 / 30 days |
| `unpkg.com/*` (Leaflet CDN) | CacheFirst | `cdn-libs` | 30 / 365 days |
| `/api/*` except `/api/auth`, `/api/admin`, `/api/backup`, `/api/settings` | NetworkFirst (5 s timeout) | `api-data` | 200 / 1 day |
| `/uploads/covers/*`, `/uploads/avatars/*` (public assets) | CacheFirst | `user-uploads` | 300 / 7 days |

`navigateFallback: 'index.html'` means the SPA shell always resolves. The deny-list excludes `/api`, `/uploads`, `/mcp` so those never serve the HTML fallback.

**Critically for our offline-first work (CLAUDE.md §7):** there is **no background-sync** config, **no write caching** (POST/PUT/DELETE are not cached), and **no offline write queue**. This is read-only PWA caching. The entire offline-mutation-queue architecture we plan is a net-new addition on top of this baseline — the existing SW will stay for reads, and a separate mutation queue (IndexedDB + background-sync registration) will wrap writes.

### 7.3 SW lifecycle

- `registerType: 'autoUpdate'` means the SW installs in the background and takes over on the next navigation.
- `App.tsx:98-115` listens for version changes and clears caches + unregisters the SW when the app version shifts. This is a correctness belt-and-braces — if schema changes on the server make cached API responses bogus, the client nukes its cache on next load.

### 7.4 Native / Capacitor notes (future)

Nothing exists yet. Per CLAUDE.md §3, when we add Capacitor:

- The web SW continues to run on desktop PWA.
- Inside the Capacitor iOS/Android WebView, SW behaviour is more limited (iOS especially). Our design should NOT depend on SW background-sync on native — use `@capacitor/app` resume events instead.
- Long-lived storage shifts from IndexedDB (web) to `@capacitor/filesystem` (native) for large assets.

### How to extend (PWA)

To add a new runtime-cache rule:

1. Edit `client/vite.config.js`, add an entry to `workbox.runtimeCaching`.
2. Rebuild client (`npm run build` under `client/`).
3. Bump app version (`package.json` version fields) — the version check in `App.tsx` will clear stale caches on existing clients.

To add background-sync for writes (part of our planned Milestone 3):

1. Add a new Workbox `BackgroundSyncPlugin` entry targeting our mutation endpoints.
2. Maintain a parallel IndexedDB queue keyed by `client_mutation_id` (see CLAUDE.md §7.4).
3. On native, a Capacitor `@capacitor/app` `resume` hook drives sync — the SW's background-sync is unreliable inside the native WebView, so don't depend on it.

---

## 8. Scheduler and background tasks

**File:** `server/src/scheduler.ts` (not read in detail during this session — TODO: expand section). Invoked from `server/src/index.ts:47-50`:

```
scheduler.start();
scheduler.startTripReminders();
scheduler.startVersionCheck();
scheduler.startDemoReset();
```

Plus `startTokenCleanup()` for expiring ephemeral WS tokens. Uses `node-cron`. When we add the pre-trip reminders feature beyond the current day-based model, start here.

---

## 9. Cheat sheet: "where does X live?"

| Need to change | Start at |
|---|---|
| Add a new DB column | `schema.ts` + new migration in `migrations.ts` |
| Add a new REST endpoint | `routes/<resource>.ts` + `services/<resource>Service.ts`; register in `app.ts` |
| Add a new WS event | Emit `broadcast(...)` from the route; add case in `remoteEventHandler.ts` |
| Add a new client data field | Add to `types.ts` (server + client), extend the relevant slice |
| Gate a feature behind a toggle | Add to `addons` via seed + migration; check `isAddonEnabled` server, `useAddonStore().isEnabled` client |
| Add a permissioned action | Add entry to `PERMISSION_ACTIONS` in `services/permissions.ts`; use `checkPermission` in handler; gate UI with `useCanDo()` |
| Cache a new external asset offline | `client/vite.config.js` → `runtimeCaching` |
| Add a new settings key | `services/settingsService.ts` + `app_settings`/`settings` table + `useSettingsStore` field |
| Add a new page/route | `client/src/pages/` + route in `App.tsx` + (optionally) nav link in `Navbar.tsx` |
| Add a new migration | Append a thunk to the array in `migrations.ts`; mirror change in `schema.ts` |

---

## 10. Open TODOs for this document

- **Expand §8 (scheduler)**: enumerate the cron jobs and their timing.
- **Map the MCP surface** (`server/src/mcp/`) — not covered here; matters if we plan to use our own fork as an MCP backend for Claude integration.
- **Confirm `todo_items` schema** — added via migration, not in `schema.ts`. Worth reading the specific migration and re-noting here.
- **Document `notifications` pipeline end-to-end** — there are two tables (`notifications` and `notification_preferences`), two services (`inAppNotifications.ts`, `notificationService.ts`, `notificationPreferencesService.ts`), and a client store plus bell component. How they interact is worth writing up before extending (especially if we surface "sync conflict" as a notification type).
- **Document the share-token path** — `share_tokens` table, `routes/share.ts`, the public `SharedTripPage`. Relevant if our planned pre-trip availability-poll uses a similar unauthenticated-link pattern.
- **Figure out where WS event types are enumerated** (if anywhere). Right now the set is implicit — server emits strings, client switches on strings, and there's no shared `WebSocketEvent` type list. Adding a shared enum would catch typos. TODO: check whether `client/src/types.ts` has a `WebSocketEvent` union we missed.

Keep this list at the bottom. As each one gets resolved inline, delete the TODO.
