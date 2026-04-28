// [460-fork] Milestone 7 slice 1 — JSON export of a single trip.
//
// CLAUDE.md §8 use cases:
//   1. Archival — every completed trip should be exportable to a self-
//      contained file storable in personal cloud storage, independent
//      of 460 Trip Planner's future.
//   2. Offline review — a downloaded JSON / bundle is the insurance
//      for "what if the server is unreachable for the whole trip?"
//   3. Portability — ability to import into a future version or a
//      different instance.
//
// Schema design follows §8.2: versioned, self-contained where possible,
// denormalised names alongside IDs, no secrets. The bundle (zip with
// attachments) is slice 7.2; this slice is JSON-only.

import path from 'node:path';
import fs from 'node:fs';
import { db } from '../db/database';
import { listDays, listAccommodations } from './dayService';
import { listPlaces } from './placeService';
import { listReservations } from './reservationService';
import { listBudgetItems } from './budgetService';
import { listItems as listPackingItems } from './packingService';
import { listItems as listTodoItems } from './todoService';
import { getJournal } from './journalService';
import { listPhotos } from './dayPhotoService';
import { listMembers } from './tripService';
import { filesDir } from './fileService';

export const EXPORT_SCHEMA_VERSION = 1;
export const EXPORT_APP_ID = '460-trip-planner';

export type ExportFormat = 'metadata-only' | 'bundle';

const RECOVERY_NOTES_METADATA_ONLY =
  'This export does not include photo binaries or attached files. ' +
  'Each photo entry below preserves the original filename (original_name), ' +
  'capture timestamp (taken_at), and EXIF metadata so you can match entries ' +
  'against your source photo library if you ever need to re-attach the ' +
  'binaries. For a fully self-contained archive, re-export with the Bundle ' +
  'option (.zip with photos + attached files).';

interface ExportEnvelope {
  schema_version: number;
  app: string;
  /** Distinguishes metadata-only from bundle exports. Future import logic
   *  branches on this: `bundle` payloads carry an `attachment_path` on
   *  each photo and the binaries live alongside in the zip; `metadata-
   *  only` payloads need a re-attach UI. */
  format: ExportFormat;
  /** Present only on metadata-only exports — explicit human-readable
   *  hint about what's missing and how to recover. */
  recovery_notes?: string;
  exported_at: string;
  exported_by: { id: number; username: string; email: string };
  trip: ExportedTrip;
}

interface ExportedTrip {
  id: number;
  title: string;
  description: string | null;
  start_date: string | null;
  end_date: string | null;
  currency: string | null;
  cover_image: string | null;
  is_archived: number;
  created_at: string;
  members: Array<{ id: number; username: string; email: string; role: string }>;
  days: ExportedDay[];
  places: unknown[];
  reservations: unknown[];
  budget_items: unknown[];
  packing_items: unknown[];
  todo_items: unknown[];
  accommodations: unknown[];
  segments: ExportedSegment[];
}

interface ExportedDay {
  id: number;
  day_number: number;
  date: string | null;
  title: string | null;
  notes: string | null;
  segment_id: string | null;
  updated_at: string | null;
  journal: { content_markdown: string; updated_at: string; updated_by_username: string | null } | null;
  photos: ExportedPhoto[];
  assignments: unknown[];
  notes_items: unknown[];
}

interface ExportedPhoto {
  id: number;
  filename: string;
  original_name: string;
  mime_type: string;
  caption: string | null;
  taken_at: string | null;
  lat: number | null;
  lng: number | null;
  altitude: number | null;
  camera: string | null;
  position: number;
  /** Bundle-only: relative path inside the zip where the binary lives.
   *  Absent in JSON-only exports (slice 7.1). */
  attachment_path?: string;
}

interface ExportedSegment {
  id: string;
  title: string;
  start_date: string | null;
  end_date: string | null;
  /** Trip ids the segment is linked to OTHER than the one being exported.
   *  Imported standalone since the linked trips may live on a different
   *  household's instance (CLAUDE.md §8.4). */
  external_trip_refs: string[];
}

/** Build the export envelope for a trip. Caller must have already
 *  verified that `userId` can access `tripId`. The `format` parameter
 *  decides whether to advertise this as metadata-only (default — the
 *  /export route) or bundle (the /export/bundle route, which adds
 *  attachment_path on each photo and zips the binaries alongside). */
export function exportTrip(
  tripId: number,
  exporter: { id: number; username: string; email: string },
  opts: { format?: ExportFormat } = {},
): ExportEnvelope {
  const format: ExportFormat = opts.format ?? 'metadata-only';
  const tripRow = db.prepare(`
    SELECT id, title, description, start_date, end_date, currency, cover_image, is_archived, created_at, user_id
    FROM trips WHERE id = ?
  `).get(tripId) as { user_id: number } & Omit<ExportedTrip, 'members' | 'days' | 'places' | 'reservations' | 'budget_items' | 'packing_items' | 'todo_items' | 'accommodations' | 'segments'> | undefined;
  if (!tripRow) throw new Error('Trip not found');

  const { owner, members } = listMembers(tripId, tripRow.user_id);
  const allMembers = [
    { id: owner.id, username: owner.username, email: owner.email, role: 'owner' },
    ...members.map(m => ({ id: m.id, username: m.username, email: m.email, role: m.role })),
  ];

  // Days — listDays already includes assignments + notes_items + segment
  // summary. Layer journal + photos on top per day.
  const { days: rawDays } = listDays(tripId);
  const days: ExportedDay[] = rawDays.map((d) => {
    const journalRow = getJournal(d.id);
    let journalUsername: string | null = null;
    if (journalRow?.updated_by) {
      const u = db.prepare('SELECT username FROM users WHERE id = ?').get(journalRow.updated_by) as { username: string } | undefined;
      journalUsername = u?.username ?? null;
    }
    const photos: ExportedPhoto[] = listPhotos(d.id).map((p) => ({
      id: p.id,
      filename: p.filename,
      original_name: p.original_name,
      mime_type: p.mime_type,
      caption: p.caption,
      taken_at: p.taken_at,
      lat: p.lat,
      lng: p.lng,
      altitude: p.altitude,
      camera: p.camera,
      position: p.position,
    }));
    return {
      id: d.id,
      day_number: d.day_number,
      date: d.date,
      title: d.title,
      notes: d.notes,
      segment_id: (d as { segment_id?: string | null }).segment_id ?? null,
      updated_at: (d as { updated_at?: string | null }).updated_at ?? null,
      journal: journalRow ? {
        content_markdown: journalRow.content_markdown,
        updated_at: journalRow.updated_at,
        updated_by_username: journalUsername,
      } : null,
      photos,
      assignments: d.assignments ?? [],
      notes_items: (d as { notes_items?: unknown[] }).notes_items ?? [],
    };
  });

  const places = listPlaces(String(tripId), {});
  const reservations = listReservations(tripId);
  const budgetItems = listBudgetItems(tripId);
  const packingItems = listPackingItems(tripId);
  const todoItems = listTodoItems(tripId);
  const accommodations = listAccommodations(tripId);

  // Segments the trip is part of (own + via trip_segments). For each, list
  // the OTHER trips it links to as external refs only — we never embed
  // another trip's contents in this export (CLAUDE.md §8.4).
  const segmentRows = db.prepare(`
    SELECT s.id, s.title, s.start_date, s.end_date
      FROM segments s
     WHERE s.id IN (SELECT segment_id FROM trip_segments WHERE trip_id = ?)
  `).all(tripId) as { id: string; title: string; start_date: string | null; end_date: string | null }[];
  const segments: ExportedSegment[] = segmentRows.map((s) => {
    const otherTripIds = db.prepare(
      'SELECT trip_id FROM trip_segments WHERE segment_id = ? AND trip_id != ?'
    ).all(s.id, tripId) as { trip_id: number }[];
    return {
      ...s,
      external_trip_refs: otherTripIds.map(r => `external:trip:${r.trip_id}`),
    };
  });

  return {
    schema_version: EXPORT_SCHEMA_VERSION,
    app: EXPORT_APP_ID,
    format,
    ...(format === 'metadata-only' ? { recovery_notes: RECOVERY_NOTES_METADATA_ONLY } : {}),
    exported_at: new Date().toISOString(),
    exported_by: { id: exporter.id, username: exporter.username, email: exporter.email },
    trip: {
      id: tripRow.id,
      title: tripRow.title,
      description: tripRow.description,
      start_date: tripRow.start_date,
      end_date: tripRow.end_date,
      currency: tripRow.currency,
      cover_image: tripRow.cover_image,
      is_archived: tripRow.is_archived,
      created_at: tripRow.created_at,
      members: allMembers,
      days,
      places,
      reservations,
      budget_items: budgetItems,
      packing_items: packingItems,
      todo_items: todoItems,
      accommodations,
      segments,
    },
  };
}

/** Bundle pairing: an envelope where each photo carries an
 *  `attachment_path`, plus the list of disk-path → archive-path
 *  attachments the route should add to the zip. Reservation-linked
 *  trip_files are included under attachments/files/ so a 2035 reader
 *  has the booking PDFs alongside the photos. */
export interface BundlePlan {
  envelope: ExportEnvelope;
  attachments: Array<{ diskPath: string; archivePath: string }>;
}

export function planTripBundle(tripId: number, exporter: { id: number; username: string; email: string }): BundlePlan {
  const envelope = exportTrip(tripId, exporter, { format: 'bundle' });
  const attachments: BundlePlan['attachments'] = [];

  // Photos. archive path is photos/<photo_id>-<filename> so every entry
  // is unique even if multer's UUID renaming were ever to collide.
  for (const day of envelope.trip.days) {
    for (const photo of day.photos) {
      const diskPath = path.join(filesDir, photo.filename);
      if (!fs.existsSync(diskPath)) continue;
      const archivePath = `attachments/photos/${photo.id}-${photo.filename}`;
      photo.attachment_path = archivePath;
      attachments.push({ diskPath, archivePath });
    }
  }

  // Reservation-linked files (booking PDFs etc). trip_files surfaces
  // these via the reservations sub-objects already; we just walk the
  // raw rows to find any with a reservation_id matching this trip.
  type ResFile = { id: number; filename: string; reservation_id: number };
  const resFiles = db.prepare(`
    SELECT id, filename, reservation_id FROM trip_files
    WHERE trip_id = ? AND reservation_id IS NOT NULL AND deleted_at IS NULL
  `).all(tripId) as ResFile[];
  for (const f of resFiles) {
    const diskPath = path.join(filesDir, f.filename);
    if (!fs.existsSync(diskPath)) continue;
    attachments.push({
      diskPath,
      archivePath: `attachments/files/${f.id}-${f.filename}`,
    });
  }

  return { envelope, attachments };
}

/** Slugify a trip title for the download filename. ASCII-only fallback
 *  so non-Latin titles still produce a usable filename. */
export function makeExportFilename(tripId: number, title: string): string {
  const slug = title
    .toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  const stem = slug.length > 0 ? slug : 'trip';
  return `${stem}-${tripId}.json`;
}
