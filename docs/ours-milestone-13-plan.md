# Milestone 13 — Segment document-sharing protocol + per-household journals

**Status:** approved 2026-06-02, in build.
**Drives from:** the segment-sharing audit (2026-06-02). Before Peter builds
the real 3-month trip and shares segments with another household, the
document-sharing behaviour has to be deliberate and safe. The audit found the
default is already private — but there's no way to *deliberately* share a
genuinely-joint booking, and journals/photos on shared days are currently one
shared set rather than per-household.

---

## What the audit established (verified in code 2026-06-02)

A shared segment has one **"home" trip** (`trip_segments.is_home=1`) that owns
the canonical day rows. Sibling trips read those days via the `days.segment_id`
UNION in `dayService.listDays` — they don't get copies.

| Data | Today | Decision |
|---|---|---|
| Itinerary/plan on shared days (`day_assignments` → `places`) | Shared | ✅ keep shared |
| Bookings (`reservations`) | Strictly trip-private (`WHERE r.trip_id=?`) | Private **+ opt-in share** |
| Documents (`trip_files`) | Strictly trip-private (`WHERE f.trip_id=?`, download gated on `id+trip_id`) | Private **+ opt-in share** |
| Journals (`day_journals`) / Photos (`day_photos`) | Shared (keyed by `day_id`) | **Per-household** |

**There is no cross-household leak today.** This milestone *adds* sharing on
top of a safe default; it does not plug a hole.

## Decisions (Peter, 2026-06-02)

- **Opt-in, not automatic.** A booking/file is private until its owner shares it.
- **Co-editable.** Once shared, the other household can **edit** the booking's
  fields too (not just view). → needs write-auth widening + the M5 conflict
  path; `reservations` gets `updated_at`/`updated_by` (it has neither today).
- **PDF rides along.** Sharing a booking shares its attached document(s).
- **Standalone files shareable too**, not only booking-attached ones.
- **Owner-only for delete + un-share.** The other household can edit fields but
  cannot delete the record or revoke the share (it lives in the owner's trip).
- **File bytes aren't co-edited.** "Edit" means booking fields; for a shared
  file the owner manages the record, both households view/download.

---

## Data model (additive)

Two junction tables — no shape change to `reservations`/`trip_files` beyond the
conflict columns:

```sql
CREATE TABLE segment_shared_reservations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  segment_id TEXT NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
  reservation_id INTEGER NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
  shared_by INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(segment_id, reservation_id)
);
CREATE TABLE segment_shared_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  segment_id TEXT NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
  file_id INTEGER NOT NULL REFERENCES trip_files(id) ON DELETE CASCADE,
  shared_by INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(segment_id, file_id)
);
-- reservations gains the M5 conflict-precondition columns (days already has these):
ALTER TABLE reservations ADD COLUMN updated_at DATETIME;  -- backfilled to now
ALTER TABLE reservations ADD COLUMN updated_by INTEGER REFERENCES users(id);
```

Idempotency is free: the global `X-Client-Mutation-Id` middleware
(`middleware/idempotency.ts`, chained after `authenticate`) caches share/un-share
responses, and `UNIQUE(segment_id, …)` guards duplicate inserts. No per-row
`client_mutation_id` column needed.

---

## Slices

### Slice 1 — schema + share/un-share endpoints + tests *(no exposure yet)*
- Migrations: the two junctions + `reservations.updated_at`/`updated_by`
  (backfill `updated_at` to now, following the `days.updated_at` M5 pattern).
  Mirror the junctions into `schema.ts` `createTables` (consistent with how M4
  segment tables live in both). Add the new tables to `RESET_TABLES`.
- New `segmentShareService.ts`: `isTripInSegment`, `shareReservation`,
  `unshareReservation`, `shareFile`, `unshareFile`.
- Endpoints (owner-only = reservation/file must belong to `:tripId`, plus
  `reservation_edit`/`file_edit` permission, plus `:tripId` linked to the segment):
  - `POST   /api/trips/:tripId/reservations/:id/share`  `{ segment_id }`
  - `DELETE /api/trips/:tripId/reservations/:id/share`  `{ segment_id }`
  - `POST   /api/trips/:tripId/files/:id/share`          `{ segment_id }`
  - `DELETE /api/trips/:tripId/files/:id/share`          `{ segment_id }`
- Nothing reads the junctions yet → no cross-household exposure until slice 2.
- Tests: share/un-share round-trip; trip-not-in-segment → rejected; non-member
  → 403/404; repeated `X-Client-Mutation-Id` is idempotent.

### Slice 2 — read/write widening + leak guards
- `listReservations`: also return reservations shared into segments this trip is
  linked to, tagged `shared_into_segment` / `owned_by_this_trip`.
- `listFiles` + file **download** auth: a file is visible if shared directly
  (`segment_shared_files`) **or** attached to a shared reservation. New
  `canAccessSharedFile(fileId, requestingTripId)`; precise — nothing else widens.
- Reservation **edit/delete** auth: allowed if you own the reservation's trip OR
  it's shared into a segment your trip is linked to (delete stays owner-only).
  Co-edits route through the M5 `parkAsConflict` precondition; stamp `updated_at`
  on every update.
- **Leak-guard tests (the important ones):** sibling can see/edit/download a
  *shared* booking + its PDF; **cannot** see/edit/download a *non-shared* one.
- Recommend a `/security-review` pass before merge (widens write auth across
  household boundaries + touches upstream-core reservation/file routes).

### Slice 3 — UI
- "Share with [segment]" toggle on a booking (when its dates fall in a shared
  segment) and on standalone files; "Shared with [household]" badge in both
  trips; shared-in items editable by both; mutations go through the offline queue.
- i18n strings, mobile width (375px), 44px touch targets.

### Slice 4 — per-household journals & photos *(separate, after documents)*
- Add a trip/household discriminator to `day_journals`/`day_photos` so each
  household keeps its own on a shared day, while the plan stays shared
  (precedent: `day_notes` is already trip-scoped per day). No per-household day
  rows needed. Migrate existing shared journals/photos to the home trip.

---

## Open questions (resolve as we hit them)
- **M12 export interaction:** when a shared booking is owned by household A, how
  does it appear in B's export bundle? Lean: a read-only denormalised copy marked
  `shared_from`, not a claim of ownership.
- **Un-share with pending co-edits:** if B has queued offline edits to a booking
  A then un-shares, B's queued mutation should fail closed (404) and surface,
  not silently vanish.
- **WebSocket fan-out:** share/edit events currently broadcast to one trip;
  shared records need to notify the *other* household's trip too (slice 2/3).

## Deferred
- Sharing places, expenses, or whole days as documents (out of scope).
- Granular per-field edit permissions on shared bookings (co-edit is all-or-nothing).
