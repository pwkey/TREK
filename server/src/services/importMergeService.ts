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
    trip?: { days?: PatchDay[]; places?: PatchPlace[] };
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
    totals: { days_matched: 0, days_skipped: 0, places_added: 0, places_updated: 0, assignments_added: 0 },
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

    if (ref) {
      const hit = db
        .prepare('SELECT id FROM places WHERE trip_id = ? AND external_ref = ?')
        .get(tripId, ref) as { id: number } | undefined;
      if (hit) {
        resolvedId = hit.id;
        placesUpdated += 1;
        if (apply) {
          db.prepare(
            `UPDATE places SET name = ?, description = COALESCE(?, description), lat = COALESCE(?, lat),
                    lng = COALESCE(?, lng), address = COALESCE(?, address), notes = COALESCE(?, notes),
                    updated_at = CURRENT_TIMESTAMP
              WHERE id = ?`,
          ).run(p.name, p.description ?? null, p.lat ?? null, p.lng ?? null, p.address ?? null, p.notes ?? null, hit.id);
        }
      }
    }

    if (resolvedId === undefined && !ref) {
      // No ref — reuse a same-named place rather than duplicating it.
      const same = db
        .prepare('SELECT id FROM places WHERE trip_id = ? AND LOWER(name) = LOWER(?) LIMIT 1')
        .get(tripId, p.name) as { id: number } | undefined;
      if (same) resolvedId = same.id;
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
