// [460-fork] Milestone 9 — pre-trip availability polls.
//
// Owner-side (auth required):
//   GET    /api/polls                list mine
//   POST   /api/polls                create
//   GET    /api/polls/:id            full details + votes
//   DELETE /api/polls/:id            remove
//
// Public (no auth — voters identify by browser_id stored in
// localStorage, share_token controls access):
//   GET    /api/polls/share/:token              public view + votes
//   POST   /api/polls/share/:token/votes        submit / update votes
//
import express, { Request, Response } from 'express';
import { authenticate } from '../middleware/auth';
import { AuthRequest } from '../types';
import * as pollService from '../services/pollService';

const router = express.Router({ mergeParams: true });

router.get('/', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  res.json({ polls: pollService.listMyPolls(authReq.user.id) });
});

router.post('/', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  try {
    const poll = pollService.createPoll(authReq.user.id, req.body ?? {});
    res.status(201).json({ poll });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Could not create poll' });
  }
});

router.get('/:id', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid poll id' });
  const poll = pollService.getPollWithVotes({ id });
  if (!poll || poll.owner_user_id !== authReq.user.id) return res.status(404).json({ error: 'Poll not found' });
  res.json({ poll });
});

router.delete('/:id', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid poll id' });
  const ok = pollService.deletePoll(id, authReq.user.id);
  if (!ok) return res.status(404).json({ error: 'Poll not found' });
  res.json({ ok: true });
});

// Public — share-token-gated, no authenticate middleware.
router.get('/share/:token', (req: Request, res: Response) => {
  const token = req.params.token;
  if (!token) return res.status(400).json({ error: 'Missing token' });
  const poll = pollService.getPollWithVotes({ token });
  if (!poll) return res.status(404).json({ error: 'Poll not found' });
  // Don't surface owner_user_id / finalised_trip_id internals to public
  // viewers — they don't need them for voting.
  const { owner_user_id, finalised_trip_id, ...publicPoll } = poll;
  void owner_user_id; void finalised_trip_id;
  res.json({ poll: publicPoll });
});

router.post('/share/:token/votes', (req: Request, res: Response) => {
  const token = req.params.token;
  if (!token) return res.status(400).json({ error: 'Missing token' });
  const poll = pollService.getPollByToken(token);
  if (!poll) return res.status(404).json({ error: 'Poll not found' });

  const { voter_name, voter_email, voter_browser_id, choices } = req.body ?? {};
  if (typeof voter_name !== 'string' || !voter_name.trim()) return res.status(400).json({ error: 'voter_name required' });
  if (typeof voter_browser_id !== 'string' || !voter_browser_id.trim()) return res.status(400).json({ error: 'voter_browser_id required' });
  if (!Array.isArray(choices)) return res.status(400).json({ error: 'choices must be an array' });
  // Email is optional; null/undefined/empty all mean "no email".
  if (voter_email !== undefined && voter_email !== null && typeof voter_email !== 'string') {
    return res.status(400).json({ error: 'voter_email must be a string or null' });
  }

  try {
    const votes = pollService.submitVotes(poll.id, voter_name, voter_browser_id, choices, voter_email);
    res.json({ votes });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Could not submit votes' });
  }
});

// [460-fork] Milestone 9 slice 4 — Vacay-addon pre-fill suggestions.
// Authenticated voter (any user with a session) can ask "based on my
// vacay entries, which options should I say yes to?". The share token
// scopes the lookup to one poll. Anonymous voters get 401 and the
// client just hides the button.
router.get('/share/:token/vacay-prefill', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const token = req.params.token;
  if (!token) return res.status(400).json({ error: 'Missing token' });
  const poll = pollService.getPollByToken(token);
  if (!poll) return res.status(404).json({ error: 'Poll not found' });
  res.json({ prefill: pollService.computeVacayPrefill(poll.id, authReq.user.id) });
});

// [460-fork] Milestone 9 slice 3 — convert a poll to a trip.
router.post('/:id/convert', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid poll id' });
  const { option_id, title } = req.body ?? {};
  if (typeof option_id !== 'number') return res.status(400).json({ error: 'option_id required' });
  try {
    const result = pollService.convertPollToTrip(id, option_id, authReq.user.id, { title });
    res.status(201).json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Could not convert poll';
    if (/not found/i.test(msg)) return res.status(404).json({ error: msg });
    if (/not authorised/i.test(msg)) return res.status(403).json({ error: msg });
    if (/already converted/i.test(msg)) return res.status(409).json({ error: msg });
    res.status(400).json({ error: msg });
  }
});

export default router;
