# CLAUDE.md — 460 Trip Planner

Guidance for Claude Code working in this repository. Read this fully before your first substantive change. When in doubt, ask rather than guess — this codebase has an upstream we track, and the wrong change in the wrong file is a merge-conflict tax we'll keep paying.

---

## 1. What this project is

**460 Trip Planner** is a **personal fork of [TREK](https://github.com/mauriceboe/TREK)**, a self-hosted real-time collaborative travel planner (AGPL-3.0). Upstream is actively maintained and improving; we track it closely rather than hard-forking.

**Primary users:** me and my partner, plus occasionally another couple or two who travel with us for part of a trip. Not a public service. Not monetised.

**Why we're extending TREK rather than using it as-is:**

- **Shared segments** — when two households' trips overlap for some days, both planners should stay in sync for just those days.
- **Trip recording, not just planning** — per-day journals with photos, so completed trips read back as a memoir years later.
- **Works offline, anywhere** — we visit places with no connectivity. We must be able to *review* and *record* while offline, and sync cleanly when we're back on a network.
- **Dedicated apps on all our devices** — iOS, Android, and desktop. Installable, distributable, not "open the browser and type the URL."
- **Data ownership and portability** — full JSON export/import for archiving and moving between instances.
- **Reconciliation, not just tracking** — a "who owes whom" settle-up view on top of the existing budget.
- **Pre-trip date polling** — picking dates with the other couple before a trip record even exists.

The full feature-comparison analysis against Wanderlog, TripIt, Pilot, AdventureLog, Splitwise and others lives in `docs/feature-analysis.md` (create this if it doesn't exist yet). That document explains *why* we're building what we're building; this one explains *how*.

---

## 2. Read-this-first operating instructions for Claude Code

### 2.1 Before writing any code in a new area

1. **Read the relevant files first.** Use `view` on the files you'd modify. Don't infer structure from filenames.
2. **Write a short plan.** What files will change, what tables/schemas, what API endpoints, what UI components. Show me the plan before you start typing code.
3. **Flag anything that touches upstream core.** If a change modifies a file that upstream also actively changes, warn me — we may want to structure it as an overlay or addon to reduce merge pain.

### 2.2 Change scope

- **One concern per change.** Don't rename variables while adding a feature. Don't refactor while fixing a bug. Small, reviewable changes.
- **Prefer the additive path.** New table, new endpoint, new component beats modifying existing ones when both are available.
- **Don't golden-plate.** If I ask for a feature, build the feature. Don't also add three adjacent features you think I'd want. I will ask.

### 2.3 When you're uncertain

- Ask. One specific question is better than a confident wrong guess.
- If I've said "just do it," make your assumption explicit in the plan so I can correct it cheaply before you code.

### 2.4 Tests

- Backend: add tests for any new endpoint or data-layer logic. Regression catch > coverage metric.
- Frontend: tests are optional for UI; required for non-trivial hooks or client-side business logic (sync queue, conflict resolution, export/import).
- Running the app end-to-end once before declaring "done" is not optional.

### 2.5 Things to never do without explicit instruction

- Force-push to any branch.
- Modify git history on commits already pushed.
- Add new dependencies without calling them out in your plan.
- Change the database schema without a migration script.
- Touch auth, session, or JWT code without flagging it as sensitive.
- Add telemetry, analytics, or external calls that weren't already there.
- Commit signing certificates, provisioning profiles, or keystore files to git.

---

## 3. Distribution and the "dedicated app" requirement

460 Trip Planner must be available as a **dedicated installable app on iOS, Android, and desktop**. Three-layer strategy:

| Platform | Delivery | Distribution |
|---|---|---|
| iOS (iPhone, iPad) | Capacitor-wrapped native iOS app | TestFlight internal testing — up to 100 invitees, no full App Store review |
| Android | Capacitor-wrapped native Android app | Direct APK to trusted devices, or Google Play Internal Testing track |
| Desktop (macOS, Windows, Linux) | PWA via the existing Workbox service worker | Browser "Install as app" — creates a dock/taskbar icon, runs in its own window |

### 3.1 Why Capacitor and not React Native or native-per-platform

- Capacitor wraps our existing React/Vite web app in a native shell, so **one codebase** drives web, iOS, and Android. Reuses all of TREK's client code.
- React Native would mean rewriting the entire client. Not justified.
- Native Swift/Kotlin apps would mean maintaining three codebases. Not justified for a personal app.

### 3.2 Cost and account prerequisites

Before starting native-app work:

- **Apple Developer Program** — US$99/year. Required for TestFlight and App Store. Sign up with the Apple ID we want to own the app.
- **Google Play Console** — US$25 one-time, only if we want Play Store distribution (APK sideload to trusted devices is free and sufficient for a small group).
- **Mac for iOS builds** — Xcode only runs on macOS. Alternatives: GitHub Actions macOS runners, or a cloud build service like Expo EAS Build (it supports Capacitor despite the name). Decide on first iOS build.

### 3.3 Repo layout for native

The Capacitor wrapper adds two top-level directories:

```
/ios/          — Xcode project, Podfile, signing config (generated by Capacitor)
/android/      — Gradle project, build config (generated by Capacitor)
/capacitor.config.ts   — Capacitor configuration
```

These are generated by `npx cap add` but then committed. Native platform-specific config (Info.plist permission strings, AndroidManifest.xml entries, app icons, splash screens) lives inside them. Treat these as part of our fork — they're not upstream concerns.

### 3.4 What the native wrapper is NOT

It is not a place for business logic, UI, or data handling. The native shell should do as little as possible:

- Host the web view running our React app.
- Expose Capacitor plugins for capabilities the web view can't do (camera, filesystem for large files, background sync, native share sheet, native notifications, biometric unlock).
- Handle deep links (e.g. `460tripplanner://trip/abc123`).

Anything we can do in the web layer, we do in the web layer. The wrapper is a thin shell, not a second codebase.

### 3.5 Plugin choices (conservative defaults)

Start with only these Capacitor plugins; add more only when a feature needs one:

- `@capacitor/preferences` — small key-value storage (tokens, settings)
- `@capacitor/filesystem` — larger file storage (photo originals, offline bundles)
- `@capacitor/network` — online/offline detection
- `@capacitor/camera` — journal photo capture
- `@capacitor/app` — lifecycle hooks, deep links
- `@capacitor/share` — native share sheet for export bundles

Defer until actually needed: push notifications, biometrics, background tasks, geolocation.

### 3.6 Testing matrix

Any UI change must be visually checked on:

- Desktop Chrome or Firefox (the PWA path)
- iOS Safari *or* the Capacitor iOS app (one is sufficient — the web view is Safari-based either way)
- Android Chrome *or* the Capacitor Android app

Safe areas, notch handling, and bottom-bar clearance need testing on an actual phone, not just a desktop browser's responsive mode.

---

## 4. Fork strategy and upstream

### 4.1 Branch layout

- `main` — tracks upstream `main`. We rebase/merge regularly. No original work lives here.
- `personal` — our integration branch. All our custom features land here, rebased onto `main` whenever upstream releases.
- Feature branches cut from `personal`, merged back to `personal` when done.

### 4.2 Working with upstream changes

Before starting any non-trivial feature work:

```bash
git fetch upstream
git log --oneline main..upstream/main   # see what's new upstream
```

If there are relevant changes, integrate them into `main` and rebase `personal` before starting the new feature. Don't pile local changes on top of a stale upstream — the merge cost compounds.

### 4.3 Contributing upstream

Some features we build may be general-purpose. When a feature lands cleanly and isn't tightly tied to our quirks, propose upstream as a PR. Reduces our long-term merge burden and helps the community.

**Features likely to be upstream-worthy:** shared segments, JSON export/import, settle-up view, offline-first write queue, availability poll.

**Features probably not worth upstreaming:** the Capacitor native wrapper (upstream's call, not ours), our branding and default settings, our specific UI tweaks.

---

## 5. TREK architecture — orient yourself before changing anything

### 5.1 Stack summary (from upstream README)

- **Backend:** Node.js 22 + Express + SQLite (`better-sqlite3`)
- **Frontend:** React 18 + Vite + Tailwind CSS + Zustand state
- **Real-time:** WebSocket (`ws`) on `/ws`
- **PWA:** `vite-plugin-pwa` + Workbox
- **Auth:** JWT + OIDC
- **Maps:** Leaflet + `react-leaflet-cluster`; place search via Google Places (optional) or OpenStreetMap
- **Weather:** Open-Meteo (no key required)

**Our additions on top of this stack:**

- **Capacitor** for iOS and Android native wrappers (see §3)
- **Dexie or idb** for the offline write queue (see §7)

### 5.2 Repo layout

- `server/` — Express app, SQLite access, WebSocket handler, auth, migrations
- `client/` — React app, components, stores, service worker config
- `ios/`, `android/` — Capacitor native projects (our additions)
- `docs/` — upstream docs; our docs live here too but prefixed `ours-*` to avoid clashes
- `Dockerfile`, `docker-compose.yml` — production server deployment

### 5.3 First task in any new session

If it doesn't already exist, produce a written architecture map in `docs/ours-architecture-map.md`:

- Where trips, days, places, reservations, and users are defined in SQLite.
- Where WebSocket messages are dispatched on the server; where they're received on the client.
- How the Zustand stores are organised and which components subscribe to what.
- Where authorization checks happen (which middleware, which routes).
- How the "addon" system works — what the Vacay/Atlas/Collab addons are plugging into.
- Where migrations live and how they run at startup.
- How the PWA service worker is configured and what it caches today.

Keep this map up to date as you learn more. It's the highest-leverage artefact in the repo.

### 5.4 Concepts we will extend

- **Trip → Day → Place** is the core planning hierarchy. Our *segment* concept sits between trip and day.
- **Reservations** are a flat list attached to a trip. Future ingestion paths will add to this.
- **Collab addon** has polls and signup tracking — our availability-poll and activity-signup features may extend rather than replace.
- **Atlas addon** is the existing travel-stats/visited-countries surface — our journal feature is adjacent but distinct.

---

## 6. Feature roadmap

Build order is deliberate. Each item should be shippable on its own and usable on a real trip before the next starts. Do not start N+1 until N is in use.

### Milestone 0 — Baseline

Deploy upstream TREK unmodified via Docker Compose. Install as PWA on all our devices. Use it for one real trip. Capture pain points in `docs/ours-trial-notes.md`. Only then proceed.

### Milestone 1 — Brand as 460 Trip Planner, add Capacitor wrappers

Why this is first after baseline: the native wrapper affects how we think about offline storage, native APIs, and the build pipeline. Doing it before feature work means every feature is built mobile-native from day one.

**Scope:**

- Rename app to "460 Trip Planner" throughout — `package.json` names, PWA manifest, page title, splash, in-app logo placements. Keep the technical package name / Docker image as `trek-460` or similar (short, filesystem-safe).
- Add Capacitor (`@capacitor/core`, `@capacitor/cli`, `@capacitor/ios`, `@capacitor/android`), initialise, generate `ios/` and `android/` projects.
- App icon and splash screen (design once, Capacitor generates all sizes).
- Ensure the web app works inside the native WebView — most things "just work" but WebSocket URLs, CORS, and deep-link handling may need adjustment.
- Wire up `@capacitor/app` for lifecycle events (pause/resume → trigger sync flush).
- Build iOS via Xcode and get onto TestFlight internal testing.
- Build Android APK; sideload to test devices.
- Document the build process in `docs/ours-build-native.md`.

**Distribution setup:**

- Register Apple Developer Program account.
- Create App Store Connect record for 460 Trip Planner (internal TestFlight only — no public App Store listing).
- Android: decide on Play Store Internal Testing vs direct APK; default to direct APK for simplicity.

**Don't do yet:** push notifications, biometric unlock, any non-essential plugin. That's scope for a later milestone once we need them.

### Milestone 2 — Shared segments (the flagship data-model feature)

**Problem:** Couple A and Couple B each have their own trip record. For days 7–11 they travel together. Both households want those days to appear in their own trip timeline and stay in sync.

**Design sketch:**

- New table `segments` with `id`, `created_by_user_id`, `title`, `start_date`, `end_date`.
- New join table `trip_segments (trip_id, segment_id, role)` — a segment belongs to one or more trips.
- `days` gain an optional `segment_id`. A day belonging to a segment renders in every trip the segment is linked to.
- A user is authorised to view/edit a segment if they're a member of at least one parent trip. Start with "segment creator only can link additional trips, via invite link."
- UI: segment days display with a visual marker (coloured strip, icon, tooltip "Shared with The Smiths"). Editing a shared day shows "Edits visible to: your trip + Smith Europe 2027."

**Open questions to resolve in the plan phase:**

- What happens if the two trips have different timezones or currency defaults for a shared day?
- If one party leaves the segment, does their copy of those days remain as a snapshot or get deleted?
- How do per-person expenses on a shared day allocate between households?

### Milestone 3 — Offline-first writes (cross-cutting)

**This is not a standalone feature; it's a rewrite of how mutations flow through the app.** Specified in detail in §7. Build it now because Milestones 4+ assume it works.

### Milestone 4 — Per-day journal with photos

**Problem:** TREK is a planner. We also want it to be the place we record what actually happened.

**Design sketch:**

- New table `day_journals (day_id, content_markdown, updated_at, updated_by)`.
- New table `day_photos (day_id, upload_id, caption, taken_at, position)` using TREK's existing uploads plus Capacitor's camera plugin on native.
- Rich-text editor on the day view (keep markdown as source of truth — portable, diffable, exports cleanly).
- Timeline view: per trip, a scrollable "memoir mode" that renders days in sequence with photos and journal text, hiding the planning scaffolding.
- Photos: drag-and-drop multiple on web, native camera picker on iOS/Android, client-side resize before upload, EXIF-preserved capture date.
- Photos must work offline — queued locally, uploaded when online (see §7).

### Milestone 5 — JSON export and import

Specified in §8. Build after offline + journal so exports include journal content and pending-sync items correctly.

### Milestone 6 — Settle-up view

**Problem:** TREK tracks categorised expenses with splits. It doesn't answer "Alice owes Bob how much?"

**Design sketch:**

- No schema change — pure read-side computation over existing expenses and splits.
- Algorithm: build the net-position graph per person, then minimise cash-flow to suggest fewest transactions. Standard textbook problem; solutions in ~40 lines of JS.
- UI: one screen showing net positions and a recommended settlement ("Alice pays Bob $214, Carol pays Alice $87").
- Per-trip and per-segment views.

### Milestone 7 — Pre-trip availability poll

**Problem:** Before a trip exists, we need to pick dates with another couple.

**Design sketch:**

- New top-level feature, not inside a trip.
- Creator defines candidate date ranges. Shares a link. Non-members vote without creating an account (signed-link auth, time-limited).
- Once dates converge, one button creates a trip with those dates and invites the voters as members.
- Consider: integrate with the existing Vacay addon so availability can be pre-filled from vacation-day records.

### Milestone 8+ (deferred / reconsider after real use)

- Closed-on-this-day warnings when a place is scheduled on a closed day.
- Inter-stop travel time on the itinerary.
- Public shareable trip guide (read-only view of a completed trip).
- iCal feed export for calendar integration.
- Booking email import via forwarded confirmations.
- Push notifications (flight-day reminders, sync-completed confirmations).

### Explicitly out of scope

Don't propose, don't build, don't be tempted by:

- Real-time flight alerts (use TripIt free tier alongside 460 Trip Planner)
- AI itinerary generation
- Curated city guides / Explore tab (needs network effects we don't have)
- Neighbourhood safety, visa data, carbon footprint (needs paid data feeds)
- Receipt OCR
- React Native rewrite
- Native desktop app wrapper (PWA on desktop is sufficient)

If you think one of these has become relevant, raise it as a question, don't build it.

---

## 7. Offline-first write architecture

**This is a first-class requirement.** We travel to places with no connectivity. We must be able to read AND record (journal entries, packing-list ticks, expenses, place reordering, activity completion) while offline, with changes syncing cleanly when we're back online.

### 7.1 What upstream already gives us

TREK's Workbox service worker caches map tiles, API GET responses, uploads, and static assets. **This is read-only caching.** It does nothing for writes. Mutations fail when offline. That's the gap we're filling.

### 7.2 What Capacitor adds

On native iOS and Android, we get:

- More generous persistent storage (no Safari-style PWA eviction).
- `@capacitor/filesystem` for large file storage (full-size photos, offline bundles) — more reliable than IndexedDB blobs.
- `@capacitor/network` for quicker online/offline signal.
- Lifecycle hooks via `@capacitor/app` — trigger sync flush on app resume.

On desktop PWA we rely on IndexedDB and the Background Sync API where available.

### 7.3 Architectural principles

- **Local-first.** Every mutation writes to local storage first, then attempts to sync. The UI reads from local state, not from the server.
- **Optimistic by default.** The UI reflects the mutation immediately; if sync later fails permanently, show a conflict and let the user resolve.
- **Idempotent mutations.** Every mutation has a client-generated UUID. Replaying the same mutation is a no-op on the server.
- **Last-write-wins for now; upgrade path to CRDT later.** Don't build full Yjs/Automerge on day one — the complexity cost is huge. Start with LWW on per-field granularity (timestamp per field, server accepts newer). Document the known edge cases.
- **Explicit offline UX.** An online/offline indicator is always visible. A "pending sync" count shows how many local changes haven't reached the server. Clicking it shows what.

### 7.4 Implementation outline

**Client (shared web + Capacitor):**

- IndexedDB via `idb` or `Dexie` mirrors the subset of server state we care about: trips the user is a member of, their days, places, reservations, journals, photos (thumbnails + refs), expenses.
- On native, large files (photo originals, offline bundles) go to `@capacitor/filesystem` rather than IndexedDB.
- A **mutation queue** in IndexedDB: `{ id, endpoint, method, payload, created_at, attempts, last_error }`.
- On every write, the app:
  1. Generates a mutation UUID.
  2. Applies the mutation optimistically to the local store.
  3. Enqueues it.
  4. If online, the queue processor POSTs it; on success, removes from queue and reconciles any server-returned canonical state.
- A **sync worker** (in-page + Background Sync API on web; `@capacitor/app` resume hook on native) retries queued mutations with exponential backoff and a max attempt count.
- WebSocket messages drive real-time sync when online; when a WS message arrives for a record we have an unsent mutation on, flag potential conflict.

**Server:**

- Every mutation endpoint accepts an optional `client_mutation_id` header. Store seen IDs for 30 days; reject duplicates idempotently (return the already-stored result).
- Add `updated_at` per record (most tables have this already) and `updated_by`.
- Conflict endpoint: `GET /api/conflicts` returns records where the user has an unsynced local change and the server has moved on. Client shows a resolve-UI.

**Service worker (web) and Capacitor runtime (native):**

- Extend current Workbox config to background-sync POST/PUT/DELETE to our mutation endpoints.
- On native, use Capacitor's App lifecycle to trigger sync on resume.
- Ensure all data the user might want offline is pre-cached when they open a trip ("download for offline" button per trip to give explicit control over storage).

### 7.5 What each feature must respect

Every Milestone from 2 onwards must:

- Write through the mutation queue, not directly to `fetch()`.
- Read from the local store, not directly from the server.
- Handle the record-not-yet-synced case in UI (e.g. photo uploads pending while on a plane).
- Degrade gracefully — if a feature genuinely can't work offline (e.g. live geocoding search), show why and defer.

### 7.6 Features with offline-aware design notes

- **Photo uploads in journals.** Native: store in filesystem, queue upload. Web: store blob in IndexedDB, warn on quota.
- **Place search.** Requires network. Cache recent searches; show cached results offline with a "stale" badge.
- **Map tiles.** Workbox already caches viewed tiles. When creating a trip, prompt "download map area for offline?" for the trip's bounding box.
- **Weather.** Cache the last-fetched forecast per location; show staleness.

---

## 8. JSON export and import

### 8.1 Why this matters

Three use cases drive this:

1. **Archival** — every completed trip should be exportable to a self-contained file we can store in personal cloud storage, independent of 460 Trip Planner's future.
2. **Offline review** — a downloaded bundle is our insurance for "what if the server is unreachable for the whole trip?"
3. **Portability** — ability to import into a future version or a different instance (e.g. migrating servers).

### 8.2 Format specification

- **Versioned.** Top-level `{ "schema_version": "1.0", "app": "460-trip-planner", "exported_at": "...", "exported_by": "...", "trip": { ... } }`. Every future change bumps the version.
- **Self-contained where possible.** Include denormalised copies of referenced data (user names, category names) as strings, not just IDs — so a 2035 reader still makes sense even if other records are gone.
- **Two modes:**
  - *JSON-only* — a single `.json` file. Attachments referenced by URL or stubbed.
  - *Bundle* — a `.zip` containing `trip.json` plus an `attachments/` directory with photos, PDFs, etc. Filenames in JSON reference bundle paths.
- **Scope options:**
  - Single trip (default).
  - Multiple trips.
  - Full account (all trips + packing templates + settings).

### 8.3 What exports include

- Trip metadata, members (name + email, not passwords/tokens).
- Days with all journal content and photo references.
- Places with pins, notes, opening hours cached at export time.
- Reservations with all attached documents.
- Expenses and splits (include a computed settle-up snapshot at export time).
- Packing list state.
- Segments the trip is part of (with other-trip references marked as external).
- Schema-versioned so older exports remain readable.

### 8.4 Import behaviour

- **Always validate before applying.** JSON schema check first, then a dry-run report ("will create 1 trip, 14 days, 87 places, 23 reservations; 3 photos cannot be decoded and will be skipped").
- **Merge strategy options:**
  - *New trip* — always create fresh records with new IDs (safe default).
  - *Restore* — match by UUID if present; update in place. Requires confirmation.
- **Never silently overwrite.** If import would modify an existing record, list it and ask.
- **Segments on import** are imported as standalone — linking them back to other trips is a manual step.

### 8.5 Offline bundle viewer

Build a tiny standalone HTML viewer as part of this milestone: a single-file HTML + embedded JS that can open a bundle on any computer and render the trip read-only, without any server. This is the ultimate offline insurance — even if the whole 460 Trip Planner ecosystem disappears, the bundle remains human-readable via the viewer.

### 8.6 Pre-trip offline prep workflow

Document a checklist in `docs/ours-offline-prep.md`:

1. Open trip on all devices while online.
2. Tap "Download for offline" per trip (caches all data + map tiles).
3. Export trip as bundle, save a copy to phone local storage and to personal cloud.
4. Verify the offline viewer opens the bundle on at least one device.

---

## 9. Coding conventions

### 9.1 TypeScript

- Strict mode on. No `any` without a comment explaining why.
- Prefer `unknown` + narrowing over `any`.
- Explicit return types on exported functions.

### 9.2 Backend

- One endpoint = one file where reasonable.
- Thin controllers, fat services. Business logic lives in a service module, not in route handlers.
- All mutation endpoints accept `client_mutation_id` header (see §7.4).
- All new tables include `id` (UUID), `created_at`, `updated_at`, `created_by`, `updated_by`.
- Migrations are forward-only. No destructive migrations without backup prompt.

### 9.3 Frontend

- Zustand slices stay small. One slice per bounded concept.
- Components read from Zustand, not directly from fetch.
- No direct `fetch()` or axios calls from components — go through the data layer that handles the mutation queue.
- Tailwind for styling. No ad-hoc CSS files unless upstream already has one for that component.
- Platform-specific code (e.g. Capacitor plugin calls) lives behind a thin abstraction so tests can mock it and web builds still work.

### 9.4 Naming

- Database: snake_case.
- TypeScript: camelCase for variables/functions, PascalCase for types/components.
- Files: kebab-case.

### 9.5 Accessibility and mobile

- Every new interactive element needs keyboard focus handling and an accessible name.
- Test any new UI at mobile width (375px minimum) on an actual phone before declaring done.
- Respect safe areas (notches, home indicators) — Capacitor provides these as CSS env vars.
- Touch targets minimum 44×44 px.

### 9.6 Internationalisation

Upstream supports English and German. Keep our new strings in the i18n system even if we only translate English — don't hardcode strings in components.

### 9.7 Secrets and config

- Never hardcode API keys. They live in the admin panel settings (encrypted at rest via `ENCRYPTION_KEY`).
- Signing certs, provisioning profiles, and keystores must NEVER be committed. Keep them in a password manager / secrets vault and reference by path in build scripts.
- `.env.example` stays in sync with any new env vars.

---

## 10. Commands cheatsheet

> Update this section as the project evolves. Verify upstream commands on first use — they may have changed.

### Web dev

```bash
# Install
cd client && npm install
cd ../server && npm install

# Dev mode (run both in separate terminals)
cd server && npm run dev
cd client && npm run dev

# Lint / typecheck / test
npm run lint
npm run typecheck
npm test
```

### Capacitor

```bash
# First-time setup (after installing @capacitor/core, cli, ios, android)
npx cap init "460 Trip Planner" com.fourhundredsixty.tripplanner
npx cap add ios
npx cap add android

# After a web build, copy to native
npm run build --workspace=client
npx cap copy
npx cap sync   # copy + update plugins

# Open in native IDE
npx cap open ios       # Xcode
npx cap open android   # Android Studio

# Live reload on device (dev only)
npx cap run ios --livereload --external
npx cap run android --livereload --external
```

### Database

```bash
# SQLite file at ./data/travel.db
sqlite3 ./data/travel.db
# Migrations run automatically at server start
```

### Docker (server)

```bash
docker build -t trek-460 .
docker compose up -d
docker pull mauriceboe/nomad      # baseline comparison
docker inspect trek --format '{{json .Mounts}}'
```

### Git / upstream

```bash
# One-time
git remote add upstream https://github.com/mauriceboe/TREK.git

# Sync main with upstream
git checkout main
git fetch upstream
git merge upstream/main
git push origin main

# Rebase personal onto updated main
git checkout personal
git rebase main
# Resolve conflicts, then:
git push --force-with-lease origin personal
```

---

## 11. Session starter prompts

Useful first-messages when beginning a new Claude Code session. Paste one, adjust as needed.

### First session

> Read CLAUDE.md. Then produce docs/ours-architecture-map.md per §5.3. Don't change any code yet.

### Starting a new milestone

> We're starting Milestone N from CLAUDE.md §6. Read the relevant existing code, then produce a short plan: files to touch, schema changes, API endpoints, UI components, tests. Include open questions. Don't write code until I approve the plan.

### Capacitor setup session (Milestone 1)

> We're doing Milestone 1 from CLAUDE.md §6. Walk me through the steps to brand as 460 Trip Planner and add Capacitor wrappers, one small commit at a time. Pause between each so I can verify it builds.

### Resuming mid-feature

> We're continuing Milestone N on branch `feat/...`. Read the branch diff against `personal`. Summarise what's done and what's left. Then tell me what you'd tackle next and why.

### Before a rebase on upstream

> Upstream has new commits since we last synced. Fetch, summarise the interesting changes, and flag any that might conflict with our work on `personal`. Don't merge or rebase yet.

### Post-trip review

> I just returned from a trip and used 460 Trip Planner end-to-end. Here are the pain points I noticed: [...]. For each, suggest whether it's a bug, a small UX fix, a new feature, or a deferred item. Don't start coding.

---

## 12. Notes for future-me

- **AGPL-3.0 licence:** if we ever let non-household people use our instance over a network, we must publish our source modifications. Keep the fork public on GitHub from day one to avoid accidentally tripping this later.
- **Upstream is alive.** The author accepts contributions and ships regular releases. Good PRs back upstream reduce our maintenance tax.
- **Apple Developer account renewal is annual** — set a calendar reminder. If it lapses, TestFlight builds stop working.
- **Offline-first is the hardest engineering in this project.** Budget 2–3x whatever the initial estimate is. Ship a minimal version and expand.
- **Capacitor native wrappers need re-signing on cert renewal.** Document the signing process in `docs/ours-build-native.md` so future-me isn't debugging it under pressure the week before a trip.
- **Don't let scope creep.** The Tier 3 / out-of-scope list in §6 is there for a reason. Revisit after every milestone, but don't quietly expand it.
