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

// [460-fork] Milestone 11 — M3 partner_invite_accept/decline actions were
// removed when partnerService was deleted. Household invite/accept boolean
// notification actions will be wired up in M11 slice 2 alongside the new
// REST endpoints. Until then, in-flight partner_invite notifications from
// pre-M11 deploys are no-ops (the underlying invite tables are dropped).
registerAction('partner_invite_accept', async () => { /* M11: superseded */ });
registerAction('partner_invite_decline', async () => { /* M11: superseded */ });

export { registerAction, getAction };
