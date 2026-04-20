type ActionHandler = (payload: Record<string, unknown>, respondingUserId: number) => Promise<void>;

const actionRegistry = new Map<string, ActionHandler>();

function registerAction(actionType: string, handler: ActionHandler): void {
  actionRegistry.set(actionType, handler);
}

function getAction(actionType: string): ActionHandler | undefined {
  return actionRegistry.get(actionType);
}

// Dev/test actions
registerAction('test_approve', async () => {
  console.log('[notifications] Test approve action executed');
});

registerAction('test_deny', async () => {
  console.log('[notifications] Test deny action executed');
});

// [460-fork] Partner pairing (Milestone 3) — boolean notification callbacks.
// Dynamic import (not require) so Vitest's ESM resolver finds it the same
// way production tsx does. Breaks the partnerService ↔ notificationService
// import cycle.
registerAction('partner_invite_accept', async (payload, respondingUserId) => {
  const inviteId = typeof payload.inviteId === 'string' ? payload.inviteId : null;
  if (!inviteId) return;
  const mod = await import('./partnerService');
  mod.acceptInvite({ userId: respondingUserId, inviteId });
});

registerAction('partner_invite_decline', async (payload, respondingUserId) => {
  const inviteId = typeof payload.inviteId === 'string' ? payload.inviteId : null;
  if (!inviteId) return;
  const mod = await import('./partnerService');
  mod.declineInvite({ userId: respondingUserId, inviteId });
});

export { registerAction, getAction };
