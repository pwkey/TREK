// [460-fork] M6 follow-up — GPX track endpoints.
//
// POST   /api/trips/:tripId/gpx-tracks       multipart upload (field: file, optional: name)
// GET    /api/trips/:tripId/gpx-tracks       list
// PATCH  /api/trips/:tripId/gpx-tracks/:id   rename       { name }
// DELETE /api/trips/:tripId/gpx-tracks/:id   remove
import express, { Request, Response } from 'express';
import multer from 'multer';
import { authenticate } from '../middleware/auth';
import { broadcast } from '../websocket';
import { checkPermission } from '../services/permissions';
import { AuthRequest } from '../types';
import * as svc from '../services/gpxTracksService';

const router = express.Router({ mergeParams: true });

// 5 MB cap — covers a multi-day track from a phone GPS at 1Hz
// recording with margin to spare; rejects clearly-bogus uploads.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

router.get('/', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId } = req.params;
  if (!svc.verifyTripAccess(tripId, authReq.user.id)) return res.status(404).json({ error: 'Trip not found' });
  res.json({ tracks: svc.listTracks(Number(tripId)) });
});

router.post('/', authenticate, upload.single('file'), (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId } = req.params;
  const access = svc.verifyTripAccess(tripId, authReq.user.id);
  if (!access) return res.status(404).json({ error: 'Trip not found' });
  if (!checkPermission('place_edit', authReq.user.role, access.user_id, authReq.user.id, access.user_id !== authReq.user.id)) {
    return res.status(403).json({ error: 'No permission' });
  }

  const file = (req as { file?: { buffer: Buffer; originalname: string } }).file;
  if (!file) return res.status(400).json({ error: 'No file uploaded' });

  const parsed = svc.parseGpxBytes(file.buffer);
  if (!parsed) return res.status(400).json({ error: 'Could not extract any track points from this GPX file' });

  // Name resolution: explicit body field beats <trk><name> beats the
  // uploaded filename minus extension. Falls back to "GPX track" so
  // the row always has something to display.
  const explicitName = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  const fallback = (file.originalname || '').replace(/\.gpx$/i, '').trim();
  const name = explicitName || parsed.trackName || fallback || 'GPX track';

  const track = svc.createTrack(Number(tripId), name, parsed.points, authReq.user.id);
  res.status(201).json({ track });
  broadcast(tripId, 'gpxTrack:created', { track }, req.headers['x-socket-id'] as string);
});

router.patch('/:id', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId, id } = req.params;
  const access = svc.verifyTripAccess(tripId, authReq.user.id);
  if (!access) return res.status(404).json({ error: 'Trip not found' });
  if (!checkPermission('place_edit', authReq.user.role, access.user_id, authReq.user.id, access.user_id !== authReq.user.id)) {
    return res.status(403).json({ error: 'No permission' });
  }

  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  if (!name) return res.status(400).json({ error: 'name is required' });

  const track = svc.renameTrack(Number(tripId), Number(id), name);
  if (!track) return res.status(404).json({ error: 'Track not found' });
  res.json({ track });
  broadcast(tripId, 'gpxTrack:updated', { track }, req.headers['x-socket-id'] as string);
});

router.delete('/:id', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId, id } = req.params;
  const access = svc.verifyTripAccess(tripId, authReq.user.id);
  if (!access) return res.status(404).json({ error: 'Trip not found' });
  if (!checkPermission('place_edit', authReq.user.role, access.user_id, authReq.user.id, access.user_id !== authReq.user.id)) {
    return res.status(403).json({ error: 'No permission' });
  }

  const removed = svc.deleteTrack(Number(tripId), Number(id));
  if (!removed) return res.status(404).json({ error: 'Track not found' });
  res.json({ removed: true });
  broadcast(tripId, 'gpxTrack:deleted', { id: Number(id) }, req.headers['x-socket-id'] as string);
});

export default router;
