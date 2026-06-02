import path from 'path';
import fs from 'fs';
import jwt from 'jsonwebtoken';
import { JWT_SECRET } from '../config';
import { db, canAccessTrip } from '../db/database';
import { consumeEphemeralToken } from './ephemeralTokens';
import { TripFile } from '../types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB
export const DEFAULT_ALLOWED_EXTENSIONS = 'jpg,jpeg,png,gif,webp,heic,pdf,doc,docx,xls,xlsx,txt,csv';
export const BLOCKED_EXTENSIONS = ['.svg', '.html', '.htm', '.xml'];
export const filesDir = path.join(__dirname, '../../uploads/files');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function verifyTripAccess(tripId: string | number, userId: number) {
  return canAccessTrip(tripId, userId);
}

export function getAllowedExtensions(): string {
  try {
    const row = db.prepare("SELECT value FROM app_settings WHERE key = 'allowed_file_types'").get() as { value: string } | undefined;
    return row?.value || DEFAULT_ALLOWED_EXTENSIONS;
  } catch { return DEFAULT_ALLOWED_EXTENSIONS; }
}

const FILE_SELECT = `
  SELECT f.*, r.title as reservation_title, u.username as uploaded_by_name, u.avatar as uploaded_by_avatar
  FROM trip_files f
  LEFT JOIN reservations r ON f.reservation_id = r.id
  LEFT JOIN users u ON f.uploaded_by = u.id
`;

// [460-fork] Milestone 13 — the set of file ids visible to a trip via segment
// sharing: files shared directly into a segment the trip is linked to, PLUS
// files attached (directly or via file_links) to a reservation shared into such
// a segment. Three `?` params, each the requesting trip id. Used to widen the
// file list and the download-auth gate — and nothing else widens.
const SHARED_FILE_IDS_SQL = `
  SELECT ssf.file_id FROM segment_shared_files ssf
   WHERE ssf.segment_id IN (SELECT segment_id FROM trip_segments WHERE trip_id = ?)
  UNION
  SELECT tf.id FROM trip_files tf
   WHERE tf.reservation_id IN (
     SELECT ssr.reservation_id FROM segment_shared_reservations ssr
      WHERE ssr.segment_id IN (SELECT segment_id FROM trip_segments WHERE trip_id = ?)
   )
  UNION
  SELECT fl.file_id FROM file_links fl
   WHERE fl.reservation_id IN (
     SELECT ssr.reservation_id FROM segment_shared_reservations ssr
      WHERE ssr.segment_id IN (SELECT segment_id FROM trip_segments WHERE trip_id = ?)
   )
`;

export function formatFile(file: TripFile & { trip_id?: number }) {
  const tripId = file.trip_id;
  return {
    ...file,
    url: `/api/trips/${tripId}/files/${file.id}/download`,
    uploaded_by_avatar: file.uploaded_by_avatar ? `/uploads/avatars/${file.uploaded_by_avatar}` : null,
  };
}

// ---------------------------------------------------------------------------
// File path resolution & validation
// ---------------------------------------------------------------------------

export function resolveFilePath(filename: string): { resolved: string; safe: boolean } {
  const safeName = path.basename(filename);
  const filePath = path.join(filesDir, safeName);
  const resolved = path.resolve(filePath);
  const safe = resolved.startsWith(path.resolve(filesDir));
  return { resolved, safe };
}

// ---------------------------------------------------------------------------
// Token-based download auth
// ---------------------------------------------------------------------------

export function authenticateDownload(bearerToken: string | undefined, queryToken: string | undefined): { userId: number } | { error: string; status: number } {
  if (!bearerToken && !queryToken) {
    return { error: 'Authentication required', status: 401 };
  }

  if (bearerToken) {
    try {
      const decoded = jwt.verify(bearerToken, JWT_SECRET, { algorithms: ['HS256'] }) as { id: number };
      return { userId: decoded.id };
    } catch {
      return { error: 'Invalid or expired token', status: 401 };
    }
  }

  const uid = consumeEphemeralToken(queryToken!, 'download');
  if (!uid) return { error: 'Invalid or expired token', status: 401 };
  return { userId: uid };
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export interface FileLink {
  file_id: number;
  reservation_id: number | null;
  place_id: number | null;
}

export function getFileById(id: string | number, tripId: string | number): TripFile | undefined {
  return db.prepare('SELECT * FROM trip_files WHERE id = ? AND trip_id = ?').get(id, tripId) as TripFile | undefined;
}

// [460-fork] Milestone 13 — download-auth gate that also honours segment shares.
// A file is downloadable by `tripId` if the trip owns it, OR it's shared into a
// segment the trip is linked to (directly, or via an attached shared
// reservation). Owned files keep their original semantics (any state); shared
// files must be non-deleted. Anything else → undefined → 404. Used ONLY by the
// download route; edit/star/delete keep using getFileById (owner-only), so the
// other household can view/download a shared file but not mutate the record.
export function getDownloadableFile(id: string | number, tripId: string | number): TripFile | undefined {
  return db.prepare(`
    SELECT * FROM trip_files
     WHERE id = ?
       AND (
         trip_id = ?
         OR (deleted_at IS NULL AND id IN (${SHARED_FILE_IDS_SQL}))
       )
  `).get(id, tripId, tripId, tripId, tripId) as TripFile | undefined;
}

export function getFileByIdFull(id: string | number): TripFile {
  return db.prepare(`${FILE_SELECT} WHERE f.id = ?`).get(id) as TripFile;
}

export function getDeletedFile(id: string | number, tripId: string | number): TripFile | undefined {
  return db.prepare('SELECT * FROM trip_files WHERE id = ? AND trip_id = ? AND deleted_at IS NOT NULL').get(id, tripId) as TripFile | undefined;
}

export function listFiles(tripId: string | number, showTrash: boolean) {
  // [460-fork] M13 — trash is owner-scoped; only the active list widens to
  // segment-shared files (shared directly, or attached to a shared reservation).
  const files = showTrash
    ? db.prepare(`${FILE_SELECT} WHERE f.trip_id = ? AND f.deleted_at IS NOT NULL ORDER BY f.starred DESC, f.created_at DESC`).all(tripId) as TripFile[]
    : db.prepare(`
        ${FILE_SELECT}
        WHERE f.deleted_at IS NULL
          AND (f.trip_id = ? OR f.id IN (${SHARED_FILE_IDS_SQL}))
        ORDER BY f.starred DESC, f.created_at DESC
      `).all(tripId, tripId, tripId, tripId) as TripFile[];

  const fileIds = files.map(f => f.id);
  let linksMap: Record<number, FileLink[]> = {};
  if (fileIds.length > 0) {
    const placeholders = fileIds.map(() => '?').join(',');
    const links = db.prepare(`SELECT file_id, reservation_id, place_id FROM file_links WHERE file_id IN (${placeholders})`).all(...fileIds) as FileLink[];
    for (const link of links) {
      if (!linksMap[link.file_id]) linksMap[link.file_id] = [];
      linksMap[link.file_id].push(link);
    }
  }

  // [460-fork] M13 — segments each file is directly shared into (toggle state).
  const fileShareMap: Record<number, string[]> = {};
  if (fileIds.length > 0) {
    const ph = fileIds.map(() => '?').join(',');
    const shares = db.prepare(`SELECT file_id, segment_id FROM segment_shared_files WHERE file_id IN (${ph})`).all(...fileIds) as { file_id: number; segment_id: string }[];
    for (const s of shares) {
      if (!fileShareMap[s.file_id]) fileShareMap[s.file_id] = [];
      fileShareMap[s.file_id].push(s.segment_id);
    }
  }

  return files.map(f => {
    const fileLinks = linksMap[f.id] || [];
    // [460-fork] M13 — a shared-in file's native download URL points at the
    // owner's trip, which the requester can't access; rewrite it to the
    // requesting trip so the download route resolves it via getDownloadableFile.
    // Owned files are unaffected (requesting trip === owner trip).
    const owned = Number((f as TripFile & { trip_id?: number }).trip_id) === Number(tripId);
    return {
      ...formatFile(f),
      url: `/api/trips/${tripId}/files/${f.id}/download`,
      owned_by_this_trip: owned ? 1 : 0,
      shared_into_segment: owned ? 0 : 1,
      shared_segment_ids: fileShareMap[f.id] || [],
      linked_reservation_ids: fileLinks.filter(l => l.reservation_id).map(l => l.reservation_id),
      linked_place_ids: fileLinks.filter(l => l.place_id).map(l => l.place_id),
    };
  });
}

export function createFile(
  tripId: string | number,
  file: { filename: string; originalname: string; size: number; mimetype: string },
  uploadedBy: number,
  opts: { place_id?: string | null; reservation_id?: string | null; description?: string | null }
) {
  const result = db.prepare(`
    INSERT INTO trip_files (trip_id, place_id, reservation_id, filename, original_name, file_size, mime_type, description, uploaded_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    tripId,
    opts.place_id || null,
    opts.reservation_id || null,
    file.filename,
    file.originalname,
    file.size,
    file.mimetype,
    opts.description || null,
    uploadedBy
  );

  const created = db.prepare(`${FILE_SELECT} WHERE f.id = ?`).get(result.lastInsertRowid) as TripFile;
  return formatFile(created);
}

export function updateFile(
  id: string | number,
  current: TripFile,
  updates: { description?: string; place_id?: string | null; reservation_id?: string | null }
) {
  db.prepare(`
    UPDATE trip_files SET
      description = ?,
      place_id = ?,
      reservation_id = ?
    WHERE id = ?
  `).run(
    updates.description !== undefined ? updates.description : current.description,
    updates.place_id !== undefined ? (updates.place_id || null) : current.place_id,
    updates.reservation_id !== undefined ? (updates.reservation_id || null) : current.reservation_id,
    id
  );

  const updated = db.prepare(`${FILE_SELECT} WHERE f.id = ?`).get(id) as TripFile;
  return formatFile(updated);
}

export function toggleStarred(id: string | number, currentStarred: number | undefined) {
  const newStarred = currentStarred ? 0 : 1;
  db.prepare('UPDATE trip_files SET starred = ? WHERE id = ?').run(newStarred, id);

  const updated = db.prepare(`${FILE_SELECT} WHERE f.id = ?`).get(id) as TripFile;
  return formatFile(updated);
}

export function softDeleteFile(id: string | number) {
  db.prepare('UPDATE trip_files SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?').run(id);
}

export function restoreFile(id: string | number) {
  db.prepare('UPDATE trip_files SET deleted_at = NULL WHERE id = ?').run(id);
  const restored = db.prepare(`${FILE_SELECT} WHERE f.id = ?`).get(id) as TripFile;
  return formatFile(restored);
}

export function permanentDeleteFile(file: TripFile) {
  const { resolved } = resolveFilePath(file.filename);
  if (fs.existsSync(resolved)) {
    try { fs.unlinkSync(resolved); } catch (e) { console.error('Error deleting file:', e); }
  }
  db.prepare('DELETE FROM trip_files WHERE id = ?').run(file.id);
}

export function emptyTrash(tripId: string | number): number {
  const trashed = db.prepare('SELECT * FROM trip_files WHERE trip_id = ? AND deleted_at IS NOT NULL').all(tripId) as TripFile[];
  for (const file of trashed) {
    const { resolved } = resolveFilePath(file.filename);
    if (fs.existsSync(resolved)) {
      try { fs.unlinkSync(resolved); } catch (e) { console.error('Error deleting file:', e); }
    }
  }
  db.prepare('DELETE FROM trip_files WHERE trip_id = ? AND deleted_at IS NOT NULL').run(tripId);
  return trashed.length;
}

// ---------------------------------------------------------------------------
// File links (many-to-many)
// ---------------------------------------------------------------------------

export function createFileLink(
  fileId: string | number,
  opts: { reservation_id?: string | null; assignment_id?: string | null; place_id?: string | null }
) {
  try {
    db.prepare('INSERT OR IGNORE INTO file_links (file_id, reservation_id, assignment_id, place_id) VALUES (?, ?, ?, ?)').run(
      fileId, opts.reservation_id || null, opts.assignment_id || null, opts.place_id || null
    );
  } catch (err) {
    console.error('[Files] Error creating file link:', err instanceof Error ? err.message : err);
  }
  return db.prepare('SELECT * FROM file_links WHERE file_id = ?').all(fileId);
}

export function deleteFileLink(linkId: string | number, fileId: string | number) {
  db.prepare('DELETE FROM file_links WHERE id = ? AND file_id = ?').run(linkId, fileId);
}

export function getFileLinks(fileId: string | number) {
  return db.prepare(`
    SELECT fl.*, r.title as reservation_title
    FROM file_links fl
    LEFT JOIN reservations r ON fl.reservation_id = r.id
    WHERE fl.file_id = ?
  `).all(fileId);
}
