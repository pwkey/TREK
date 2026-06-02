import express, { Request, Response } from 'express';
import { db } from '../db/database';
import { authenticate } from '../middleware/auth';
import { broadcast } from '../websocket';
import { checkPermission } from '../services/permissions';
import { AuthRequest } from '../types';
import {
  verifyTripAccess,
  listReservations,
  createReservation,
  updatePositions,
  getReservation,
  getReservationForEdit,
  updateReservation,
  deleteReservation,
} from '../services/reservationService';
import { isTripInSegment, shareReservation, unshareReservation } from '../services/segmentShareService';

const router = express.Router({ mergeParams: true });

router.get('/', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId } = req.params;

  const trip = verifyTripAccess(tripId, authReq.user.id);
  if (!trip) return res.status(404).json({ error: 'Trip not found' });

  const reservations = listReservations(tripId);
  res.json({ reservations });
});

router.post('/', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId } = req.params;
  const { title, reservation_time, reservation_end_time, location, confirmation_number, notes, day_id, place_id, assignment_id, status, type, accommodation_id, metadata, create_accommodation, create_budget_entry } = req.body;

  const trip = verifyTripAccess(tripId, authReq.user.id);
  if (!trip) return res.status(404).json({ error: 'Trip not found' });

  if (!checkPermission('reservation_edit', authReq.user.role, trip.user_id, authReq.user.id, trip.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission' });

  if (!title) return res.status(400).json({ error: 'Title is required' });

  const { reservation, accommodationCreated } = createReservation(tripId, {
    title, reservation_time, reservation_end_time, location,
    confirmation_number, notes, day_id, place_id, assignment_id,
    status, type, accommodation_id, metadata, create_accommodation
  });

  if (accommodationCreated) {
    broadcast(tripId, 'accommodation:created', {}, req.headers['x-socket-id'] as string);
  }

  // Auto-create budget entry if price was provided
  if (create_budget_entry && create_budget_entry.total_price > 0) {
    try {
      const { createBudgetItem } = require('../services/budgetService');
      const budgetItem = createBudgetItem(tripId, {
        name: title,
        category: create_budget_entry.category || type || 'Other',
        total_price: create_budget_entry.total_price,
      });
      db.prepare('UPDATE budget_items SET reservation_id = ? WHERE id = ?').run(reservation.id, budgetItem.id);
      budgetItem.reservation_id = reservation.id;
      broadcast(tripId, 'budget:created', { item: budgetItem }, req.headers['x-socket-id'] as string);
    } catch (err) {
      console.error('[reservations] Failed to create budget entry:', err);
    }
  }

  res.status(201).json({ reservation });
  broadcast(tripId, 'reservation:created', { reservation }, req.headers['x-socket-id'] as string);

  // Notify trip members about new booking
  import('../services/notificationService').then(({ send }) => {
    const tripInfo = db.prepare('SELECT title FROM trips WHERE id = ?').get(tripId) as { title: string } | undefined;
    send({ event: 'booking_change', actorId: authReq.user.id, scope: 'trip', targetId: Number(tripId), params: { trip: tripInfo?.title || 'Untitled', actor: authReq.user.email, booking: title, type: type || 'booking', tripId: String(tripId) } }).catch(() => {});
  });
});

// Batch update day_plan_position for multiple reservations (must be before /:id)
router.put('/positions', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId } = req.params;
  const { positions } = req.body;

  const trip = verifyTripAccess(tripId, authReq.user.id);
  if (!trip) return res.status(404).json({ error: 'Trip not found' });

  if (!checkPermission('reservation_edit', authReq.user.role, trip.user_id, authReq.user.id, trip.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission' });

  if (!Array.isArray(positions)) return res.status(400).json({ error: 'positions must be an array' });

  const { day_id } = req.body;
  updatePositions(tripId, positions, day_id);

  res.json({ success: true });
  broadcast(tripId, 'reservation:positions', { positions, day_id }, req.headers['x-socket-id'] as string);
});

router.put('/:id', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId, id } = req.params;
  const { title, reservation_time, reservation_end_time, location, confirmation_number, notes, day_id, place_id, assignment_id, status, type, accommodation_id, metadata, create_accommodation, create_budget_entry } = req.body;

  const trip = verifyTripAccess(tripId, authReq.user.id);
  if (!trip) return res.status(404).json({ error: 'Trip not found' });

  if (!checkPermission('reservation_edit', authReq.user.role, trip.user_id, authReq.user.id, trip.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission' });

  // [460-fork] Milestone 13 — resolve the reservation as owned OR shared into a
  // segment this trip is linked to (co-edit). ownerTripId is its real home; all
  // side-effects (accommodation, budget) stay scoped there, never the editor's
  // trip. A non-shared foreign reservation resolves to undefined → 404 (the
  // write-side leak guard). Delete stays owner-only (uses getReservation).
  const current = getReservationForEdit(id, tripId);
  if (!current) return res.status(404).json({ error: 'Reservation not found' });
  const ownerTripId = (current as unknown as { trip_id: number }).trip_id;
  const isOwnerTrip = String(ownerTripId) === String(tripId);

  const { reservation, accommodationChanged } = updateReservation(id, ownerTripId, {
    title, reservation_time, reservation_end_time, location,
    confirmation_number, notes, day_id, place_id, assignment_id,
    status, type, metadata,
    // [460-fork] M13 — accommodation side-effects are owner-scoped (same fence as
    // the budget side-effects below). A sibling co-editor edits the booking's own
    // fields but must NOT create or relink day_accommodations rows in the owner's
    // trip, so these are stripped for non-owner edits.
    accommodation_id: isOwnerTrip ? accommodation_id : undefined,
    create_accommodation: isOwnerTrip ? create_accommodation : undefined,
  }, current, authReq.user.id);

  if (accommodationChanged) {
    broadcast(ownerTripId, 'accommodation:updated', {}, req.headers['x-socket-id'] as string);
  }

  // Remove linked budget entry if price was cleared (owner trip only — budget
  // lives with the owning household; a sibling co-edit never touches it).
  if (isOwnerTrip && (!create_budget_entry || !create_budget_entry.total_price)) {
    const linked = db.prepare('SELECT id FROM budget_items WHERE trip_id = ? AND reservation_id = ?').get(tripId, id) as { id: number } | undefined;
    if (linked) {
      const { deleteBudgetItem } = require('../services/budgetService');
      deleteBudgetItem(linked.id, tripId);
      broadcast(tripId, 'budget:deleted', { id: linked.id }, req.headers['x-socket-id'] as string);
    }
  }

  // Auto-create or update budget entry if price was provided (owner trip only)
  if (isOwnerTrip && create_budget_entry && create_budget_entry.total_price > 0) {
    try {
      const { createBudgetItem, updateBudgetItem } = require('../services/budgetService');
      const itemName = title || current.title;
      const existing = db.prepare('SELECT id FROM budget_items WHERE trip_id = ? AND reservation_id = ?').get(tripId, id) as { id: number } | undefined;
      if (existing) {
        const updated = updateBudgetItem(existing.id, tripId, {
          name: itemName,
          category: create_budget_entry.category || type || current.type || 'Other',
          total_price: create_budget_entry.total_price,
        });
        broadcast(tripId, 'budget:updated', { item: updated }, req.headers['x-socket-id'] as string);
      } else {
        const budgetItem = createBudgetItem(tripId, {
          name: itemName,
          category: create_budget_entry.category || type || current.type || 'Other',
          total_price: create_budget_entry.total_price,
        });
        db.prepare('UPDATE budget_items SET reservation_id = ? WHERE id = ?').run(id, budgetItem.id);
        budgetItem.reservation_id = Number(id);
        broadcast(tripId, 'budget:created', { item: budgetItem }, req.headers['x-socket-id'] as string);
      }
    } catch (err) {
      console.error('[reservations] Failed to create/update budget entry:', err);
    }
  }

  res.json({ reservation });
  // Notify the owning trip's room, and (for a sibling co-edit) the editor's too.
  broadcast(ownerTripId, 'reservation:updated', { reservation }, req.headers['x-socket-id'] as string);
  if (!isOwnerTrip) broadcast(tripId, 'reservation:updated', { reservation }, req.headers['x-socket-id'] as string);

  import('../services/notificationService').then(({ send }) => {
    const tripInfo = db.prepare('SELECT title FROM trips WHERE id = ?').get(ownerTripId) as { title: string } | undefined;
    send({ event: 'booking_change', actorId: authReq.user.id, scope: 'trip', targetId: Number(ownerTripId), params: { trip: tripInfo?.title || 'Untitled', actor: authReq.user.email, booking: title || current.title, type: type || current.type || 'booking', tripId: String(ownerTripId) } }).catch(() => {});
  });
});

router.delete('/:id', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId, id } = req.params;

  const trip = verifyTripAccess(tripId, authReq.user.id);
  if (!trip) return res.status(404).json({ error: 'Trip not found' });

  if (!checkPermission('reservation_edit', authReq.user.role, trip.user_id, authReq.user.id, trip.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission' });

  const { deleted: reservation, accommodationDeleted } = deleteReservation(id, tripId);
  if (!reservation) return res.status(404).json({ error: 'Reservation not found' });

  if (accommodationDeleted) {
    broadcast(tripId, 'accommodation:deleted', { accommodationId: reservation.accommodation_id }, req.headers['x-socket-id'] as string);
  }

  res.json({ success: true });
  broadcast(tripId, 'reservation:deleted', { reservationId: Number(id) }, req.headers['x-socket-id'] as string);

  import('../services/notificationService').then(({ send }) => {
    const tripInfo = db.prepare('SELECT title FROM trips WHERE id = ?').get(tripId) as { title: string } | undefined;
    send({ event: 'booking_change', actorId: authReq.user.id, scope: 'trip', targetId: Number(tripId), params: { trip: tripInfo?.title || 'Untitled', actor: authReq.user.email, booking: reservation.title, type: reservation.type || 'booking', tripId: String(tripId) } }).catch(() => {});
  });
});

// [460-fork] Milestone 13 — opt-in: share this booking into a segment so every
// trip linked to the segment can see (and, from slice 2, co-edit) it. Owner-only:
// the reservation must belong to :tripId, the caller needs reservation_edit, and
// :tripId must actually be part of the segment. Idempotency is handled by the
// global X-Client-Mutation-Id middleware + the UNIQUE(segment_id, reservation_id).
router.post('/:id/share', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId, id } = req.params;
  const { segment_id } = req.body;

  const trip = verifyTripAccess(tripId, authReq.user.id);
  if (!trip) return res.status(404).json({ error: 'Trip not found' });
  if (!checkPermission('reservation_edit', authReq.user.role, trip.user_id, authReq.user.id, trip.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission' });

  if (!segment_id) return res.status(400).json({ error: 'segment_id is required' });

  // Owner-only: the reservation must live in this trip.
  const reservation = getReservation(id, tripId);
  if (!reservation) return res.status(404).json({ error: 'Reservation not found' });

  // ...and this trip must be part of the segment it's being shared into.
  if (!isTripInSegment(tripId, segment_id)) return res.status(403).json({ error: 'Trip is not part of this segment' });

  shareReservation(segment_id, id, authReq.user.id);
  res.json({ success: true, segment_id, reservation_id: Number(id) });
  broadcast(tripId, 'reservation:shared', { reservationId: Number(id), segmentId: segment_id }, req.headers['x-socket-id'] as string);
});

// [460-fork] Milestone 13 — un-share (owner-only, same checks as share).
router.delete('/:id/share', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId, id } = req.params;
  const { segment_id } = req.body;

  const trip = verifyTripAccess(tripId, authReq.user.id);
  if (!trip) return res.status(404).json({ error: 'Trip not found' });
  if (!checkPermission('reservation_edit', authReq.user.role, trip.user_id, authReq.user.id, trip.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission' });

  if (!segment_id) return res.status(400).json({ error: 'segment_id is required' });

  const reservation = getReservation(id, tripId);
  if (!reservation) return res.status(404).json({ error: 'Reservation not found' });

  unshareReservation(segment_id, id);
  res.json({ success: true });
  broadcast(tripId, 'reservation:unshared', { reservationId: Number(id), segmentId: segment_id }, req.headers['x-socket-id'] as string);
});

export default router;
