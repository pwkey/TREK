// [460-fork] Milestone 7 slice 1 — JSON export of a single trip.
//
// GET /api/trips/:tripId/export
//   → 200 application/json with Content-Disposition: attachment.
//
// Permission: any trip member or owner. The export envelope includes
// member emails (per CLAUDE.md §8.3) since members of the trip are
// expected to know each other's contact details — but no password
// hashes, api keys, or session tokens.
import express, { Request, Response } from 'express';
import archiver from 'archiver';
import path from 'node:path';
import fs from 'node:fs';
import { authenticate } from '../middleware/auth';
import { canAccessTrip, db } from '../db/database';
import { AuthRequest } from '../types';
import { exportTrip, planTripBundle, makeExportFilename } from '../services/exportService';

// [460-fork] Milestone 7 slice 5 — bundle the standalone viewer alongside
// every export. The viewer is a self-contained HTML file built by the
// client at npm prebuild time. We look in dev (client/public) first
// then prod (client/dist) so this works in both layouts.
function findViewerHtml(): string | null {
  const candidates = [
    path.resolve(__dirname, '../../../client/public/viewer.html'),
    path.resolve(__dirname, '../../../client/dist/viewer.html'),
    path.resolve(__dirname, '../../public/viewer.html'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

const router = express.Router({ mergeParams: true });

router.get('/:tripId/export', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const tripId = Number(req.params.tripId);
  if (!Number.isFinite(tripId)) return res.status(400).json({ error: 'Invalid trip id' });
  if (!canAccessTrip(tripId, authReq.user.id)) return res.status(404).json({ error: 'Trip not found' });

  // Fetch the exporter row fresh — req.user has id but not the joined
  // username/email needed for the envelope.
  const exporter = db.prepare('SELECT id, username, email FROM users WHERE id = ?').get(authReq.user.id) as { id: number; username: string; email: string } | undefined;
  if (!exporter) return res.status(401).json({ error: 'Authentication required' });

  let envelope;
  try {
    envelope = exportTrip(tripId, exporter);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Export failed';
    if (/not found/i.test(msg)) return res.status(404).json({ error: msg });
    throw err;
  }

  const filename = makeExportFilename(tripId, envelope.trip.title);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  // Pretty-print so a human opening the .json in a text editor can read
  // it. Doubles file size vs minified, but archive use case wants
  // readability.
  res.send(JSON.stringify(envelope, null, 2));
});

// [460-fork] Milestone 7 slice 2 — bundle (.zip with attachments).
//
// GET /api/trips/:tripId/export/bundle
//   → 200 application/zip with Content-Disposition: attachment.
//
// The zip contains:
//   trip.json                       same envelope as /export, plus an
//                                   `attachment_path` on each photo
//                                   pointing into attachments/.
//   attachments/photos/<id>-<...>   day photo binaries
//   attachments/files/<id>-<...>    reservation-linked file binaries
//
// Streamed directly to the response so big trips don't eat memory.
router.get('/:tripId/export/bundle', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const tripId = Number(req.params.tripId);
  if (!Number.isFinite(tripId)) return res.status(400).json({ error: 'Invalid trip id' });
  if (!canAccessTrip(tripId, authReq.user.id)) return res.status(404).json({ error: 'Trip not found' });

  const exporter = db.prepare('SELECT id, username, email FROM users WHERE id = ?').get(authReq.user.id) as { id: number; username: string; email: string } | undefined;
  if (!exporter) return res.status(401).json({ error: 'Authentication required' });

  let plan;
  try {
    plan = planTripBundle(tripId, exporter);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Export failed';
    if (/not found/i.test(msg)) return res.status(404).json({ error: msg });
    throw err;
  }

  const filenameJson = makeExportFilename(tripId, plan.envelope.trip.title);
  const filenameZip = filenameJson.replace(/\.json$/, '.zip');
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${filenameZip}"`);

  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('error', (err) => {
    // Headers may already be flushed; nothing useful to surface to the
    // client beyond aborting the stream. Log via the standard error
    // path so this shows up in the dev server output.
    console.error('[export/bundle] archive error:', err);
    res.end();
  });
  archive.pipe(res);

  archive.append(JSON.stringify(plan.envelope, null, 2), { name: 'trip.json' });
  // Ship the standalone offline viewer alongside every bundle so a
  // user with just bundle.zip always has the rendering tool. If the
  // file isn't present (e.g. fresh checkout where prebuild hasn't run
  // yet), degrade silently — the bundle still imports + restores fine
  // without it; the viewer is a convenience for fully-offline review.
  const viewerPath = findViewerHtml();
  if (viewerPath) archive.file(viewerPath, { name: 'viewer.html' });
  for (const att of plan.attachments) {
    archive.file(att.diskPath, { name: att.archivePath });
  }
  archive.finalize();
});

export default router;
