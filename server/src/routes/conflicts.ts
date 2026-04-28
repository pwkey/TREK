// [460-fork] Milestone 5 slice 4 — list and resolve queued-mutation conflicts.
import express, { Request, Response } from 'express';
import { authenticate } from '../middleware/auth';
import { AuthRequest } from '../types';
import { writeAudit, getClientIp } from '../services/auditLog';
import { db } from '../db/database';
import { broadcast, broadcastDay } from '../websocket';
import {
  countConflicts,
  getConflict,
  listConflicts,
  markResolved,
  type ResolveChoice,
} from '../services/conflictsService';
import * as dayService from '../services/dayService';
import * as journalService from '../services/journalService';
import { Day } from '../types';

const router = express.Router();

router.get('/', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  res.json({ conflicts: listConflicts(authReq.user.id), count: countConflicts(authReq.user.id) });
});

// Resolve a conflict.
//   { choice: 'theirs' }                     → discard mine, keep server state.
//   { choice: 'mine' }                       → re-apply mine, override server.
//   { choice: 'combine', merged: {...} }     → apply caller-provided merged
//                                              payload (text-field combine).
router.post('/:id/resolve', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const conflict = getConflict(authReq.user.id, req.params.id);
  if (!conflict) return res.status(404).json({ error: 'Conflict not found', code: 'CONFLICT_NOT_FOUND' });

  const choice = req.body?.choice as ResolveChoice | undefined;
  if (choice !== 'mine' && choice !== 'theirs' && choice !== 'combine') {
    return res.status(400).json({ error: "choice must be 'mine', 'theirs', or 'combine'", code: 'INVALID_CHOICE' });
  }
  if (choice === 'combine' && (typeof req.body?.merged !== 'object' || req.body.merged === null)) {
    return res.status(400).json({ error: "Combine requires a merged payload", code: 'COMBINE_REQUIRES_MERGED' });
  }

  if (choice === 'theirs') {
    markResolved(conflict.id, 'theirs');
    writeAudit({ userId: authReq.user.id, action: 'conflict.resolve', ip: getClientIp(req), details: { conflictId: conflict.id, choice: 'theirs' } });
    return res.json({ ok: true, choice: 'theirs' });
  }

  // 'mine' or 'combine' both re-apply a payload to the underlying record.
  const payloadStr = choice === 'mine' ? conflict.mine_payload : JSON.stringify(req.body.merged);
  let payload: Record<string, unknown>;
  try { payload = JSON.parse(payloadStr) as Record<string, unknown>; } catch { payload = {}; }

  if (conflict.record_type === 'day') {
    // Re-apply via dayService.updateDay. Force-apply: skip the precondition.
    const current = db.prepare('SELECT * FROM days WHERE id = ?').get(conflict.record_id) as Day | undefined;
    if (!current) return res.status(404).json({ error: 'Underlying day no longer exists', code: 'RECORD_GONE' });

    const day = dayService.updateDay(conflict.record_id, current, {
      notes: typeof payload.notes === 'string' ? payload.notes as string : undefined,
      title: 'title' in payload ? (payload.title as string | null ?? null) : undefined,
    });
    markResolved(conflict.id, choice);
    writeAudit({ userId: authReq.user.id, action: 'conflict.resolve', ip: getClientIp(req), details: { conflictId: conflict.id, choice } });

    // Fan out the resolved value as a normal day:updated broadcast so every
    // collaborator's planner picks up the new state.
    broadcastDay(day as any, 'day:updated', { day }, req.headers['x-socket-id'] as string);

    return res.json({ ok: true, choice, day });
  }

  // [460-fork] Milestone 6 slice 1 — journal record dispatch.
  if (conflict.record_type === 'journal') {
    const content = typeof payload.content_markdown === 'string' ? payload.content_markdown as string : '';
    const journal = journalService.upsertJournal(conflict.record_id, content, authReq.user.id);
    markResolved(conflict.id, choice);
    writeAudit({ userId: authReq.user.id, action: 'conflict.resolve', ip: getClientIp(req), details: { conflictId: conflict.id, choice } });
    // Find the day's trip so the broadcast goes to the right room. The
    // journal row's day_id is conflict.record_id; pull trip_id off the day.
    const day = db.prepare('SELECT id, trip_id FROM days WHERE id = ?').get(conflict.record_id) as { id: number; trip_id: number } | undefined;
    if (day) {
      broadcast(day.trip_id, 'dayJournal:updated', { dayId: day.id, journal }, req.headers['x-socket-id'] as string);
    }
    return res.json({ ok: true, choice, journal });
  }

  // Other record types not wired yet — extend as routes adopt parkAsConflict.
  return res.status(501).json({ error: `Resolve not implemented for record_type=${conflict.record_type}`, code: 'NOT_IMPLEMENTED' });
});

export default router;
