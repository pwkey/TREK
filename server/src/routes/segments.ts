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
// [460-fork] Q13 — accepts EITHER `target_trip_id` (existing trip) OR
// `new_trip_title` (guided creation: server spins up a stub trip on the
// segment's date range and links it).
router.post('/accept', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { token, target_trip_id, new_trip_title } = req.body ?? {};
  if (typeof token !== 'string') {
    return res.status(400).json({ error: 'token required', code: 'INVALID_INPUT' });
  }
  if (typeof target_trip_id !== 'number' && (typeof new_trip_title !== 'string' || !new_trip_title.trim())) {
    return res.status(400).json({ error: 'Either target_trip_id or new_trip_title required', code: 'INVALID_INPUT' });
  }
  const result = segmentService.acceptInvite({
    token,
    userId: authReq.user.id,
    targetTripId: typeof target_trip_id === 'number' ? target_trip_id : undefined,
    newTripTitle: typeof new_trip_title === 'string' ? new_trip_title : undefined,
  });
  if ('error' in result) return sendErr(res, result);
  writeAudit({ userId: authReq.user.id, action: 'segment.accept', ip: getClientIp(req), details: { segmentId: result.segment.id, targetTripId: target_trip_id ?? null, newTripTitle: new_trip_title ?? null } });
  // The "attached trip id" the broadcast cares about is whichever trip ended
  // up linked — either the existing one the caller picked, or the freshly
  // minted stub. result.linked_trip_ids contains all of them.
  const attachedTripId = typeof target_trip_id === 'number' ? target_trip_id : result.linked_trip_ids[result.linked_trip_ids.length - 1];
  const payload = { segmentId: result.segment.id, attachedTripId };
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
