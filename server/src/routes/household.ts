// [460-fork] Milestone 11 slice 2 — REST routes for the household.
//
// Supersedes /api/auth/me/partner (M3 partner pairing). Endpoints:
//
//   POST    /api/household                              Create household.
//   GET     /api/household                              Get the user's household snapshot.
//   PATCH   /api/household                              Rename.
//   DELETE  /api/household                              Leave.
//
//   POST    /api/household/invites                      Send an invite by email.
//   GET     /api/household/invites                      List incoming + outgoing.
//   DELETE  /api/household/invites/:id                  Cancel an outgoing invite.
//   POST    /api/household/invites/:token/accept        Accept (recipient).
//   POST    /api/household/invites/:token/decline       Decline (recipient).
//
//   POST    /api/household/members                      Add a named (no-account) member.
//   PUT     /api/household/members/:id                  Update.
//   DELETE  /api/household/members/:id                  Remove.
//
// Idempotency on mutations is delegated to the global X-Client-Mutation-Id
// middleware (src/middleware/idempotency.ts) for everything except the
// invite creation, which uses an additional per-row client_mutation_id
// column to dedupe at the persistence layer.
import express, { Request, Response } from 'express';
import { authenticate } from '../middleware/auth';
import { AuthRequest } from '../types';
import { writeAudit, getClientIp } from '../services/auditLog';
import {
  createHousehold,
  getHouseholdForUser,
  renameHousehold,
  leaveHousehold,
  addMember,
  updateMember,
  deleteMember,
  sendInvite,
  cancelInvite,
  acceptInvite,
  declineInvite,
  listIncomingInvites,
  listOutgoingInvites,
} from '../services/householdService';

const router = express.Router();

// ── Core household ─────────────────────────────────────────────────────────

router.post('/', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { name } = req.body ?? {};
  const result = createHousehold({
    userId: authReq.user.id,
    name: typeof name === 'string' ? name : null,
  });
  if ('error' in result) return res.status(result.status).json({ error: result.error, code: result.code });
  writeAudit({ userId: authReq.user.id, action: 'household.create', resource: String(result.household.id), ip: getClientIp(req) });
  return res.status(201).json({ household: result.household });
});

router.get('/', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const household = getHouseholdForUser(authReq.user.id);
  return res.json({
    household,
    incoming: listIncomingInvites(authReq.user.id),
    outgoing: household ? listOutgoingInvites(authReq.user.id) : [],
  });
});

router.patch('/', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { name } = req.body ?? {};
  const result = renameHousehold({ userId: authReq.user.id, name: typeof name === 'string' ? name : null });
  if ('error' in result) return res.status(result.status).json({ error: result.error, code: result.code });
  writeAudit({ userId: authReq.user.id, action: 'household.rename', resource: String(result.household.id), ip: getClientIp(req) });
  return res.json({ household: result.household });
});

router.delete('/', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const result = leaveHousehold(authReq.user.id);
  if ('error' in result) return res.status(result.status).json({ error: result.error, code: result.code });
  writeAudit({ userId: authReq.user.id, action: 'household.leave', ip: getClientIp(req) });
  return res.json({ ok: true });
});

// ── Invites ────────────────────────────────────────────────────────────────

router.post('/invites', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const cmid = (req.headers['x-client-mutation-id'] as string | undefined)?.trim() || null;
  const { email, message } = req.body ?? {};
  if (!email || typeof email !== 'string') {
    return res.status(400).json({ error: 'email is required', code: 'INVALID_INPUT' });
  }
  const result = sendInvite({
    userId: authReq.user.id,
    inviteeEmail: email,
    message: typeof message === 'string' ? message : null,
    clientMutationId: cmid,
  });
  if ('error' in result) return res.status(result.status).json({ error: result.error, code: result.code });
  writeAudit({ userId: authReq.user.id, action: 'household.invite', resource: result.invite.id, ip: getClientIp(req), details: { invitee_email: email } });
  return res.status(201).json({ invite: result.invite });
});

router.delete('/invites/:id', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const result = cancelInvite({ userId: authReq.user.id, inviteId: req.params.id });
  if ('error' in result) return res.status(result.status).json({ error: result.error, code: result.code });
  writeAudit({ userId: authReq.user.id, action: 'household.invite_cancel', resource: req.params.id, ip: getClientIp(req) });
  return res.json({ ok: true });
});

router.post('/invites/:token/accept', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const result = acceptInvite({ userId: authReq.user.id, token: req.params.token });
  if ('error' in result) return res.status(result.status).json({ error: result.error, code: result.code });
  writeAudit({ userId: authReq.user.id, action: 'household.invite_accept', resource: req.params.token, ip: getClientIp(req) });
  return res.json({ household: result.household });
});

router.post('/invites/:token/decline', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const result = declineInvite({ userId: authReq.user.id, token: req.params.token });
  if ('error' in result) return res.status(result.status).json({ error: result.error, code: result.code });
  writeAudit({ userId: authReq.user.id, action: 'household.invite_decline', resource: req.params.token, ip: getClientIp(req) });
  return res.json({ ok: true });
});

// ── Named members ──────────────────────────────────────────────────────────

router.post('/members', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { name, dob, relationship } = req.body ?? {};
  if (!name || typeof name !== 'string') {
    return res.status(400).json({ error: 'name is required', code: 'INVALID_INPUT' });
  }
  const result = addMember({
    userId: authReq.user.id,
    name,
    dob: typeof dob === 'string' ? dob : null,
    relationship: typeof relationship === 'string' ? relationship : null,
  });
  if ('error' in result) return res.status(result.status).json({ error: result.error, code: result.code });
  writeAudit({ userId: authReq.user.id, action: 'household.member_add', resource: String(result.member.id), ip: getClientIp(req) });
  return res.status(201).json({ member: result.member });
});

router.put('/members/:id', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const memberId = Number(req.params.id);
  if (!Number.isInteger(memberId) || memberId <= 0) {
    return res.status(400).json({ error: 'Invalid member id', code: 'INVALID_INPUT' });
  }
  const { name, dob, relationship } = req.body ?? {};
  const result = updateMember({
    userId: authReq.user.id,
    memberId,
    name: typeof name === 'string' ? name : undefined,
    dob: typeof dob === 'string' || dob === null ? dob : undefined,
    relationship: typeof relationship === 'string' || relationship === null ? relationship : undefined,
  });
  if ('error' in result) return res.status(result.status).json({ error: result.error, code: result.code });
  writeAudit({ userId: authReq.user.id, action: 'household.member_update', resource: String(memberId), ip: getClientIp(req) });
  return res.json({ member: result.member });
});

router.delete('/members/:id', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const memberId = Number(req.params.id);
  if (!Number.isInteger(memberId) || memberId <= 0) {
    return res.status(400).json({ error: 'Invalid member id', code: 'INVALID_INPUT' });
  }
  const result = deleteMember({ userId: authReq.user.id, memberId });
  if ('error' in result) return res.status(result.status).json({ error: result.error, code: result.code });
  writeAudit({ userId: authReq.user.id, action: 'household.member_delete', resource: String(memberId), ip: getClientIp(req) });
  return res.json({ ok: true });
});

export default router;
