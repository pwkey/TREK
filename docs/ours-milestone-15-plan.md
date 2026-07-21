# Milestone 15 — Merge import ("patch" an existing trip)

## Problem

Today the only way to get externally-generated detail into the app is
`applyImport`, which **always creates a brand-new trip**. That was perfect for
standing Europe 2026 up from `build_trip.py`, but it's useless once a trip is
live: you can't add detail to it without recreating it and losing journals,
photos and any edits made in the app.

**Goal:** import a file that *adds detail into an existing trip*, scoped to the
days the file covers, without destroying anything already there — and safe to
re-run as the generated file is iterated on.

## Decisions (agreed 2026-06-28)

| Decision | Choice |
|---|---|
| Merge rule | **Add-only** — never delete or overwrite existing content |
| Re-import | **Update in place** via a stable `external_ref` on each generated item |
| Scope | **Everything**: day titles/notes, places + assignments, reservations, accommodations, budget items, to-dos |
| Day notes | **Append as a keyed block** (see below), not fill-if-empty |
| Journals & photos | **Never touched** — they're live user content |

### Matching

- **Trip:** chosen by the user in the import dialog (the file does not name it).
- **Days:** matched by **`date`**. Dates are the only stable key across a live
  trip (ids get re-mapped, day numbers shift when days are inserted).
- A date in the file that isn't in the trip is **warned and skipped** — never
  auto-created. Extending a trip stays a deliberate, separate action.
- Only dates present in the file are touched. A file covering 16–30 Sep affects
  the Spain leg and nothing else — that's how "certain days" is expressed.

### Day title and notes

- **Title:** set only if the trip's day has none. A title can't meaningfully
  append, and silently replacing one you wrote would be a data loss.
- **Notes:** appended as a **keyed block**, so re-import updates rather than
  duplicates:

  ```
  (whatever you wrote yourself — never touched)

  <!-- 460-import: <patch-key> -->
  …imported detail…
  <!-- /460-import -->
  ```

  On re-import with the same `<patch-key>`, the block is **replaced in place**.
  Text outside the block is left alone.

### Idempotency

Generated items carry `external_ref` (e.g. `eu2026:place:alhambra`). On import:

- ref matches an existing row in this trip → **update it**
- ref doesn't match, but the row is already here under its **natural key** →
  **adopt it**: update in place and stamp the ref (see below)
- no match at all → **insert**, stamping the ref
- no ref at all → insert, with a light dedupe fallback (place name; reservation
  confirmation number; stay place+dates) so a hand-made file can't trivially
  double up

**Adoption** matters because the *first* patch into a trip always lands on rows
that were created by the create-new import, and those carry no ref. Without it,
patching Europe 2026 would have inserted a second Intrepid tour booking, a
second Moroccan House, and a second stay. Covered by `MERGE-010`.

**Adoption only fires on a UNIQUE natural-key match.** A confirmation number is
not a unique key in practice: one airline booking reference covers every leg, so
Europe 2026 has six reservations sharing `MRVMY2`. Taking the first match would
have retitled *EK413 Sydney → Dubai* as *EK751 Dubai → Casablanca* and stamped
someone else's ref on it — silent corruption of a correct booking. When the key
matches more than one row the item is **warned and skipped**, never guessed.
Same guard on places, stays, budget items and to-dos. Covered by `MERGE-011`.

Refs are scoped per trip, so two trips can reuse the same key space.

## Schema

One forward-only migration, appended to the `migrations` array in
`db/migrations.ts` (schema version = array length, so it bumps automatically):

- `external_ref TEXT` (nullable) on `places`, `reservations`,
  `day_accommodations`, `budget_items`, `todo_items`
- `CREATE UNIQUE INDEX … ON <table>(trip_id, external_ref) WHERE external_ref IS NOT NULL`

Additive and nullable — existing rows and the create-new import path are
unaffected.

## Server

- New `services/importMergeService.ts` — `dryRunMerge(input, tripId)` and
  `applyMerge(input, tripId, importerId)`. `applyImport` (create-new) is left
  completely alone.
- **Report is a per-day diff**, not just counts:
  `18 Sep: +3 places, 1 reservation updated, title unchanged`
  plus warnings (dates not in trip, skipped duplicates).
- `POST /api/trips/:id/import` — dry-run by default, `?dry_run=false` applies.
  Permission-checked to trip editors; wrapped in one transaction.

## Client

`ImportTripDialog` gains a target choice — **Create new trip** (today's
behaviour) or **Add to existing trip** → trip picker — and renders the per-day
diff in the preview step before you confirm.

## Generator

`build_trip.py` gains a patch mode: emit only the chosen dates, stamping
deterministic `external_ref`s and a `patch-key` for the notes block.

## Tests

Integration, in the existing `IMPORT-0xx` style:

- merges only into matched days; unmatched dates warned + skipped
- add-only: existing title, notes and places survive untouched
- notes block appended once; re-import replaces it (no duplication)
- re-import of the same file creates no duplicate places/reservations
- journals and photos untouched
- a non-editor is rejected

## Slices

1. ✅ **Shipped** — migration + merge engine (days/places/assignments) +
   dry-run diff + `?mode=merge` endpoint + `MERGE-001..005`
2. ✅ **Shipped** — reservations, accommodations, budget items, to-dos +
   `MERGE-006..008`. Accommodations anchor to `start_date`/`end_date` (day ids
   from another trip aren't trustworthy); a stay whose dates aren't in the trip
   is warned and skipped.
3. ✅ **Shipped** — client UI: an "Import into: a new trip / an existing trip"
   picker in `ImportTripDialog`, with a day-by-day diff preview before confirm.
4. ✅ **Shipped** — `build_trip.py --patch <start> <end> --key <name>` emits
   `patch-<key>.json` (deterministic `external_ref`s, stays anchored to dates,
   `type:'hotel'` reservations skipped since the stay carries them), plus a
   user-guide section. `MERGE-009` locks the `place_ref` assignment shape the
   generator emits.

   **To-dos (added 2026-07-20).** To-dos have no natural date, so a `TODO` entry
   only reaches a patch if it carries an explicit `"date"` inside the window.
   Undated ones are trip-wide, already arrived with the full build, and are
   *counted and reported* rather than silently dropped — emitting them on every
   patch would drag the Spain actions into a Morocco import.

**Milestone complete.** Loop: edit `build_trip.py` → emit a patch for the
affected dates → import it into the existing trip → nothing lost, no duplicates.

All of it is `[460-fork]` additive on our own import feature — no upstream
merge risk.
