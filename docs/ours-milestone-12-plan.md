# Milestone 12 — Clean companion off-boarding (faithful trip export/import)

**Status:** draft, pending approval.
**Drives from:** the custody conversation (2026-06-01). 460TP is single-instance:
to share a segment, a companion's *entire* trip lives on the host's server,
in the host's backups, at the host's cost. We accept that custody — but no
companion should ever be *trapped*. They must be able to leave with a
**complete, faithful** copy of their own trips.

---

## The problem precisely

The **auto-backup → Dropbox** chain already protects everyone's data on the
instance (whole-DB snapshot). That is NOT what this milestone is about.

This milestone is about the **per-trip Archive bundle** as an *off-boarding*
artefact: when a companion wants to take their trip and go, the bundle they
export must round-trip back into a working trip on *another* instance with
nothing important silently dropped.

### What already works (verified in code 2026-06-01)
- **Export** (`exportService.ts`) is in good shape. It already emits:
  - segments the trip belongs to (id, title, dates) + `external_trip_refs`
  - each day's `segment_id`
  - because a sibling trip's `listDays` does a UNION read, a departing
    companion's export **already includes the shared segment days and all
    their content** (places, journals, photos, assignments).
  - bundle format ships photo + reservation-file binaries.
- So a re-imported bundle today already restores ~80%: trip, days, places,
  assignments, journals, photos (with binaries), reservations (headers),
  budget (headers), packing, todo, accommodations.

### What import silently drops (`importService.ts` "Deferred" list)
1. **Segments** — the day rows come back, but the "these days were a shared
   segment" structure is lost. Days import as ordinary trip-local days.
2. **Reservation ↔ attached-file links** — the reservation header imports,
   but its attached booking PDF (present in the bundle) isn't re-linked.
3. **Budget per-member splits + paid status** — only budget headers import.
4. **Members / collaborators** — importer becomes sole owner (correct for a
   cross-instance move; a companion leaving wants their *own* copy anyway).
5. **notes_items** (per-day structured notes), **collab notes/chat/polls**.

For clean off-boarding, the priority order is: **(1) segments** is the big
one (it's the whole reason companions are on the instance), then **(2)
reservation files** and **(3) budget splits**. Items 4 + 5 are lower value
for a personal-copy use case.

---

## Goal & acceptance

A companion exports a **bundle** of a trip that includes shared segments.
Re-imported on a *fresh* instance (or the same one), the result is a trip
where:
- the segment days are recreated AND re-associated into a segment record
  (so the structure, not just the content, survives);
- reservation-attached files are back on disk and re-linked to their
  reservations;
- budget items carry their per-person splits and paid flags;
- nothing throws; a mid-flight failure rolls back cleanly (existing
  transaction guarantee preserved).

Out of scope (explicitly): re-federating the segment back to the OTHER
households' trips (they're on different instances / `external_trip_refs` are
placeholders). On import the segment becomes **standalone** — owned by the
importer, linked only to the imported trip. That matches CLAUDE.md §8.4.

---

## Design

### Schema
No new tables. Reuses `segments`, `trip_segments`, `days.segment_id`,
`budget_item_members`, `trip_files.reservation_id`.

### Export changes (small — mostly already done)
- Add per-day `notes_items` already emitted; confirm assignments include
  `place_time`/`end_date` (times) — audit during slice 1.
- Add `budget_item_members` to each exported budget item (currently header
  only). Denormalise member identity to **name + email** (not just user_id)
  so splits survive a cross-instance move where user ids differ.
- Add `reservation_id` linkage hints to bundle file entries (the bundle
  already ships reservation files under `attachments/files/<id>-<name>`; the
  envelope needs to record which reservation each maps to).

### Import changes (the bulk of the work)
1. **Segments.** After days are inserted (existing step 3), build a
   `segmentIdMap`. For each exported segment: insert a fresh `segments` row
   (new UUID, `created_by = importer`), insert one `trip_segments` row
   linking it to the new trip as `is_home = 1`, then `UPDATE days SET
   segment_id = <new>` for every imported day whose source `segment_id`
   matched. `external_trip_refs` are ignored (standalone import).
2. **Reservation files.** When importing reservations, keep a
   `reservationIdMap`. After writing each bundle file under
   `attachments/files/`, insert the `trip_files` row with the mapped
   `reservation_id` so the booking PDF re-links.
3. **Budget splits.** After inserting each budget item, insert its
   `budget_item_members` rows, resolving member identity by email against
   the importing instance's users; unmatched members import as
   name-only/free-text splits (no crash).
4. Update `DryRunReport.would_create` with `segments`, `reservation_files`,
   `budget_splits` counts so the pre-import preview is honest.

### Backward compatibility
Bundles exported by the current build (no `budget_item_members`, no
file-link hints) must still import — every new importer block guards on the
field being present. Older bundles just import the ~80% they always did.

---

## Slices

1. **Export completeness** — add budget_item_members (name+email denormalised)
   and reservation-file→reservation mapping to the envelope. Pure additive;
   existing importer ignores unknown fields. Tests: export a trip with
   splits + a reservation PDF, assert the envelope carries them.
2. **Import: segments** — recreate segment records + re-associate days on
   import. Tests: export a trip that's part of a segment, import it, assert a
   standalone segment exists, is_home=1, and the right days carry the new
   segment_id.
3. **Import: reservation files + budget splits** — re-link files, recreate
   splits with email resolution + free-text fallback. Tests for both, incl.
   the unmatched-member fallback.
4. **Dry-run report + UI counts** — surface the new counts in the import
   preview so the user sees "will restore 2 segments, 3 reservation files,
   5 budget splits". Small client change to the existing import preview.

Each slice independently shippable; 1 must precede 2–3 (they consume the new
envelope fields). All land behind the existing CI gate, watched green.

---

## Risk & why this is its own session
- **Data-integrity sensitive.** ID remapping across `segments`/
  `trip_segments`/`days`/`budget_item_members` is exactly the class of change
  that punishes haste. It deserves a fresh session with full attention and a
  CI run watched start-to-finish (per the 2026-06-01 lesson: don't stack
  commits without confirming each goes green).
- **Not a blocker for the flagship trip.** Off-boarding only matters when a
  companion eventually wants to *leave* — months away. Their data is already
  safe via auto-backup today.
- **Estimate:** ~4 slices, server-heavy, ~400–600 LOC + two integration test
  suites (export round-trip, import fidelity). Roughly a M11-sized effort.

---

## Design decisions (resolved 2026-06-01)
1. **Budget split member resolution: email-only.** Each split denormalises
   the member's email; on import we match by email against the importing
   instance's users. No match → import as a free-text / name-only split (no
   crash). Rationale: a *wrong* match silently corrupts settle-up math;
   username matching collides too easily across instances. Under-match
   beats mis-match.
2. **Segment dates on import: recompute** from the min/max `date` of the days
   actually imported into the segment (ignore the exported start/end).
   Self-correcting — the segment always spans exactly the days it contains,
   even if days drifted after export.
3. **Re-import behaviour: always fresh-create** a new trip + new standalone
   segment (new IDs). Documented as "import always creates a new copy."
   Re-importing on the same instance therefore produces a duplicate — an
   accepted mild annoyance, NOT a data risk (the whole-instance auto-backup
   is the proper same-server restore path). Restore-by-UUID stays the
   deferred M7.4 "Restore mode" with its own overwrite safety rails.

---

## Log
- **2026-06-01** — Plan drafted after the single-instance custody discussion.
  Decision: accept custody, make off-boarding clean. Build deferred pending
  go/no-go on starting now vs a fresh session.
