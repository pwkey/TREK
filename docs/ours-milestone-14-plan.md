# Milestone 14 — Data-saver / metered-connection mode

**Problem.** Most of the 2026 Europe trip runs on a **data-only eSIM** with a
finite allowance. Today the app will happily push/pull large blobs (journal
photos, offline downloads, export bundles, backup restores) without warning or
restraint. We need the app to be conscious of data usage: warn before anything
data-heavy, and default to deferring those operations until wifi.

Requested by Peter, 2026-06-04. Sits on top of the M5 offline-first write queue
(§7) and the M6 journal-photo flow.

---

## The hard platform constraint (read first)

**On iPhone we cannot auto-detect wifi vs cellular.** The Network Information
API (`navigator.connection`, `effectiveType`, `saveData`, `type`) is
**Chromium-only** — Safari (iOS *and* macOS) does not implement it. Our travel
devices are iPhones running the installed PWA, so the app literally cannot know
it's on the eSIM.

Consequence: "**only operate on wifi**" cannot be *auto-enforced* on iOS. The
load-bearing mechanism must be a **manual Data-saver toggle** the app respects,
backed by **explicit size warnings**. The Network API is used only as a *bonus
auto-suggestion* where it exists (Android / desktop Chrome).

Good news — the biggest lever already exists: journal photos are **downscaled
client-side before upload** (`client/src/lib/imageProcessing.ts`: resize +
JPEG re-encode). We are not shipping full-res originals over the eSIM today.

---

## Decisions (Peter, 2026-06-04)

v1 includes all four pieces:
1. **Manual Data-saver toggle** — per-device, persisted; the primary control.
2. **Size-aware confirmations** before heavy ops (upload / offline download /
   export bundle / backup restore-upload).
3. **Hold auto photo-upload** while Data-saver is on — queue, show a "waiting
   for wifi" chip with a manual "upload now" override.
4. **Auto-suggest** the toggle via the Network API where supported
   (Android / desktop only; a no-op on iOS).

---

## Heavy operations in scope (from code survey)

| Operation | Where | Direction | Notes |
|---|---|---|---|
| Journal photo upload | `Journal/PhotoGrid.tsx`, `Journal/BatchPhotoImport.tsx` → `dayPhotosSlice` | up | biggest + most frequent; already downscaled |
| "Download for offline" (trip prefetch) | M5 offline cache prime | down | photos + tiles |
| Export bundle / Archive | `Planner/DayPlanSidebar.tsx` archive button → `/export/bundle` | down | zip incl. photo binaries |
| Backup restore / upload-restore | `Admin/BackupPanel.tsx` → `/api/backup/*` | up/down | whole-DB + uploads zip; admin only |
| Original-photo viewing | `Journal/PhotoImg.tsx`, `MemoirView.tsx` | down | thumbnails-only in data-saver, tap-to-load original |
| Live map tiles | `Map/MapView.tsx` (Workbox cache) | down | **out of scope** — gating live tiles breaks the map; only gate explicit "download area" |

---

## Design

### Connection abstraction (extend, don't fork)
Extend the existing `client/src/hooks/useOnlineStatus.ts` into a
`useConnection()` returning `{ online, dataSaver, metered, saveDataHint }`:
- `online` — unchanged (`navigator.onLine` + events).
- `dataSaver` — the manual toggle (source of truth).
- `saveDataHint` / `metered` — `navigator.connection?.saveData` /
  `connection?.type === 'cellular'` where present; always `false`/`undefined`
  on iOS. Used only to *suggest* enabling `dataSaver`.

Per §9.3, all platform-specific reads live behind this one hook so tests can
mock it and behaviour is consistent across iOS Safari / Android / desktop.

### The setting (per-device, not per-user)
Data-saver is a property of *this device on this network*, not of the account —
Clare's phone and Peter's laptop want independent state. Persist in
`localStorage` via a dedicated tiny Zustand store (`dataSaverStore`, NOT the
server-synced `settingsStore`). **No server schema change.**

**Default: `auto`** (Peter, 2026-06-04) — Data-saver engages automatically while
today is within one of your trips' date ranges (and, on Android/desktop, when
the browser reports a metered/save-data connection). Modes: `auto` / `on` /
`off`. A navbar chip is shown whenever it's effectively active so it's never
silently throttling.

### Size estimation + the confirm dialog
A reusable `<DataCostConfirm>` (or a `confirmDataCost()` promise helper) that
shows estimated bytes and, when `dataSaver` is on, defaults the action to
"Wait for wifi":
- Photos: sum of (post-downscale) blob sizes already in hand before upload.
- Offline download / export bundle: ask the server for a size estimate
  (lightweight `HEAD`/`?estimate=1`) or sum known photo/file sizes.
- Restore: the uploaded zip's own size.

### Hold auto-upload until wifi
The M5 queue already persists photo mutations offline. Add a `dataSaver` gate
to the queue *flush*: when on, queued photo uploads are **held** (not flushed)
even though we're "online". Surface a "**N photos waiting for wifi**" chip
(near the existing pending-sync indicator) with an "**Upload now**" override
that flushes once regardless. Non-photo mutations (text, ticks) are tiny and
flush normally.

---

## Slices (each shippable + usable on its own)

### Slice 1 — foundation ✅ shipped
`dataSaverStore` (per-device, localStorage; `auto`/`on`/`off`) + `useDataSaverActive()`
+ `saveDataHint()` + pure `computeDataSaverActive()` (unit-tested). Navbar
`DataSaverIndicator` chip (shown only when active). 3-way control in Settings →
Display. `refreshActiveTrip()` wired into app boot. i18n in en + de (others fall
back to en). No behaviour change yet beyond the indicator + setting.

### Slice 2 — size-aware confirmations ✅ shipped
`confirmDataCost()` (promise-based) + `<DataCostConfirmHost>` at the app root +
pure, unit-tested `shouldWarnDataCost()` / `formatBytes()`. Thresholds: warn
≥1 MB on a metered/Data-saver link, ≥25 MB otherwise; inherently-large ops
(offline download, export bundle) always warn when active. Wired into: photo
upload (PhotoGrid + BatchPhotoImport, sums file sizes), offline download,
export bundle, and backup upload-restore (file size). When active the dialog's
emphasised button is "Wait for Wi-Fi"; otherwise "Continue". Logic split into a
React-free `dataCostConfirm.ts` so it loads under the node test env. i18n en+de.

### Slice 3 — hold auto-upload ✅ shipped
NOTE: photos do NOT ride the M5 JSON mutation queue (uploads are multipart), so
this is a NEW durable IndexedDB hold-queue (`photoUploadQueue.ts`, localDb store
v2→v3), not a flush-gate on the existing queue. The downscaled JPEG blob is
stashed and replayed later. Slice-2's "Wait for Wi-Fi" now defers (was: discard).
"N photos waiting for Wi-Fi" navbar chip + "upload now"; auto-flush when online
and not metered (boot, reconnect, Data-saver off). Tests: queue persistence.

### Slice 4 — defer downloads ✅ shipped (scope adjusted)
Photo DOWNLOADS are deferred while Data-saver is active: `PhotoImg` shows a
tap-to-load placeholder instead of auto-fetching, so browsing the memoir/grids
doesn't silently pull megabytes; turning Data-saver off loads them. i18n en+de.

Scope notes:
- *Thumbnails-only* — **now shipped (2.9.18)**, see "Slice 5" below. (Originally
  deferred here; built afterwards on request.)
- *Network-API auto-suggest*: already delivered by `auto` mode — `saveDataHint()`
  (navigator.connection saveData/cellular, Android/desktop only) auto-engages
  Data-saver. A separate nag-toast for the manual `off` override was deliberately
  skipped (respects the user's explicit choice; iOS can't detect anyway).

---

### Slice 5 — server-generated thumbnails ✅ shipped (2.9.18)

Real small thumbnails, so browsing is cheap even on a metered link.

- **Dependency:** `sharp` ^0.33 added to the **server** (already proven in the
  Docker image — the client uses it for PWA icons; sharp 0.33 bundles libvips).
- **Generation:** on day-photo upload, a 400px-longest-edge JPEG (q70, EXIF
  auto-rotated) is written to `uploads/files/thumbs/<uuid>.jpg`
  (`imageThumbs.generateThumbnail`, best-effort — failure is logged, never
  blocks the upload). Lives in the same volume → backed up with everything else.
- **Serving:** the existing download route honours `?thumb=1`, serving the
  thumbnail when present and **falling back to the original** otherwise — so old
  photos, non-image files, and any generation failure just work. **No DB column,
  no migration** (thumb path derived 1:1 from the filename).
- **Cleanup:** thumbnails are removed on photo delete, permanent file delete,
  and empty-trash.
- **Client:** `PhotoImg` gains `variant` — grids/memoir request `thumb` (tiny,
  always loads even on Data-saver); the lightbox uses `full` (still tap-to-load
  on Data-saver from Slice 4).
- **Tests:** DAYPHOTO-THUMB-1/2/3 (generate+serve, fallback, delete-cleanup).

Deferred follow-up: no backfill of pre-existing photos — they serve the
original via fallback until re-uploaded. A one-off backfill script could
generate thumbs for old photos if it ever matters.

## Open questions (resolve before / during build)
- ~~**Default state**~~ — **Resolved (2026-06-04): `auto`** = on during a trip's
  date range; off otherwise.
- **iOS indicator** — since we can't detect, show a persistent "Assuming
  cellular — Data-saver ON" chip so it's never silently throttling? (Lean yes.)
- **Estimate source** for offline download / export — server `?estimate=1` vs
  client-side sum. (Lean server estimate; one cheap endpoint.)
- **Map "download area"** — in scope for a size warning if/when that feature
  lands; live tile browsing stays ungated.

## Deferred
- Auto-flush-on-wifi *without* foregrounding (needs Background Sync — not on iOS
  Safari; §7.2). The contract stays "open the app on wifi and it uploads".
- Granular per-operation data budgets / usage metering dashboard.
- Video capture/upload (not a journal feature yet).

## Upstream / merge notes
Mostly additive and behind our `[460-fork]` surfaces: new hook, new device
setting, a confirm helper, a queue-flush gate. Touches a few upstream-adjacent
components (photo grid, backup panel, export button) only to wrap existing
actions in a confirm — low merge risk. Likely **upstreamable** (every metered
traveller wants this); keep copy neutral.
