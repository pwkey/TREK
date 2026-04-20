/**
 * Unit tests for partnerService (Milestone 3 slice 1).
 * Uses an in-memory SQLite db with the real migrations applied.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';

const { testDb, dbMock } = vi.hoisted(() => {
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  return { testDb: db, dbMock: { db, closeDb: () => {}, reinitialize: () => {} } };
});

vi.mock('../../src/db/database', () => dbMock);
vi.mock('../../src/config', () => ({
  JWT_SECRET: 'test-jwt-secret-for-trek-testing-only',
  ENCRYPTION_KEY: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6a7b8c9d0e1f2a3b4c5d6a7b8c9d0e1f2',
  updateJwtSecret: () => {},
}));

import { createTables } from '../../src/db/schema';
import { runMigrations } from '../../src/db/migrations';
import { resetTestDb } from '../helpers/test-db';
import { createUser } from '../helpers/factories';
import * as partnerService from '../../src/services/partnerService';

beforeAll(() => {
  createTables(testDb);
  runMigrations(testDb);
});

beforeEach(() => {
  resetTestDb(testDb);
});

afterAll(() => {
  testDb.close();
});

describe('partnerService.sendInvite', () => {
  it('creates a pending invite for an existing user by email', async () => {
    const { user: alice } = createUser(testDb, { email: 'alice@test.com', username: 'alice' });
    createUser(testDb, { email: 'bob@test.com', username: 'bob' });
    const result = partnerService.sendInvite({ inviterId: alice.id, targetIdentifier: 'bob@test.com' });
    expect('invite' in result).toBe(true);
    if (!('invite' in result)) return;
    expect(result.invite.target.email).toBe('bob@test.com');
    expect(result.invite.inviter.username).toBe('alice');
  });

  it('looks up by username if email does not match', async () => {
    const { user: alice } = createUser(testDb, { email: 'alice@test.com', username: 'alice' });
    createUser(testDb, { email: 'bob@test.com', username: 'bobby_b' });
    const result = partnerService.sendInvite({ inviterId: alice.id, targetIdentifier: 'bobby_b' });
    expect('invite' in result).toBe(true);
  });

  it('rejects self-invite', async () => {
    const { user: alice } = createUser(testDb);
    const result = partnerService.sendInvite({ inviterId: alice.id, targetIdentifier: alice.email });
    expect('invite' in result).toBe(false);
    if ('invite' in result) return;
    expect(result.code).toBe('SELF_INVITE');
  });

  it('returns USER_NOT_FOUND when identifier is unknown', async () => {
    const { user: alice } = createUser(testDb);
    const result = partnerService.sendInvite({ inviterId: alice.id, targetIdentifier: 'nobody@nowhere.example' });
    expect('invite' in result).toBe(false);
    if ('invite' in result) return;
    expect(result.code).toBe('USER_NOT_FOUND');
  });

  it('rejects when inviter already has a partner', async () => {
    const { user: alice } = createUser(testDb);
    const { user: bob } = createUser(testDb);
    const { user: charlie } = createUser(testDb);
    // Pair alice + bob directly via SQL to set up the pre-condition
    testDb.prepare('UPDATE users SET partner_user_id = ? WHERE id = ?').run(bob.id, alice.id);
    testDb.prepare('UPDATE users SET partner_user_id = ? WHERE id = ?').run(alice.id, bob.id);
    const result = partnerService.sendInvite({ inviterId: alice.id, targetIdentifier: charlie.email });
    expect('invite' in result).toBe(false);
    if ('invite' in result) return;
    expect(result.code).toBe('ALREADY_PAIRED');
  });

  it('rejects when target is already paired with someone else', async () => {
    const { user: alice } = createUser(testDb);
    const { user: bob } = createUser(testDb);
    const { user: charlie } = createUser(testDb);
    testDb.prepare('UPDATE users SET partner_user_id = ? WHERE id = ?').run(charlie.id, bob.id);
    testDb.prepare('UPDATE users SET partner_user_id = ? WHERE id = ?').run(bob.id, charlie.id);
    const result = partnerService.sendInvite({ inviterId: alice.id, targetIdentifier: bob.email });
    expect('invite' in result).toBe(false);
    if ('invite' in result) return;
    expect(result.code).toBe('TARGET_ALREADY_PAIRED');
  });

  it('rejects when a pending invite already exists in either direction', async () => {
    const { user: alice } = createUser(testDb);
    const { user: bob } = createUser(testDb);
    const first = partnerService.sendInvite({ inviterId: alice.id, targetIdentifier: bob.email });
    expect('invite' in first).toBe(true);
    const second = partnerService.sendInvite({ inviterId: alice.id, targetIdentifier: bob.email });
    expect('invite' in second).toBe(false);
    if ('invite' in second) return;
    expect(second.code).toBe('PENDING_INVITE_EXISTS');
    // Reverse direction also blocked
    const reverse = partnerService.sendInvite({ inviterId: bob.id, targetIdentifier: alice.email });
    expect('invite' in reverse).toBe(false);
  });

  it('is idempotent on client_mutation_id replay', async () => {
    const { user: alice } = createUser(testDb);
    const { user: bob } = createUser(testDb);
    const cmid = 'cmid-' + Math.random();
    const first = partnerService.sendInvite({ inviterId: alice.id, targetIdentifier: bob.email, clientMutationId: cmid });
    const second = partnerService.sendInvite({ inviterId: alice.id, targetIdentifier: bob.email, clientMutationId: cmid });
    if (!('invite' in first) || !('invite' in second)) throw new Error('expected invite returns');
    expect(second.invite.id).toBe(first.invite.id);
  });
});

describe('partnerService.acceptInvite', () => {
  it('pairs both users symmetrically', async () => {
    const { user: alice } = createUser(testDb);
    const { user: bob } = createUser(testDb);
    const send = partnerService.sendInvite({ inviterId: alice.id, targetIdentifier: bob.email });
    if (!('invite' in send)) throw new Error('send failed');
    const accept = partnerService.acceptInvite({ userId: bob.id, inviteId: send.invite.id });
    expect('partner' in accept).toBe(true);
    if (!('partner' in accept)) return;
    expect(accept.partner.id).toBe(alice.id);

    const aliceRow = testDb.prepare('SELECT partner_user_id FROM users WHERE id = ?').get(alice.id) as any;
    const bobRow = testDb.prepare('SELECT partner_user_id FROM users WHERE id = ?').get(bob.id) as any;
    expect(aliceRow.partner_user_id).toBe(bob.id);
    expect(bobRow.partner_user_id).toBe(alice.id);
  });

  it('rejects accept from a user who is not the target', async () => {
    const { user: alice } = createUser(testDb);
    const { user: bob } = createUser(testDb);
    const { user: charlie } = createUser(testDb);
    const send = partnerService.sendInvite({ inviterId: alice.id, targetIdentifier: bob.email });
    if (!('invite' in send)) throw new Error('send failed');
    const accept = partnerService.acceptInvite({ userId: charlie.id, inviteId: send.invite.id });
    expect('partner' in accept).toBe(false);
    if ('partner' in accept) return;
    expect(accept.code).toBe('NOT_INVITE_RECIPIENT');
  });

  it('returns INVITE_EXPIRED for a past expires_at and marks the row expired', async () => {
    const { user: alice } = createUser(testDb);
    const { user: bob } = createUser(testDb);
    const send = partnerService.sendInvite({ inviterId: alice.id, targetIdentifier: bob.email });
    if (!('invite' in send)) throw new Error('send failed');
    testDb.prepare("UPDATE partner_invites SET expires_at = '2000-01-01 00:00:00' WHERE id = ?").run(send.invite.id);
    const accept = partnerService.acceptInvite({ userId: bob.id, inviteId: send.invite.id });
    expect('partner' in accept).toBe(false);
    if ('partner' in accept) return;
    expect(accept.code).toBe('INVITE_EXPIRED');
    const status = testDb.prepare('SELECT status FROM partner_invites WHERE id = ?').get(send.invite.id) as any;
    expect(status.status).toBe('expired');
  });

  it('rejects a double-accept', async () => {
    const { user: alice } = createUser(testDb);
    const { user: bob } = createUser(testDb);
    const send = partnerService.sendInvite({ inviterId: alice.id, targetIdentifier: bob.email });
    if (!('invite' in send)) throw new Error('send failed');
    const first = partnerService.acceptInvite({ userId: bob.id, inviteId: send.invite.id });
    expect('partner' in first).toBe(true);
    const second = partnerService.acceptInvite({ userId: bob.id, inviteId: send.invite.id });
    expect('partner' in second).toBe(false);
    if ('partner' in second) return;
    expect(second.code).toBe('INVITE_ALREADY_RESOLVED');
  });
});

describe('partnerService.declineInvite', () => {
  it('marks invite declined and is idempotent', async () => {
    const { user: alice } = createUser(testDb);
    const { user: bob } = createUser(testDb);
    const send = partnerService.sendInvite({ inviterId: alice.id, targetIdentifier: bob.email });
    if (!('invite' in send)) throw new Error('send failed');
    const first = partnerService.declineInvite({ userId: bob.id, inviteId: send.invite.id });
    expect('ok' in first).toBe(true);
    const second = partnerService.declineInvite({ userId: bob.id, inviteId: send.invite.id });
    expect('ok' in second).toBe(true);
    const row = testDb.prepare('SELECT status FROM partner_invites WHERE id = ?').get(send.invite.id) as any;
    expect(row.status).toBe('declined');
  });
});

describe('partnerService.cancelInvite', () => {
  it('only the inviter can cancel', async () => {
    const { user: alice } = createUser(testDb);
    const { user: bob } = createUser(testDb);
    const send = partnerService.sendInvite({ inviterId: alice.id, targetIdentifier: bob.email });
    if (!('invite' in send)) throw new Error('send failed');
    const wrong = partnerService.cancelInvite({ userId: bob.id, inviteId: send.invite.id });
    expect('ok' in wrong).toBe(false);
    const right = partnerService.cancelInvite({ userId: alice.id, inviteId: send.invite.id });
    expect('ok' in right).toBe(true);
    const row = testDb.prepare('SELECT status FROM partner_invites WHERE id = ?').get(send.invite.id) as any;
    expect(row.status).toBe('cancelled');
  });
});

describe('partnerService.unpair', () => {
  it('clears partner_user_id on both users symmetrically', async () => {
    const { user: alice } = createUser(testDb);
    const { user: bob } = createUser(testDb);
    const send = partnerService.sendInvite({ inviterId: alice.id, targetIdentifier: bob.email });
    if (!('invite' in send)) throw new Error('send failed');
    partnerService.acceptInvite({ userId: bob.id, inviteId: send.invite.id });

    const result = partnerService.unpair(alice.id);
    expect('ok' in result).toBe(true);
    const aliceRow = testDb.prepare('SELECT partner_user_id FROM users WHERE id = ?').get(alice.id) as any;
    const bobRow = testDb.prepare('SELECT partner_user_id FROM users WHERE id = ?').get(bob.id) as any;
    expect(aliceRow.partner_user_id).toBeNull();
    expect(bobRow.partner_user_id).toBeNull();
  });

  it('unpair is idempotent on a user with no partner', async () => {
    const { user: alice } = createUser(testDb);
    const result = partnerService.unpair(alice.id);
    expect('ok' in result).toBe(true);
  });

  it('unpair does NOT delete any trip_members rows', async () => {
    const { user: alice } = createUser(testDb);
    const { user: bob } = createUser(testDb);
    const send = partnerService.sendInvite({ inviterId: alice.id, targetIdentifier: bob.email });
    if (!('invite' in send)) throw new Error('send failed');
    partnerService.acceptInvite({ userId: bob.id, inviteId: send.invite.id });

    // Arrange: Alice creates a trip; Bob is a trip_member.
    const tripRes = testDb
      .prepare('INSERT INTO trips (user_id, title) VALUES (?, ?)')
      .run(alice.id, 'Europe 2027');
    const tripId = tripRes.lastInsertRowid as number;
    testDb
      .prepare('INSERT INTO trip_members (trip_id, user_id, invited_by) VALUES (?, ?, ?)')
      .run(tripId, bob.id, alice.id);

    partnerService.unpair(alice.id);

    const member = testDb
      .prepare('SELECT * FROM trip_members WHERE trip_id = ? AND user_id = ?')
      .get(tripId, bob.id);
    expect(member).toBeDefined();
  });
});

describe('partnerService.autoAddPartnerToTrip', () => {
  function pairAliceBob() {
    const { user: alice } = createUser(testDb);
    const { user: bob } = createUser(testDb);
    testDb.prepare('UPDATE users SET partner_user_id = ? WHERE id = ?').run(bob.id, alice.id);
    testDb.prepare('UPDATE users SET partner_user_id = ? WHERE id = ?').run(alice.id, bob.id);
    return { alice, bob };
  }

  it('adds partner as trip_member when owner is paired', async () => {
    const { alice, bob } = pairAliceBob();
    const tripRes = testDb.prepare('INSERT INTO trips (user_id, title) VALUES (?, ?)').run(alice.id, 'Paris');
    const tripId = tripRes.lastInsertRowid as number;
    const result = partnerService.autoAddPartnerToTrip(alice.id, tripId, 'Paris');
    expect(result.added).toBe(true);
    expect(result.partnerId).toBe(bob.id);
    const member = testDb.prepare('SELECT user_id, invited_by FROM trip_members WHERE trip_id = ? AND user_id = ?').get(tripId, bob.id) as any;
    expect(member).toBeDefined();
    expect(member.invited_by).toBe(alice.id);
  });

  it('is a no-op when owner has no partner', async () => {
    const { user: alice } = createUser(testDb);
    const tripRes = testDb.prepare('INSERT INTO trips (user_id, title) VALUES (?, ?)').run(alice.id, 'Solo');
    const result = partnerService.autoAddPartnerToTrip(alice.id, tripRes.lastInsertRowid as number, 'Solo');
    expect(result.added).toBe(false);
    expect(result.partnerId).toBeNull();
  });

  it('is idempotent when partner is already a trip_member', async () => {
    const { alice, bob } = pairAliceBob();
    const tripRes = testDb.prepare('INSERT INTO trips (user_id, title) VALUES (?, ?)').run(alice.id, 'Tokyo');
    const tripId = tripRes.lastInsertRowid as number;
    testDb.prepare('INSERT INTO trip_members (trip_id, user_id, invited_by) VALUES (?, ?, ?)').run(tripId, bob.id, alice.id);
    const result = partnerService.autoAddPartnerToTrip(alice.id, tripId, 'Tokyo');
    expect(result.added).toBe(false);
    expect(result.partnerId).toBe(bob.id);
  });
});

describe('partnerService.backfillTrips', () => {
  function pairAliceBob() {
    const { user: alice } = createUser(testDb);
    const { user: bob } = createUser(testDb);
    testDb.prepare('UPDATE users SET partner_user_id = ? WHERE id = ?').run(bob.id, alice.id);
    testDb.prepare('UPDATE users SET partner_user_id = ? WHERE id = ?').run(alice.id, bob.id);
    return { alice, bob };
  }

  it('adds partner to all owned trips that do not already have them', async () => {
    const { alice, bob } = pairAliceBob();
    const t1 = testDb.prepare('INSERT INTO trips (user_id, title) VALUES (?, ?)').run(alice.id, 'A').lastInsertRowid as number;
    const t2 = testDb.prepare('INSERT INTO trips (user_id, title) VALUES (?, ?)').run(alice.id, 'B').lastInsertRowid as number;
    const t3 = testDb.prepare('INSERT INTO trips (user_id, title) VALUES (?, ?)').run(alice.id, 'C').lastInsertRowid as number;
    // Bob already on t1 manually
    testDb.prepare('INSERT INTO trip_members (trip_id, user_id, invited_by) VALUES (?, ?, ?)').run(t1, bob.id, alice.id);
    const result = partnerService.backfillTrips(alice.id);
    expect('added' in result).toBe(true);
    if (!('added' in result)) return;
    expect(result.added).toBe(2); // t2 and t3
    expect(result.skipped).toBe(1); // t1
    expect(result.trip_ids.sort()).toEqual([t2, t3].sort());
  });

  it('is idempotent on re-run', async () => {
    const { alice } = pairAliceBob();
    testDb.prepare('INSERT INTO trips (user_id, title) VALUES (?, ?)').run(alice.id, 'One');
    testDb.prepare('INSERT INTO trips (user_id, title) VALUES (?, ?)').run(alice.id, 'Two');
    const first = partnerService.backfillTrips(alice.id);
    const second = partnerService.backfillTrips(alice.id);
    if (!('added' in first) || !('added' in second)) throw new Error('expected success');
    expect(first.added).toBe(2);
    expect(second.added).toBe(0);
    expect(second.skipped).toBe(2);
  });

  it('NOT_PAIRED when caller has no partner', async () => {
    const { user: alice } = createUser(testDb);
    const result = partnerService.backfillTrips(alice.id);
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.code).toBe('NOT_PAIRED');
    }
  });

  it('sets settings.partner_backfill_done to "true"', async () => {
    const { alice } = pairAliceBob();
    testDb.prepare('INSERT INTO trips (user_id, title) VALUES (?, ?)').run(alice.id, 'Only');
    partnerService.backfillTrips(alice.id);
    const row = testDb.prepare("SELECT value FROM settings WHERE user_id = ? AND key = 'partner_backfill_done'").get(alice.id) as any;
    expect(row.value).toBe('true');
    expect(partnerService.hasBackfilledTrips(alice.id)).toBe(true);
  });
});

describe('partnerService.getPartner / listIncomingInvites / listOutgoingInvites', () => {
  it('reads back the paired user', async () => {
    const { user: alice } = createUser(testDb);
    const { user: bob } = createUser(testDb);
    const send = partnerService.sendInvite({ inviterId: alice.id, targetIdentifier: bob.email });
    if (!('invite' in send)) throw new Error('send failed');
    partnerService.acceptInvite({ userId: bob.id, inviteId: send.invite.id });
    const alicePartner = partnerService.getPartner(alice.id);
    const bobPartner = partnerService.getPartner(bob.id);
    expect(alicePartner?.id).toBe(bob.id);
    expect(bobPartner?.id).toBe(alice.id);
  });

  it('list endpoints return pending invites only', async () => {
    const { user: alice } = createUser(testDb);
    const { user: bob } = createUser(testDb);
    const send = partnerService.sendInvite({ inviterId: alice.id, targetIdentifier: bob.email });
    if (!('invite' in send)) throw new Error('send failed');
    expect(partnerService.listIncomingInvites(bob.id)).toHaveLength(1);
    expect(partnerService.listOutgoingInvites(alice.id)).toHaveLength(1);
    partnerService.declineInvite({ userId: bob.id, inviteId: send.invite.id });
    expect(partnerService.listIncomingInvites(bob.id)).toHaveLength(0);
    expect(partnerService.listOutgoingInvites(alice.id)).toHaveLength(0);
  });
});
