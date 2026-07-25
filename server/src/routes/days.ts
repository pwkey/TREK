import express, { Request, Response } from 'express';
import { authenticate } from '../middleware/auth';
import { requireTripAccess } from '../middleware/tripAccess';
import { broadcast, broadcastDay, broadcastDayById } from '../websocket';
import { checkPermission } from '../services/permissions';
import { AuthRequest } from '../types';
import * as dayService from '../services/dayService';
import { parkAsConflict } from '../services/conflictsService'; // [460-fork] Milestone 5 slice 4

const router = express.Router({ mergeParams: true });

router.get('/', authenticate, requireTripAccess, (req: Request, res: Response) => {
  const { tripId } = req.params;
  res.json(dayService.listDays(tripId));
});

router.post('/', authenticate, requireTripAccess, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  if (!checkPermission('day_edit', authReq.user.role, authReq.trip!.user_id, authReq.user.id, authReq.trip!.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission' });

  const { tripId } = req.params;
  const { date, notes } = req.body;

  const day = dayService.createDay(tripId, date, notes);
  res.status(201).json({ day });
  // [460-fork] day:created is always trip-scoped — a newly-created day cannot
  // yet be part of a segment, so a plain trip broadcast is correct.
  broadcast(tripId, 'day:created', { day }, req.headers['x-socket-id'] as string);
});

// [460-fork] Q11 — convenience endpoints for the day-list "+ Add day"
// affordance. The end variant matches POST / above but auto-inherits the
// date from the last day (+1 calendar day). The start variant shifts the
// existing day_numbers up by one before inserting at position 1.
router.post('/at-end', authenticate, requireTripAccess, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  if (!checkPermission('day_edit', authReq.user.role, authReq.trip!.user_id, authReq.user.id, authReq.trip!.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission' });
  const { tripId } = req.params;
  const day = dayService.addDayAtEnd(tripId, req.body?.notes);
  res.status(201).json({ day });
  broadcast(tripId, 'day:created', { day }, req.headers['x-socket-id'] as string);
});

router.post('/at-start', authenticate, requireTripAccess, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  if (!checkPermission('day_edit', authReq.user.role, authReq.trip!.user_id, authReq.user.id, authReq.trip!.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission' });
  const { tripId } = req.params;
  const day = dayService.addDayAtStart(tripId, req.body?.notes);
  res.status(201).json({ day });
  // Renumbering shifted every other day's day_number. Emit day:created for
  // the new day; the client's sort-by-day_number in remoteEventHandler keeps
  // visual order correct. Other clients may see stale numbers until they
  // refetch (e.g. on next focus / reconnect). Acceptable for this affordance.
  broadcast(tripId, 'day:created', { day }, req.headers['x-socket-id'] as string);
});

// [460-fork] Insert a day in the middle (after :dayId), pushing later days back.
router.post('/:dayId/insert-after', authenticate, requireTripAccess, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  if (!checkPermission('day_edit', authReq.user.role, authReq.trip!.user_id, authReq.user.id, authReq.trip!.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission' });
  const { tripId, dayId } = req.params;
  const result = dayService.insertDayAfter(tripId, dayId);
  if ('error' in result) {
    if (result.error === 'DAY_NOT_FOUND') return res.status(404).json({ error: 'Day not found' });
    if (result.error === 'SEGMENT_BLOCKS_INSERT')
      return res.status(409).json({ error: 'Cannot insert here — later days are part of a shared segment.', code: 'SEGMENT_BLOCKS_INSERT' });
    return res.status(400).json({ error: 'Could not insert day' });
  }
  res.status(201).json({ day: result.day });
  broadcast(tripId, 'day:created', { day: result.day }, req.headers['x-socket-id'] as string);
});

router.put('/:id', authenticate, requireTripAccess, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  if (!checkPermission('day_edit', authReq.user.role, authReq.trip!.user_id, authReq.user.id, authReq.trip!.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission' });

  const { tripId, id } = req.params;

  // [460-fork] getAccessibleDay lets any linked-trip member edit a shared day.
  const current = dayService.getAccessibleDay(id, tripId);
  if (!current) return res.status(404).json({ error: 'Day not found' });

  // [460-fork] Milestone 5 slice 4 — stale-write precondition. If the queued
  // mutation observed an older updated_at than the server now has, park it
  // as a conflict for the user to resolve via Settings → Pending conflicts.
  const observed = req.header('If-Unmodified-Since')?.trim();
  if (observed && current.updated_at && observed !== current.updated_at) {
    const mutationId = (req.header('X-Client-Mutation-Id') || '').trim();
    if (mutationId) {
      const conflictId = parkAsConflict({
        userId: authReq.user.id,
        clientMutationId: mutationId,
        endpoint: req.path,
        method: 'PUT',
        recordType: 'day',
        recordId: Number(id),
        minePayload: req.body,
        theirsSnapshot: { id: current.id, title: current.title, notes: current.notes, updated_at: current.updated_at },
        observedUpdatedAt: observed,
        serverUpdatedAt: current.updated_at,
      });
      return res.status(409).json({
        error: 'Record was updated since you queued this change',
        code: 'STALE_WRITE',
        conflict_id: conflictId,
      });
    }
  }

  const { notes, title } = req.body;
  const day = dayService.updateDay(id, current, { notes, title });
  res.json({ day });
  broadcastDay(day as any, 'day:updated', { day }, req.headers['x-socket-id'] as string);
});

// [460-fork] Quick-jump sections — set/clear a day's section label without
// disturbing its notes/title (the PUT above always rewrites both).
router.put('/:id/section', authenticate, requireTripAccess, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  if (!checkPermission('day_edit', authReq.user.role, authReq.trip!.user_id, authReq.user.id, authReq.trip!.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission' });

  const { tripId, id } = req.params;
  const current = dayService.getAccessibleDay(id, tripId);
  if (!current) return res.status(404).json({ error: 'Day not found' });

  const label = typeof req.body?.section_label === 'string' ? req.body.section_label : null;
  const day = dayService.setDaySection(id, label);
  res.json({ day });
  broadcastDay(day as any, 'day:updated', { day }, req.headers['x-socket-id'] as string);
});

router.delete('/:id', authenticate, requireTripAccess, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  if (!checkPermission('day_edit', authReq.user.role, authReq.trip!.user_id, authReq.user.id, authReq.trip!.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission' });

  const { tripId, id } = req.params;

  // [460-fork] Delete of a shared day is intentionally restricted to the home
  // trip. Sibling trips that want to stop seeing the day use the leave-segment
  // flow instead; strict getDay enforces this (returns null for a non-home caller).
  const existing = dayService.getDay(id, tripId);
  if (!existing) return res.status(404).json({ error: 'Day not found' });

  dayService.deleteDay(id);
  res.json({ success: true });
  broadcastDay(existing, 'day:deleted', { dayId: Number(id) }, req.headers['x-socket-id'] as string);
});

// ---------------------------------------------------------------------------
// Accommodations sub-router
// ---------------------------------------------------------------------------

const accommodationsRouter = express.Router({ mergeParams: true });

accommodationsRouter.get('/', authenticate, requireTripAccess, (req: Request, res: Response) => {
  const { tripId } = req.params;
  res.json({ accommodations: dayService.listAccommodations(tripId) });
});

accommodationsRouter.post('/', authenticate, requireTripAccess, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  if (!checkPermission('day_edit', authReq.user.role, authReq.trip!.user_id, authReq.user.id, authReq.trip!.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission' });

  const { tripId } = req.params;
  const { place_id, start_day_id, end_day_id, check_in, check_out, confirmation, notes } = req.body;

  if (!place_id || !start_day_id || !end_day_id) {
    return res.status(400).json({ error: 'place_id, start_day_id, and end_day_id are required' });
  }

  const errors = dayService.validateAccommodationRefs(tripId, place_id, start_day_id, end_day_id);
  if (errors.length > 0) return res.status(404).json({ error: errors[0].message });

  const accommodation = dayService.createAccommodation(tripId, { place_id, start_day_id, end_day_id, check_in, check_out, confirmation, notes });
  res.status(201).json({ accommodation });
  broadcast(tripId, 'accommodation:created', { accommodation }, req.headers['x-socket-id'] as string);
  broadcast(tripId, 'reservation:created', {}, req.headers['x-socket-id'] as string);
});

accommodationsRouter.put('/:id', authenticate, requireTripAccess, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  if (!checkPermission('day_edit', authReq.user.role, authReq.trip!.user_id, authReq.user.id, authReq.trip!.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission' });

  const { tripId, id } = req.params;

  const existing = dayService.getAccommodation(id, tripId);
  if (!existing) return res.status(404).json({ error: 'Accommodation not found' });

  const { place_id, start_day_id, end_day_id, check_in, check_out, confirmation, notes } = req.body;

  const errors = dayService.validateAccommodationRefs(tripId, place_id, start_day_id, end_day_id);
  if (errors.length > 0) return res.status(404).json({ error: errors[0].message });

  const accommodation = dayService.updateAccommodation(id, existing, { place_id, start_day_id, end_day_id, check_in, check_out, confirmation, notes });
  res.json({ accommodation });
  broadcast(tripId, 'accommodation:updated', { accommodation }, req.headers['x-socket-id'] as string);
});

accommodationsRouter.delete('/:id', authenticate, requireTripAccess, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  if (!checkPermission('day_edit', authReq.user.role, authReq.trip!.user_id, authReq.user.id, authReq.trip!.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission' });

  const { tripId, id } = req.params;

  if (!dayService.getAccommodation(id, tripId)) return res.status(404).json({ error: 'Accommodation not found' });

  const { linkedReservationId } = dayService.deleteAccommodation(id);
  if (linkedReservationId) {
    broadcast(tripId, 'reservation:deleted', { reservationId: linkedReservationId }, req.headers['x-socket-id'] as string);
  }

  res.json({ success: true });
  broadcast(tripId, 'accommodation:deleted', { accommodationId: Number(id) }, req.headers['x-socket-id'] as string);
});

export default router;
export { accommodationsRouter };
