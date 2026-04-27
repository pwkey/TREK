// [460-fork] Shared segments (Milestone 4) — REST endpoints.
import express, { Request, Response } from 'express';
import { authenticate } from '../middleware/auth';
import { AuthRequest } from '../types';
import { writeAudit, getClientIp } from '../services/auditLog';
import { broadcast } from '../websocket';
import * as segmentService from '../services/segmentService';

const router = express.Router();

function sendErr(res: Response, err: segmentService.SegmentServiceError) {
  return res.status(err.status).json({ error: err.error, code: err.code });
}

// Create a segment from a contiguous set of days on a trip the caller owns.
router.post('/', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { trip_id, day_ids, title } = req.body ?? {};
  if (typeof trip_id !== 'number' || !Array.isArray(day_ids) || typeof title !== 'string' || !title.trim()) {
    return res.status(400).json({ error: 'trip_id, day_ids[], title required', code: 'INVALID_INPUT' });
  }
  const result = segmentService.createSegment({ userId: authReq.user.id, tripId: trip_id, dayIds: day_ids, title: title.trim() });
  if ('error' in result) return sendErr(res, result);
  writeAudit({ userId: authReq.user.id, action: 'segment.create', ip: getClientIp(req), details: { segmentId: result.segment.id, tripId: trip_id, dayCount: day_ids.length } });
  res.status(201).json(result);
});

router.get('/:id', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const result = segmentService.getSegment(req.params.id, authReq.user.id);
  if ('error' in result) return sendErr(res, result);
  res.json(result);
});

// Preview an invite by token (for the accept page). Minimal data; no
// sibling-trip PII. Any authenticated user can hit this with a valid token.
router.get('/invite/:token', authenticate, (req: Request, res: Response) => {
  const result = segmentService.getInvitePreview(req.params.token);
  if ('error' in result) return sendErr(res, result);
  res.json(result);
});

// Mint an invite link. Only a linked-trip owner can create invites (OQ-F).
router.post('/:id/invites', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const result = segmentService.createInvite({ segmentId: req.params.id, userId: authReq.user.id });
  if ('error' in result) return sendErr(res, result);
  writeAudit({ userId: authReq.user.id, action: 'segment.invite_create', ip: getClientIp(req), details: { segmentId: req.params.id, inviteId: result.id } });
  res.status(201).json(result);
});

// Accept an invite: attach the caller's target trip to the segment.
router.post('/accept', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { token, target_trip_id } = req.body ?? {};
  if (typeof token !== 'string' || typeof target_trip_id !== 'number') {
    return res.status(400).json({ error: 'token and target_trip_id required', code: 'INVALID_INPUT' });
  }
  const result = segmentService.acceptInvite({ token, userId: authReq.user.id, targetTripId: target_trip_id });
  if ('error' in result) return sendErr(res, result);
  writeAudit({ userId: authReq.user.id, action: 'segment.accept', ip: getClientIp(req), details: { segmentId: result.segment.id, targetTripId: target_trip_id } });
  // Tell every linked trip (including the new one) to refresh — days are
  // about to appear on the new side, and existing sides may want to see the
  // "now linked with N trips" update. Payload key is `attachedTripId` to
  // avoid colliding with the room-scoped `tripId` the broadcast helper
  // stamps on the wire event.
  const payload = { segmentId: result.segment.id, attachedTripId: target_trip_id };
  for (const linkedTripId of result.linked_trip_ids) {
    broadcast(linkedTripId, 'segment:attached', payload, req.headers['x-socket-id'] as string);
  }
  res.json(result);
});

// Dissolve a segment outright (home-owner only). Clones the days into every
// sibling trip as memento and deletes the segment record. Used when siblings
// won't leave on their own and the home owner needs to free up the trip.
router.delete('/:id', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const tripsToNotify = segmentService.listTripIdsForSegment(req.params.id);
  const result = segmentService.dissolveSegment({ segmentId: req.params.id, userId: authReq.user.id });
  if ('error' in result) return sendErr(res, result);
  writeAudit({ userId: authReq.user.id, action: 'segment.dissolve', ip: getClientIp(req), details: { segmentId: req.params.id, sibling_trip_count: Object.keys(result.cloned_by_trip).length } });
  const payload = { segmentId: req.params.id, dissolved: true };
  for (const linkedTripId of tripsToNotify) {
    broadcast(linkedTripId, 'segment:detached', payload, req.headers['x-socket-id'] as string);
  }
  res.json(result);
});

// Leave a segment (non-home only). Clones the segment days into plain trip-owned rows.
router.delete('/:id/trips/:tripId', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const tripId = Number(req.params.tripId);
  if (!Number.isFinite(tripId)) return res.status(400).json({ error: 'Invalid trip id', code: 'INVALID_INPUT' });
  // Capture every linked trip BEFORE the leave so we can notify even when the
  // segment auto-dissolves (in which case listTripIdsForSegment returns []
  // afterwards and the home trip would otherwise miss the event).
  const tripsToNotify = segmentService.listTripIdsForSegment(req.params.id);
  const result = segmentService.removeTripFromSegment({ segmentId: req.params.id, tripId, userId: authReq.user.id });
  if ('error' in result) return sendErr(res, result);
  writeAudit({ userId: authReq.user.id, action: 'segment.leave', ip: getClientIp(req), details: { segmentId: req.params.id, tripId, clonedDayCount: result.cloned_day_ids.length, dissolved: result.dissolved } });
  const payload = { segmentId: req.params.id, leftTripId: tripId, dissolved: result.dissolved };
  for (const linkedTripId of tripsToNotify) {
    broadcast(linkedTripId, 'segment:detached', payload, req.headers['x-socket-id'] as string);
  }
  res.json(result);
});

export default router;
