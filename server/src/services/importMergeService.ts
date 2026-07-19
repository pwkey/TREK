// [460-fork] Milestone 15 — merge import ("patch" an existing trip).
//
// applyImport() always creates a NEW trip. This merges a patch file INTO an
// existing trip instead, scoped to the dates the file carries — so detail can be
// added to a live trip without recreating it (and losing journals/photos/edits).
//
// Rules (docs/ours-milestone-15-plan.md):
//   - Days match by DATE. A date not in the trip is warned + skipped, never created.
//   - ADD-ONLY. Nothing existing is deleted or overwritten:
//       · day title — set only when the day has none (a title can't append)
//       · day notes — appended as a keyed block; re-import REPLACES that block
//   - Idempotent. Items carrying `external_ref` upsert by (trip_id, external_ref);
//     without a ref we fall back to matching a place by name so a hand-made file
//     can't trivially double up.
//   - Journals and photos are never touched.
//
// dryRunMerge() and applyMerge() share one code path (`mergeInto`) so the preview
// can never drift from what apply actually does.
import { db } from '../db/database';
import type { ImportInput } from './importService';

const NOTE_CLOSE = '<!-- /460-import -->';
const noteOpen = (key: string): string => `<!-- 460-import: ${key} -->`;

export interface MergeDayDiff {
  date: string;
  matched: boolean;
  title_set: boolean;
  notes_block: 'added' | 'replaced' | 'unchanged' | 'none';
  places_added: number;
  places_updated: number;
  assignments_added: number;
}

export interface MergeReport {
  trip_id: number;
  trip_title: string;
  patch_key: string;
  days: MergeDayDiff[];
  totals: {
    days_matched: number;
    days_skipped: number;
    places_added: number;
    places_updated: number;
    assignments_added: number;
    // [460-fork] M15 slice 2
    reservations_added: number;
    reservations_updated: number;
    accommodations_added: number;
    accommodations_updated: number;
    budget_items_added: number;
    budget_items_updated: number;
    todo_items_added: number;
    todo_items_updated: number;
    duplicates_skipped: number;
  };
  warnings: string[];
  errors: string[];
}

interface PatchPlace {
  id?: number;
  external_ref?: string | null;
  name?: string;
  description?: string | null;
  lat?: number | null;
  lng?: number | null;
  address?: string | null;
  notes?: string | null;
}

interface PatchDay {
  date?: string | null;
  title?: string | null;
  notes?: string | null;
  assignments?: Array<{ place?: { id?: number } | null; place_ref?: string | null }>;
}

// [460-fork] M15 slice 2 — the rest of the entity scope.
interface PatchReservation {
  external_ref?: string | null;
  title?: string;
  type?: string | null;
  reservation_time?: string | null;
  location?: string | null;
  confirmation_number?: string | null;
  notes?: string | null;
  status?: string | null;
}
interface PatchAccommodation {
  external_ref?: string | null;
  place_ref?: string | null;
  place_id?: number | null;
  /** Dates are the reliable key across trips; day ids/numbers are not. */
  start_date?: string | null;
  end_date?: string | null;
  check_in?: string | null;
  check_out?: string | null;
  confirmation?: string | null;
  notes?: string | null;
}
interface PatchBudgetItem {
  external_ref?: string | null;
  category?: string | null;
  name?: string;
  total_price?: number | null;
  persons?: number | null;
  days?: number | null;
  note?: string | null;
}
interface PatchTodo {
  external_ref?: string | null;
  name?: string;
  text?: string;
  category?: string | null;
  checked?: number | boolean;
  sort_order?: number | null;
}

/** Replace the keyed import block in `existing`, or append it if absent. Text
 *  outside the block is never modified. */
export function upsertNotesBlock(
  existing: string | null | undefined,
  key: string,
  body: string,
): { text: string; mode: 'added' | 'replaced' | 'unchanged' } {
  const open = noteOpen(key);
  const block = `${open}\n${body}\n${NOTE_CLOSE}`;
  const cur = existing ?? '';
  const start = cur.indexOf(open);
  if (start !== -1) {
    const closeAt = cur.indexOf(NOTE_CLOSE, start);
    const end = closeAt === -1 ? cur.length : closeAt + NOTE_CLOSE.length;
    const text = cur.slice(0, start) + block + cur.slice(end);
    return { text, mode: text === cur ? 'unchanged' : 'replaced' };
  }
  const prefix = cur.trim() ? `${cur.replace(/\s+$/, '')}\n\n` : '';
  return { text: prefix + block, mode: 'added' };
}

function emptyDiff(date: string, matched: boolean): MergeDayDiff {
  return {
    date, matched,
    title_set: false,
    notes_block: 'none',
    places_added: 0,
    places_updated: 0,
    assignments_added: 0,
  };
}

/** Shared engine. `apply=false` computes the diff only (no writes). */
function mergeInto(input: ImportInput, tripId: number, apply: boolean): MergeReport {
  const envelope = input.envelope as unknown as {
    patch_key?: string;
    trip?: {
      days?: PatchDay[];
      places?: PatchPlace[];
      reservations?: PatchReservation[];
      accommodations?: PatchAccommodation[];
      budget_items?: PatchBudgetItem[];
      todo_items?: PatchTodo[];
    };
  };
  const patch = envelope.trip ?? {};
  const patchKey = (envelope.patch_key || 'import').toString().trim() || 'import';

  const trip = db.prepare('SELECT id, title FROM trips WHERE id = ?').get(tripId) as
    | { id: number; title: string }
    | undefined;

  const report: MergeReport = {
    trip_id: tripId,
    trip_title: trip?.title ?? '',
    patch_key: patchKey,
    days: [],
    totals: {
      days_matched: 0, days_skipped: 0, places_added: 0, places_updated: 0, assignments_added: 0,
      reservations_added: 0, reservations_updated: 0,
      accommodations_added: 0, accommodations_updated: 0,
      budget_items_added: 0, budget_items_updated: 0,
      todo_items_added: 0, todo_items_updated: 0,
      duplicates_skipped: 0,
    },
    warnings: [],
    errors: [],
  };
  if (!trip) {
    report.errors.push('Target trip not found');
    return report;
  }

  // Existing days of the target trip, keyed by date.
  const dayByDate = new Map<string, { id: number; title: string | null; notes: string | null }>();
  for (const d of db
    .prepare('SELECT id, date, title, notes FROM days WHERE trip_id = ? AND date IS NOT NULL')
    .all(tripId) as Array<{ id: number; date: string; title: string | null; notes: string | null }>) {
    dayByDate.set(d.date, { id: d.id, title: d.title, notes: d.notes });
  }

  // ── Places. Resolve every patch place to a real place id in this trip,
  //    upserting by external_ref (or reusing a same-named place). Keyed by the
  //    patch's own place id AND by ref so day assignments can point at either.
  const placeIdByPatchId = new Map<number, number>();
  const placeIdByRef = new Map<string, number>();
  let placesAdded = 0;
  let placesUpdated = 0;

  for (const p of patch.places ?? []) {
    if (!p?.name) continue;
    const ref = p.external_ref?.trim() || null;
    let resolvedId: number | undefined;

    let hit = ref
      ? (db.prepare('SELECT id FROM places WHERE trip_id = ? AND external_ref = ?').get(tripId, ref) as
          | { id: number }
          | undefined)
      : undefined;

    // Nothing matched the ref. On the FIRST patch into a trip built by the
    // create-new import, nothing carries a ref yet — so fall back to the
    // natural key and ADOPT that row (stamping the ref below) rather than
    // inserting a second copy of a place that's already here.
    const adopt = !hit && ref !== null;
    if (!hit) {
      hit = db
        .prepare('SELECT id FROM places WHERE trip_id = ? AND LOWER(name) = LOWER(?) LIMIT 1')
        .get(tripId, p.name) as { id: number } | undefined;
    }

    if (hit && ref) {
      resolvedId = hit.id;
      placesUpdated += 1;
      if (apply) {
        db.prepare(
          `UPDATE places SET name = ?, description = COALESCE(?, description), lat = COALESCE(?, lat),
                  lng = COALESCE(?, lng), address = COALESCE(?, address), notes = COALESCE(?, notes),
                  updated_at = CURRENT_TIMESTAMP
            WHERE id = ?`,
        ).run(p.name, p.description ?? null, p.lat ?? null, p.lng ?? null, p.address ?? null, p.notes ?? null, hit.id);
        if (adopt) db.prepare('UPDATE places SET external_ref = ? WHERE id = ?').run(ref, hit.id);
      }
    } else if (hit) {
      // No ref at all — reuse the same-named place, untouched.
      resolvedId = hit.id;
    }

    if (resolvedId === undefined) {
      placesAdded += 1;
      if (apply) {
        const ins = db
          .prepare(
            `INSERT INTO places (trip_id, name, description, lat, lng, address, notes, external_ref)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(tripId, p.name, p.description ?? null, p.lat ?? null, p.lng ?? null, p.address ?? null, p.notes ?? null, ref);
        resolvedId = Number(ins.lastInsertRowid);
      } else {
        resolvedId = -1; // placeholder during dry-run
      }
    }

    if (typeof p.id === 'number') placeIdByPatchId.set(p.id, resolvedId);
    if (ref) placeIdByRef.set(ref, resolvedId);
  }

  // ── Days.
  for (const pd of patch.days ?? []) {
    const date = (pd?.date ?? '').toString();
    if (!date) continue;
    const target = dayByDate.get(date);
    if (!target) {
      report.days.push(emptyDiff(date, false));
      report.totals.days_skipped += 1;
      report.warnings.push(`${date} is not a day in this trip — skipped`);
      continue;
    }

    const diff = emptyDiff(date, true);
    report.totals.days_matched += 1;

    // Title: only when the day hasn't got one (never overwrite yours).
    if (pd.title && !(target.title ?? '').trim()) {
      diff.title_set = true;
      if (apply) db.prepare('UPDATE days SET title = ? WHERE id = ?').run(pd.title, target.id);
    }

    // Notes: append/replace the keyed block; your own text is untouched.
    if (pd.notes && pd.notes.trim()) {
      const { text, mode } = upsertNotesBlock(target.notes, patchKey, pd.notes.trim());
      diff.notes_block = mode;
      if (apply && mode !== 'unchanged') {
        db.prepare('UPDATE days SET notes = ? WHERE id = ?').run(text, target.id);
      }
    }

    // Assignments: put each referenced place on the day if it isn't already.
    for (const a of pd.assignments ?? []) {
      const ref = a?.place_ref?.trim() || null;
      const pid = ref ? placeIdByRef.get(ref) : a?.place?.id != null ? placeIdByPatchId.get(a.place.id) : undefined;
      if (pid === undefined) continue;
      // pid <= 0 only happens during dry-run for a place that doesn't exist yet —
      // it can't already be assigned, so it always counts as an addition.
      if (pid > 0) {
        const already = db
          .prepare('SELECT 1 FROM day_assignments WHERE day_id = ? AND place_id = ?')
          .get(target.id, pid);
        if (already) continue;
        if (apply) {
          const next = db
            .prepare('SELECT COALESCE(MAX(order_index), -1) + 1 AS n FROM day_assignments WHERE day_id = ?')
            .get(target.id) as { n: number };
          db.prepare('INSERT INTO day_assignments (day_id, place_id, order_index) VALUES (?, ?, ?)').run(
            target.id, pid, next.n,
          );
        }
      }
      diff.assignments_added += 1;
    }

    report.days.push(diff);
  }

  // ── Reservations. The file is the scope: every reservation it lists is merged.
  //    Ref → upsert; no ref → reuse a matching confirmation number rather than
  //    creating a second copy of the same booking.
  for (const r of patch.reservations ?? []) {
    if (!r?.title) continue;
    const ref = r.external_ref?.trim() || null;
    let hit: { id: number } | undefined;
    if (ref) {
      hit = db.prepare('SELECT id FROM reservations WHERE trip_id = ? AND external_ref = ?').get(tripId, ref) as { id: number } | undefined;
    }
    // Ref missed → adopt an existing booking with the same confirmation number
    // (see the places block: the first patch into an existing trip finds no refs).
    const adopt = !hit && ref !== null;
    if (!hit && r.confirmation_number) {
      hit = db
        .prepare('SELECT id FROM reservations WHERE trip_id = ? AND confirmation_number = ? LIMIT 1')
        .get(tripId, r.confirmation_number) as { id: number } | undefined;
    }
    if (hit && ref) {
      report.totals.reservations_updated += 1;
      if (apply) {
        db.prepare(
          `UPDATE reservations SET title = ?, type = COALESCE(?, type), reservation_time = COALESCE(?, reservation_time),
                  location = COALESCE(?, location), confirmation_number = COALESCE(?, confirmation_number),
                  notes = COALESCE(?, notes), status = COALESCE(?, status)
            WHERE id = ?`,
        ).run(r.title, r.type ?? null, r.reservation_time ?? null, r.location ?? null, r.confirmation_number ?? null, r.notes ?? null, r.status ?? null, hit.id);
        if (adopt) db.prepare('UPDATE reservations SET external_ref = ? WHERE id = ?').run(ref, hit.id);
      }
    } else if (hit) {
      report.totals.duplicates_skipped += 1; // same confirmation already here — left alone
    } else {
      report.totals.reservations_added += 1;
      if (apply) {
        db.prepare(
          `INSERT INTO reservations (trip_id, title, type, reservation_time, location, confirmation_number, notes, status, external_ref)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(tripId, r.title, r.type ?? 'other', r.reservation_time ?? null, r.location ?? null, r.confirmation_number ?? null, r.notes ?? null, r.status ?? 'confirmed', ref);
      }
    }
  }

  // ── Accommodations. Anchored to DATES (day ids/numbers from another trip
  //    can't be trusted), so a stay whose dates aren't in this trip is skipped.
  for (const a of patch.accommodations ?? []) {
    const label = a?.confirmation || a?.external_ref || 'accommodation';
    const s = a?.start_date ? dayByDate.get(a.start_date) : undefined;
    const e = a?.end_date ? dayByDate.get(a.end_date) : undefined;
    if (!s || !e) {
      report.warnings.push(`Accommodation "${label}" needs start_date and end_date that exist in this trip — skipped`);
      continue;
    }
    const pid = a.place_ref ? placeIdByRef.get(a.place_ref.trim()) : a.place_id != null ? placeIdByPatchId.get(a.place_id) : undefined;
    if (pid === undefined) {
      report.warnings.push(`Accommodation "${label}" refers to a place that isn't in this patch — skipped`);
      continue;
    }
    const ref = a.external_ref?.trim() || null;
    let hit: { id: number } | undefined;
    if (ref) {
      hit = db.prepare('SELECT id FROM day_accommodations WHERE trip_id = ? AND external_ref = ?').get(tripId, ref) as { id: number } | undefined;
    }
    // Ref missed → adopt the stay already sitting on the same place and dates.
    const adopt = !hit && ref !== null;
    if (!hit && pid > 0) {
      hit = db
        .prepare('SELECT id FROM day_accommodations WHERE trip_id = ? AND place_id = ? AND start_day_id = ? AND end_day_id = ? LIMIT 1')
        .get(tripId, pid, s.id, e.id) as { id: number } | undefined;
    }
    if (hit && ref) {
      report.totals.accommodations_updated += 1;
      if (apply) {
        db.prepare(
          `UPDATE day_accommodations SET place_id = ?, start_day_id = ?, end_day_id = ?,
                  check_in = COALESCE(?, check_in), check_out = COALESCE(?, check_out),
                  confirmation = COALESCE(?, confirmation), notes = COALESCE(?, notes)
            WHERE id = ?`,
        ).run(pid, s.id, e.id, a.check_in ?? null, a.check_out ?? null, a.confirmation ?? null, a.notes ?? null, hit.id);
        if (adopt) db.prepare('UPDATE day_accommodations SET external_ref = ? WHERE id = ?').run(ref, hit.id);
      }
    } else if (hit) {
      report.totals.duplicates_skipped += 1;
    } else {
      report.totals.accommodations_added += 1;
      if (apply && pid > 0) {
        db.prepare(
          `INSERT INTO day_accommodations (trip_id, place_id, start_day_id, end_day_id, check_in, check_out, confirmation, notes, external_ref)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(tripId, pid, s.id, e.id, a.check_in ?? null, a.check_out ?? null, a.confirmation ?? null, a.notes ?? null, ref);
      }
    }
  }

  // ── Budget items.
  for (const b of patch.budget_items ?? []) {
    if (!b?.name) continue;
    const ref = b.external_ref?.trim() || null;
    let hit: { id: number } | undefined;
    if (ref) {
      hit = db.prepare('SELECT id FROM budget_items WHERE trip_id = ? AND external_ref = ?').get(tripId, ref) as { id: number } | undefined;
    }
    const adopt = !hit && ref !== null; // ref missed → adopt the same-named item
    if (!hit) {
      hit = db.prepare('SELECT id FROM budget_items WHERE trip_id = ? AND LOWER(name) = LOWER(?) LIMIT 1').get(tripId, b.name) as { id: number } | undefined;
    }
    if (hit && ref) {
      report.totals.budget_items_updated += 1;
      if (apply) {
        db.prepare(
          `UPDATE budget_items SET category = COALESCE(?, category), name = ?, total_price = COALESCE(?, total_price),
                  persons = COALESCE(?, persons), days = COALESCE(?, days), note = COALESCE(?, note)
            WHERE id = ?`,
        ).run(b.category ?? null, b.name, b.total_price ?? null, b.persons ?? null, b.days ?? null, b.note ?? null, hit.id);
        if (adopt) db.prepare('UPDATE budget_items SET external_ref = ? WHERE id = ?').run(ref, hit.id);
      }
    } else if (hit) {
      report.totals.duplicates_skipped += 1;
    } else {
      report.totals.budget_items_added += 1;
      if (apply) {
        db.prepare(
          `INSERT INTO budget_items (trip_id, category, name, total_price, persons, days, note, external_ref)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(tripId, b.category ?? 'Other', b.name, b.total_price ?? 0, b.persons ?? null, b.days ?? null, b.note ?? null, ref);
      }
    }
  }

  // ── To-dos. The column is `name` (see IMPORT-009); accept `text` too.
  for (const t of patch.todo_items ?? []) {
    const name = (t?.name ?? t?.text ?? '').toString().trim();
    if (!name) continue;
    const ref = t.external_ref?.trim() || null;
    let hit: { id: number } | undefined;
    if (ref) {
      hit = db.prepare('SELECT id FROM todo_items WHERE trip_id = ? AND external_ref = ?').get(tripId, ref) as { id: number } | undefined;
    }
    const adopt = !hit && ref !== null; // ref missed → adopt the same-named to-do
    if (!hit) {
      hit = db.prepare('SELECT id FROM todo_items WHERE trip_id = ? AND LOWER(name) = LOWER(?) LIMIT 1').get(tripId, name) as { id: number } | undefined;
    }
    if (hit && ref) {
      report.totals.todo_items_updated += 1;
      if (apply) {
        db.prepare('UPDATE todo_items SET name = ?, category = COALESCE(?, category) WHERE id = ?')
          .run(name, t.category ?? null, hit.id);
        if (adopt) db.prepare('UPDATE todo_items SET external_ref = ? WHERE id = ?').run(ref, hit.id);
      }
    } else if (hit) {
      report.totals.duplicates_skipped += 1;
    } else {
      report.totals.todo_items_added += 1;
      if (apply) {
        db.prepare('INSERT INTO todo_items (trip_id, name, category, checked, sort_order, external_ref) VALUES (?, ?, ?, ?, ?, ?)')
          .run(tripId, name, t.category ?? null, t.checked ? 1 : 0, t.sort_order ?? 0, ref);
      }
    }
  }

  report.totals.places_added = placesAdded;
  report.totals.places_updated = placesUpdated;
  report.totals.assignments_added = report.days.reduce((n, d) => n + d.assignments_added, 0);
  // Per-day place counts aren't meaningful (places are trip-level); report totals.
  return report;
}

/** Preview a merge — computes the diff, writes nothing. */
export function dryRunMerge(input: ImportInput, tripId: number): MergeReport {
  return mergeInto(input, tripId, false);
}

/** Apply a merge into an existing trip. One transaction. */
export function applyMerge(input: ImportInput, tripId: number): MergeReport {
  return db.transaction((): MergeReport => mergeInto(input, tripId, true))();
}
