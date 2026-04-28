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
import { authenticate } from '../middleware/auth';
import { canAccessTrip, db } from '../db/database';
import { AuthRequest } from '../types';
import { exportTrip, makeExportFilename } from '../services/exportService';

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

export default router;
