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

// [460-fork] Milestone 11 — M3 partner_invite actions are now no-ops (the
// partnerService was deleted in slice 1 and the invite rows dropped). Any
// in-flight notifications from pre-M11 deploys resolve silently.
registerAction('partner_invite_accept', async () => { /* M11: superseded */ });
registerAction('partner_invite_decline', async () => { /* M11: superseded */ });

// [460-fork] Milestone 11 slice 2 — household_invite boolean notification
// callbacks. The notification's positive/negative buttons fire these.
// Dynamic import to avoid the householdService → notificationService cycle.
registerAction('household_invite_accept', async (payload, respondingUserId) => {
  const token = typeof payload.token === 'string' ? payload.token : null;
  if (!token) return;
  const mod = await import('./householdService');
  mod.acceptInvite({ userId: respondingUserId, token });
});

registerAction('household_invite_decline', async (payload, respondingUserId) => {
  const token = typeof payload.token === 'string' ? payload.token : null;
  if (!token) return;
  const mod = await import('./householdService');
  mod.declineInvite({ userId: respondingUserId, token });
});

export { registerAction, getAction };
