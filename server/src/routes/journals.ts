// [460-fork] Milestone 6 slice 1 — per-day journal endpoints.
//
// GET  /api/trips/:tripId/days/:dayId/journal  → { journal | null }
// PUT  /api/trips/:tripId/days/:dayId/journal  → upsert content_markdown
//
// PUT supports the M5 slice 4 stale-write precondition: callers send
// If-Unmodified-Since with the journal's previously-observed updated_at;
// on mismatch the mutation parks as a conflict for the user to resolve via
// the conflicts panel.
import express, { Request, Response } from 'express';
import { authenticate } from '../middleware/auth';
import { broadcast } from '../websocket';
import { checkPermission } from '../services/permissions';
import { AuthRequest } from '../types';
import * as journalService from '../services/journalService';
import { parkAsConflict } from '../services/conflictsService';

const MAX_JOURNAL_BYTES = 100_000;

const router = express.Router({ mergeParams: true });

router.get('/', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId, dayId } = req.params;
  if (!journalService.verifyTripAccess(tripId, authReq.user.id)) return res.status(404).json({ error: 'Trip not found' });
  if (!journalService.dayAccessible(dayId, tripId)) return res.status(404).json({ error: 'Day not found' });
  res.json({ journal: journalService.getJournal(Number(dayId)) });
});

router.put('/', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId, dayId } = req.params;
  const access = journalService.verifyTripAccess(tripId, authReq.user.id);
  if (!access) return res.status(404).json({ error: 'Trip not found' });
  if (!checkPermission('day_edit', authReq.user.role, access.user_id, authReq.user.id, access.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission' });
  if (!journalService.dayAccessible(dayId, tripId)) return res.status(404).json({ error: 'Day not found' });

  const { content_markdown } = req.body ?? {};
  if (typeof content_markdown !== 'string') return res.status(400).json({ error: 'content_markdown required' });
  if (content_markdown.length > MAX_JOURNAL_BYTES) {
    return res.status(400).json({ error: `Journal too long (max ${MAX_JOURNAL_BYTES} chars)` });
  }

  // Stale-write precondition (M5 slice 4 pattern). Only fires when the caller
  // sends If-Unmodified-Since AND a row already exists; first-write inserts
  // skip this check entirely.
  const current = journalService.getJournal(Number(dayId));
  const observed = req.header('If-Unmodified-Since')?.trim();
  if (observed && current?.updated_at && observed !== current.updated_at) {
    const mutationId = (req.header('X-Client-Mutation-Id') || '').trim();
    if (mutationId) {
      const conflictId = parkAsConflict({
        userId: authReq.user.id,
        clientMutationId: mutationId,
        endpoint: req.path,
        method: 'PUT',
        recordType: 'journal',
        recordId: Number(dayId),
        minePayload: req.body,
        theirsSnapshot: { day_id: current.day_id, content_markdown: current.content_markdown, updated_at: current.updated_at },
        observedUpdatedAt: observed,
        serverUpdatedAt: current.updated_at,
      });
      return res.status(409).json({
        error: 'Journal was updated since you queued this change',
        code: 'STALE_WRITE',
        conflict_id: conflictId,
      });
    }
  }

  const journal = journalService.upsertJournal(Number(dayId), content_markdown, authReq.user.id);
  res.json({ journal });
  broadcast(tripId, 'dayJournal:updated', { dayId: Number(dayId), journal }, req.headers['x-socket-id'] as string);
});

export default router;
