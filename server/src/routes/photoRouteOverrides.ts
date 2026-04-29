// [460-fork] M6 follow-up — per-segment photo-route waypoint override endpoints.
//
// GET    /api/trips/:tripId/photo-route-overrides
// PUT    /api/trips/:tripId/photo-route-overrides/:fromId/:toId  { waypoints: [[lat,lng], ...] }
// DELETE /api/trips/:tripId/photo-route-overrides/:fromId/:toId
//
// Mutation idempotency is handled by the global X-Client-Mutation-Id
// middleware so the offline queue can retry safely.
import express, { Request, Response } from 'express';
import { authenticate } from '../middleware/auth';
import { broadcast } from '../websocket';
import { checkPermission } from '../services/permissions';
import { AuthRequest } from '../types';
import * as svc from '../services/photoRouteOverridesService';

const router = express.Router({ mergeParams: true });

router.get('/', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId } = req.params;
  if (!svc.verifyTripAccess(tripId, authReq.user.id)) {
    return res.status(404).json({ error: 'Trip not found' });
  }
  res.json({ overrides: svc.listOverrides(Number(tripId)) });
});

router.put('/:fromId/:toId', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId, fromId, toId } = req.params;
  const access = svc.verifyTripAccess(tripId, authReq.user.id);
  if (!access) return res.status(404).json({ error: 'Trip not found' });
  if (!checkPermission('day_edit', authReq.user.role, access.user_id, authReq.user.id, access.user_id !== authReq.user.id)) {
    return res.status(403).json({ error: 'No permission' });
  }

  const fromPhotoId = Number(fromId);
  const toPhotoId = Number(toId);
  if (!Number.isInteger(fromPhotoId) || !Number.isInteger(toPhotoId)) {
    return res.status(400).json({ error: 'invalid photo ids' });
  }
  if (!svc.photosBelongToTrip(tripId, fromPhotoId, toPhotoId)) {
    return res.status(404).json({ error: 'one or both photos not in trip' });
  }

  const validated = svc.validateWaypoints((req.body ?? {}).waypoints);
  if (!validated.ok) return res.status(400).json({ error: validated.error });

  const override = svc.upsertOverride(Number(tripId), fromPhotoId, toPhotoId, validated.waypoints, authReq.user.id);
  res.json({ override });
  broadcast(tripId, 'photoRouteOverride:updated', { override }, req.headers['x-socket-id'] as string);
});

router.delete('/:fromId/:toId', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId, fromId, toId } = req.params;
  const access = svc.verifyTripAccess(tripId, authReq.user.id);
  if (!access) return res.status(404).json({ error: 'Trip not found' });
  if (!checkPermission('day_edit', authReq.user.role, access.user_id, authReq.user.id, access.user_id !== authReq.user.id)) {
    return res.status(403).json({ error: 'No permission' });
  }

  const fromPhotoId = Number(fromId);
  const toPhotoId = Number(toId);
  if (!Number.isInteger(fromPhotoId) || !Number.isInteger(toPhotoId)) {
    return res.status(400).json({ error: 'invalid photo ids' });
  }

  const removed = svc.deleteOverride(Number(tripId), fromPhotoId, toPhotoId);
  res.json({ removed });
  broadcast(tripId, 'photoRouteOverride:deleted', { from_photo_id: fromPhotoId, to_photo_id: toPhotoId }, req.headers['x-socket-id'] as string);
});

export default router;
