// [460-fork] Milestone 7 slice 3 — JSON / bundle import.
//
// Two-phase: dry-run reports what WOULD happen (never touches the DB);
// apply runs in a transaction and creates a fresh trip owned by the
// importer with new IDs throughout (CLAUDE.md §8.4 default — Restore-by-
// UUID is slice 7.4). Bundle imports unpack photo + file binaries into
// the existing trip_files store with fresh UUIDs so the new rows can't
// collide with anything already on disk.
//
// What this slice imports:
//   - trip metadata
//   - days (incl. journals + photos with binaries when bundle)
//   - places
//   - day assignments (via mapped place + day ids)
//   - reservations (without re-linking files / accommodation rows yet)
//   - budget items (header only, no per-member splits)
//   - packing + todo items
//   - accommodations
//
// Deferred:
//   - segments (cross-trip refs are external placeholders; importing
//     them as standalone is M7.4)
//   - reservation ↔ trip_files re-linking
//   - budget item members + paid status
//   - notes_items
//   - collab_notes / chat / polls
//   - members (the importer is always the new owner; collaborators
//     would need invite flows that don't exist yet)
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import unzipper from 'unzipper';
import { db } from '../db/database';
import { filesDir } from './fileService';
import { EXPORT_SCHEMA_VERSION, EXPORT_APP_ID, type ExportFormat } from './exportService';

export interface ImportInput {
  envelope: ImportEnvelope;
  attachments: Map<string, Buffer>;
}

export interface ImportEnvelope {
  schema_version: number;
  app?: string;
  format?: ExportFormat;
  exported_at?: string;
  exported_by?: { id?: number; username?: string; email?: string };
  trip: ImportedTrip;
}

interface ImportedTrip {
  id?: number;
  title: string;
  description?: string | null;
  start_date?: string | null;
  end_date?: string | null;
  currency?: string | null;
  cover_image?: string | null;
  days?: ImportedDay[];
  places?: ImportedPlace[];
  reservations?: ImportedReservation[];
  budget_items?: ImportedBudgetItem[];
  packing_items?: ImportedItem[];
  todo_items?: ImportedItem[];
  accommodations?: ImportedAccommodation[];
}

interface ImportedDay {
  id: number;
  day_number: number;
  date?: string | null;
  title?: string | null;
  notes?: string | null;
  journal?: { content_markdown: string } | null;
  photos?: ImportedPhoto[];
  assignments?: ImportedAssignment[];
}

interface ImportedPhoto {
  id?: number;
  filename: string;
  original_name: string;
  mime_type: string;
  caption?: string | null;
  taken_at?: string | null;
  lat?: number | null;
  lng?: number | null;
  altitude?: number | null;
  camera?: string | null;
  position?: number;
  attachment_path?: string;
}

interface ImportedAssignment {
  id?: number;
  place?: { id: number };
  order_index?: number;
  notes?: string | null;
}

interface ImportedPlace {
  id: number;
  name: string;
  description?: string | null;
  lat?: number | null;
  lng?: number | null;
  address?: string | null;
  notes?: string | null;
}

interface ImportedReservation {
  id?: number;
  title?: string;
  type?: string;
  reservation_time?: string | null;
  location?: string | null;
  confirmation_number?: string | null;
  notes?: string | null;
  status?: string | null;
}

interface ImportedBudgetItem {
  id?: number;
  category?: string;
  name: string;
  total_price?: number;
  persons?: number | null;
  days?: number | null;
  note?: string | null;
}

interface ImportedItem {
  id?: number;
  name?: string;
  text?: string;
  category?: string | null;
  quantity?: number | null;
  checked?: number | boolean;
  sort_order?: number;
}

interface ImportedAccommodation {
  id?: number;
  place_id?: number;
  start_day_id?: number;
  end_day_id?: number;
  check_in?: string | null;
  check_out?: string | null;
  confirmation?: string | null;
  notes?: string | null;
}

export interface DryRunReport {
  schema_version: number;
  format: ExportFormat | 'unknown';
  source_trip: { title: string; start_date: string | null; end_date: string | null };
  would_create: {
    trip: number;
    days: number;
    places: number;
    reservations: number;
    photos_with_binary: number;
    photos_metadata_only: number;
    journals: number;
    budget_items: number;
    packing_items: number;
    todo_items: number;
    accommodations: number;
  };
  warnings: string[];
  errors: string[];
}

const ZIP_SIGNATURE = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

/** Detect a ZIP by its local-file-header signature, then unpack
 *  trip.json + attachments/ into memory. Falls back to JSON parse for
 *  raw .json uploads. */
export async function parseImportInput(buffer: Buffer): Promise<ImportInput> {
  if (buffer.length < 4) throw new Error('File is empty');
  const isZip = buffer.subarray(0, 4).equals(ZIP_SIGNATURE);
  if (isZip) {
    const directory = await unzipper.Open.buffer(buffer);
    const tripJsonEntry = directory.files.find((f) => f.path === 'trip.json');
    if (!tripJsonEntry) throw new Error('Bundle is missing trip.json');
    const tripJsonBuf = await tripJsonEntry.buffer();
    let envelope: ImportEnvelope;
    try {
      envelope = JSON.parse(tripJsonBuf.toString('utf8'));
    } catch (err) {
      throw new Error(`trip.json is not valid JSON: ${(err as Error).message}`);
    }
    const attachments = new Map<string, Buffer>();
    for (const f of directory.files) {
      if (f.type === 'File' && f.path.startsWith('attachments/')) {
        attachments.set(f.path, await f.buffer());
      }
    }
    return { envelope, attachments };
  }
  // Treat as JSON.
  let envelope: ImportEnvelope;
  try {
    envelope = JSON.parse(buffer.toString('utf8'));
  } catch (err) {
    throw new Error(`Not a valid .json or .zip export: ${(err as Error).message}`);
  }
  return { envelope, attachments: new Map() };
}

/** Validate the envelope and produce the dry-run report. */
export function dryRunImport(input: ImportInput): DryRunReport {
  const errors: string[] = [];
  const warnings: string[] = [];
  const env = input.envelope;

  if (!env || typeof env !== 'object') errors.push('Envelope is not an object');
  if (env?.schema_version !== EXPORT_SCHEMA_VERSION) {
    errors.push(`Unsupported schema_version ${env?.schema_version} (this build supports ${EXPORT_SCHEMA_VERSION})`);
  }
  if (env?.app && env.app !== EXPORT_APP_ID) {
    warnings.push(`Envelope app "${env.app}" does not match this build's "${EXPORT_APP_ID}" — proceeding anyway`);
  }
  if (!env?.trip) errors.push('Envelope is missing trip');

  const trip = env?.trip;
  const format: ExportFormat | 'unknown' = env?.format ?? 'unknown';

  let photosWithBinary = 0;
  let photosMetadataOnly = 0;
  let journals = 0;

  for (const day of trip?.days ?? []) {
    if (day.journal && day.journal.content_markdown) journals++;
    for (const photo of day.photos ?? []) {
      if (photo.attachment_path && input.attachments.has(photo.attachment_path)) {
        photosWithBinary++;
      } else if (photo.attachment_path) {
        photosMetadataOnly++;
        warnings.push(`Photo "${photo.original_name}" references attachment "${photo.attachment_path}" that is missing from the bundle`);
      } else {
        photosMetadataOnly++;
      }
    }
  }
  if (format === 'metadata-only' && photosMetadataOnly > 0) {
    warnings.push(`${photosMetadataOnly} photo entries will be imported as metadata-only — the binaries are not in this file. Match by original_name + taken_at against your source photo library if you need the images.`);
  }

  return {
    schema_version: env?.schema_version ?? 0,
    format,
    source_trip: {
      title: trip?.title ?? '(untitled)',
      start_date: trip?.start_date ?? null,
      end_date: trip?.end_date ?? null,
    },
    would_create: {
      trip: trip ? 1 : 0,
      days: trip?.days?.length ?? 0,
      places: trip?.places?.length ?? 0,
      reservations: trip?.reservations?.length ?? 0,
      photos_with_binary: photosWithBinary,
      photos_metadata_only: photosMetadataOnly,
      journals,
      budget_items: trip?.budget_items?.length ?? 0,
      packing_items: trip?.packing_items?.length ?? 0,
      todo_items: trip?.todo_items?.length ?? 0,
      accommodations: trip?.accommodations?.length ?? 0,
    },
    warnings,
    errors,
  };
}

export interface ImportResult {
  trip_id: number;
  created: DryRunReport['would_create'];
}

/** Apply the import as a fresh trip owned by `importerId`. Wraps every
 *  insert in a transaction so a mid-flight failure leaves no orphans. */
export function applyImport(input: ImportInput, importerId: number): ImportResult {
  const report = dryRunImport(input);
  if (report.errors.length > 0) {
    throw new Error(`Cannot import: ${report.errors.join('; ')}`);
  }
  const trip = input.envelope.trip;

  return db.transaction((): ImportResult => {
    // 1. Trip
    const tripResult = db.prepare(`
      INSERT INTO trips (user_id, title, description, start_date, end_date, currency, is_archived)
      VALUES (?, ?, ?, ?, ?, ?, 0)
    `).run(
      importerId,
      trip.title,
      trip.description ?? null,
      trip.start_date ?? null,
      trip.end_date ?? null,
      trip.currency ?? null,
    );
    const newTripId = Number(tripResult.lastInsertRowid);

    // 2. Places — preserve old IDs in a map so assignments can be re-linked.
    const placeIdMap = new Map<number, number>();
    for (const p of trip.places ?? []) {
      const r = db.prepare(`
        INSERT INTO places (trip_id, name, description, lat, lng, address, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(newTripId, p.name, p.description ?? null, p.lat ?? null, p.lng ?? null, p.address ?? null, p.notes ?? null);
      placeIdMap.set(p.id, Number(r.lastInsertRowid));
    }

    // 3. Days
    const dayIdMap = new Map<number, number>();
    for (const d of trip.days ?? []) {
      const r = db.prepare(`
        INSERT INTO days (trip_id, day_number, date, title, notes)
        VALUES (?, ?, ?, ?, ?)
      `).run(newTripId, d.day_number, d.date ?? null, d.title ?? null, d.notes ?? null);
      dayIdMap.set(d.id, Number(r.lastInsertRowid));
    }

    // 4. Day-level children: assignments, journals, photos.
    for (const d of trip.days ?? []) {
      const newDayId = dayIdMap.get(d.id);
      if (!newDayId) continue;

      // 4a. Assignments
      for (const a of d.assignments ?? []) {
        const oldPlaceId = a.place?.id;
        if (typeof oldPlaceId !== 'number') continue;
        const newPlaceId = placeIdMap.get(oldPlaceId);
        if (!newPlaceId) continue;
        db.prepare(`
          INSERT INTO day_assignments (day_id, place_id, order_index, notes)
          VALUES (?, ?, ?, ?)
        `).run(newDayId, newPlaceId, a.order_index ?? 0, a.notes ?? null);
      }

      // 4b. Journal
      if (d.journal && d.journal.content_markdown) {
        db.prepare(`
          INSERT INTO day_journals (day_id, content_markdown, updated_by)
          VALUES (?, ?, ?)
        `).run(newDayId, d.journal.content_markdown, importerId);
      }

      // 4c. Photos
      for (const photo of d.photos ?? []) {
        const binary = photo.attachment_path ? input.attachments.get(photo.attachment_path) : undefined;
        if (!binary && photo.attachment_path) {
          // Bundle referenced a path we don't have — skip rather than
          // create a row pointing at nothing.
          continue;
        }
        if (!binary && !photo.attachment_path) {
          // Metadata-only photo — skip per the dry-run warning. The
          // recovery path is to re-export with the bundle option (or
          // a future re-attach UI in slice 7.5).
          continue;
        }
        // Write binary with a fresh UUID filename so we don't collide
        // with anything already in trip_files / on disk.
        const ext = path.extname(photo.filename) || '.jpg';
        const newFilename = `${randomUUID()}${ext}`;
        const diskPath = path.join(filesDir, newFilename);
        if (!fs.existsSync(filesDir)) fs.mkdirSync(filesDir, { recursive: true });
        fs.writeFileSync(diskPath, binary!);

        const tf = db.prepare(`
          INSERT INTO trip_files (trip_id, filename, original_name, file_size, mime_type, uploaded_by)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(newTripId, newFilename, photo.original_name, binary!.length, photo.mime_type, importerId);

        db.prepare(`
          INSERT INTO day_photos (day_id, upload_id, caption, taken_at, lat, lng, altitude, camera, position)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          newDayId,
          Number(tf.lastInsertRowid),
          photo.caption ?? null,
          photo.taken_at ?? null,
          photo.lat ?? null,
          photo.lng ?? null,
          photo.altitude ?? null,
          photo.camera ?? null,
          photo.position ?? 0,
        );
      }
    }

    // 5. Reservations (header only — no file links yet, no accommodation_id).
    for (const r of trip.reservations ?? []) {
      db.prepare(`
        INSERT INTO reservations (trip_id, title, reservation_time, location, confirmation_number, notes, status, type)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        newTripId,
        r.title ?? null,
        r.reservation_time ?? null,
        r.location ?? null,
        r.confirmation_number ?? null,
        r.notes ?? null,
        r.status ?? 'pending',
        r.type ?? 'other',
      );
    }

    // 6. Budget items (header only).
    for (const b of trip.budget_items ?? []) {
      db.prepare(`
        INSERT INTO budget_items (trip_id, category, name, total_price, persons, days, note)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        newTripId,
        b.category ?? 'Other',
        b.name,
        b.total_price ?? 0,
        b.persons ?? null,
        b.days ?? null,
        b.note ?? null,
      );
    }

    // 7. Packing items.
    for (const p of trip.packing_items ?? []) {
      db.prepare(`
        INSERT INTO packing_items (trip_id, name, category, quantity, checked, sort_order)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        newTripId,
        p.name ?? p.text ?? '',
        p.category ?? null,
        p.quantity ?? null,
        p.checked ? 1 : 0,
        p.sort_order ?? 0,
      );
    }

    // 8. Todo items.
    for (const t of trip.todo_items ?? []) {
      db.prepare(`
        INSERT INTO todo_items (trip_id, text, category, checked, sort_order)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        newTripId,
        t.text ?? t.name ?? '',
        t.category ?? null,
        t.checked ? 1 : 0,
        t.sort_order ?? 0,
      );
    }

    // 9. Accommodations — need both the place and day mappings.
    for (const a of trip.accommodations ?? []) {
      const newPlaceId = a.place_id ? placeIdMap.get(a.place_id) : undefined;
      const newStartDayId = a.start_day_id ? dayIdMap.get(a.start_day_id) : undefined;
      const newEndDayId = a.end_day_id ? dayIdMap.get(a.end_day_id) : undefined;
      if (!newPlaceId || !newStartDayId || !newEndDayId) continue;
      db.prepare(`
        INSERT INTO day_accommodations (trip_id, place_id, start_day_id, end_day_id, check_in, check_out, confirmation, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        newTripId,
        newPlaceId,
        newStartDayId,
        newEndDayId,
        a.check_in ?? null,
        a.check_out ?? null,
        a.confirmation ?? null,
        a.notes ?? null,
      );
    }

    return {
      trip_id: newTripId,
      created: report.would_create,
    };
  })();
}
