/**
 * Integration tests for /api/household (Milestone 11 slice 2).
 *
 * Covers: create/get/rename/leave, invite send/cancel/accept/decline,
 * named-member CRUD, permissions, and the partner-pairing-replaced 410 stubs.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import type { Application } from 'express';

const { testDb, dbMock } = vi.hoisted(() => {
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  return {
    testDb: db,
    dbMock: {
      db,
      closeDb: () => {},
      reinitialize: () => {},
      canAccessTrip: () => null,
      isOwner: () => false,
    },
  };
});

vi.mock('../../src/db/database', () => dbMock);
vi.mock('../../src/config', () => ({
  JWT_SECRET: 'test-jwt-secret-for-trek-testing-only',
  ENCRYPTION_KEY: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6a7b8c9d0e1f2a3b4c5d6a7b8c9d0e1f2',
  updateJwtSecret: () => {},
}));

import { createApp } from '../../src/app';
import { createTables } from '../../src/db/schema';
import { runMigrations } from '../../src/db/migrations';
import { resetTestDb } from '../helpers/test-db';
import { createUser } from '../helpers/factories';
import { authCookie } from '../helpers/auth';

const app: Application = createApp();

beforeAll(() => {
  createTables(testDb);
  runMigrations(testDb);
});

beforeEach(() => {
  resetTestDb(testDb);
});

// ── Core: create / get / rename / leave ────────────────────────────────────

describe('POST /api/household', () => {
  it('creates a household for the caller', async () => {
    const { user } = createUser(testDb);
    const res = await request(app)
      .post('/api/household')
      .set('Cookie', authCookie(user.id))
      .send({ name: 'The Keys' });
    expect(res.status).toBe(201);
    expect(res.body.household.name).toBe('The Keys');
    expect(res.body.household.users.map((u: any) => u.id)).toContain(user.id);
  });

  it('returns 409 ALREADY_IN_HOUSEHOLD on second create', async () => {
    const { user } = createUser(testDb);
    await request(app).post('/api/household').set('Cookie', authCookie(user.id)).send({});
    const res = await request(app).post('/api/household').set('Cookie', authCookie(user.id)).send({ name: 'Take 2' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ALREADY_IN_HOUSEHOLD');
  });
});

describe('GET /api/household', () => {
  it('returns null household for a fresh user with empty invite lists', async () => {
    const { user } = createUser(testDb);
    const res = await request(app).get('/api/household').set('Cookie', authCookie(user.id));
    expect(res.status).toBe(200);
    expect(res.body.household).toBeNull();
    expect(res.body.incoming).toEqual([]);
    expect(res.body.outgoing).toEqual([]);
  });

  it('returns the snapshot with users + members + outgoing invites', async () => {
    const { user } = createUser(testDb);
    await request(app).post('/api/household').set('Cookie', authCookie(user.id)).send({ name: 'Mine' });
    await request(app).post('/api/household/members').set('Cookie', authCookie(user.id)).send({ name: 'Emily', relationship: 'daughter' });
    await request(app).post('/api/household/invites').set('Cookie', authCookie(user.id)).send({ email: 'someone@example.com' });
    const res = await request(app).get('/api/household').set('Cookie', authCookie(user.id));
    expect(res.body.household.members).toHaveLength(1);
    expect(res.body.outgoing).toHaveLength(1);
    expect(res.body.outgoing[0].invitee_email).toBe('someone@example.com');
  });
});

describe('PATCH /api/household', () => {
  it('renames the household', async () => {
    const { user } = createUser(testDb);
    await request(app).post('/api/household').set('Cookie', authCookie(user.id)).send({ name: 'Old' });
    const res = await request(app).patch('/api/household').set('Cookie', authCookie(user.id)).send({ name: 'New' });
    expect(res.status).toBe(200);
    expect(res.body.household.name).toBe('New');
  });

  it('rejects when caller has no household', async () => {
    const { user } = createUser(testDb);
    const res = await request(app).patch('/api/household').set('Cookie', authCookie(user.id)).send({ name: 'X' });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_IN_HOUSEHOLD');
  });
});

describe('DELETE /api/household', () => {
  it('leaves the household (idempotent when not in one)', async () => {
    const { user } = createUser(testDb);
    const first = await request(app).delete('/api/household').set('Cookie', authCookie(user.id));
    expect(first.status).toBe(200);
    await request(app).post('/api/household').set('Cookie', authCookie(user.id)).send({});
    const second = await request(app).delete('/api/household').set('Cookie', authCookie(user.id));
    expect(second.status).toBe(200);
    const row = testDb.prepare('SELECT household_id FROM users WHERE id = ?').get(user.id) as { household_id: number | null };
    expect(row.household_id).toBeNull();
  });
});

// ── Invites: send / cancel / accept / decline ──────────────────────────────

describe('POST /api/household/invites', () => {
  it('creates a pending invite and lists it as outgoing', async () => {
    const { user } = createUser(testDb);
    await request(app).post('/api/household').set('Cookie', authCookie(user.id)).send({});
    const res = await request(app).post('/api/household/invites').set('Cookie', authCookie(user.id)).send({ email: 'partner@example.com' });
    expect(res.status).toBe(201);
    expect(res.body.invite.invitee_email).toBe('partner@example.com');
    expect(res.body.invite.token).toBeTruthy();
    expect(res.body.invite.status).toBe('pending');
  });

  it('rejects self-invite', async () => {
    const { user } = createUser(testDb);
    await request(app).post('/api/household').set('Cookie', authCookie(user.id)).send({});
    const res = await request(app).post('/api/household/invites').set('Cookie', authCookie(user.id)).send({ email: user.email });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('SELF_INVITE');
  });

  it('rejects when caller has no household', async () => {
    const { user } = createUser(testDb);
    const res = await request(app).post('/api/household/invites').set('Cookie', authCookie(user.id)).send({ email: 'x@example.com' });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_IN_HOUSEHOLD');
  });

  it('rejects duplicate pending invite for an email with NO account', async () => {
    // When the invitee still has no account, a re-send has no one to notify —
    // keep returning 409 (the pending invite already covers them; it surfaces
    // the moment they register, matched by email).
    const { user } = createUser(testDb);
    await request(app).post('/api/household').set('Cookie', authCookie(user.id)).send({});
    await request(app).post('/api/household/invites').set('Cookie', authCookie(user.id)).send({ email: 'x@example.com' });
    const dup = await request(app).post('/api/household/invites').set('Cookie', authCookie(user.id)).send({ email: 'x@example.com' });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('PENDING_INVITE_EXISTS');
  });

  it('re-sends (re-notifies) instead of 409 once the invitee has registered', async () => {
    // [460-fork] Regression for the exact real-world flow that broke for the
    // first companion: an email is invited BEFORE that person registers (so
    // the original invite can't notify anyone), they then register, and the
    // inviter re-sends. The re-send must NOT be silently rejected as a
    // duplicate — it has to succeed so the notification finally fires for the
    // now-existing account. It must reuse the SAME pending invite (no dup row).
    const { user: alice } = createUser(testDb);
    await request(app).post('/api/household').set('Cookie', authCookie(alice.id)).send({ name: 'Keys' });

    // 1) Invite an email that has no account yet → pending invite, no notify.
    const first = await request(app).post('/api/household/invites')
      .set('Cookie', authCookie(alice.id)).send({ email: 'late@example.com' });
    expect(first.status).toBe(201);
    const token = first.body.invite.token as string;

    // 2) That person registers with the same email.
    const { user: bob } = createUser(testDb, { email: 'late@example.com' });

    // 3) Inviter re-sends → must succeed (201), reference the SAME invite, and
    //    not create a second row.
    const resend = await request(app).post('/api/household/invites')
      .set('Cookie', authCookie(alice.id)).send({ email: 'late@example.com' });
    expect(resend.status).toBe(201);
    expect(resend.body.invite.token).toBe(token);
    const count = testDb
      .prepare("SELECT COUNT(*) AS c FROM household_invites WHERE LOWER(invitee_email) = 'late@example.com'")
      .get() as { c: number };
    expect(count.c).toBe(1);

    // 4) And the invite is discoverable by the invitee — this is exactly what
    //    the home-screen invite banner reads (GET /api/household → incoming).
    const bobView = await request(app).get('/api/household').set('Cookie', authCookie(bob.id));
    expect(bobView.status).toBe(200);
    expect(bobView.body.incoming.map((i: { token: string }) => i.token)).toContain(token);
  });
});

describe('POST /api/household/invites/:token/accept', () => {
  it('moves the invitee into the household', async () => {
    const { user: alice } = createUser(testDb);
    const { user: bob } = createUser(testDb);
    await request(app).post('/api/household').set('Cookie', authCookie(alice.id)).send({ name: 'Alices' });
    const inv = await request(app).post('/api/household/invites').set('Cookie', authCookie(alice.id)).send({ email: bob.email });
    expect(inv.status).toBe(201);
    const token = inv.body.invite.token;

    const accept = await request(app).post(`/api/household/invites/${token}/accept`).set('Cookie', authCookie(bob.id));
    expect(accept.status).toBe(200);
    expect(accept.body.household.users.map((u: any) => u.id).sort()).toEqual([alice.id, bob.id].sort());

    const bobRow = testDb.prepare('SELECT household_id FROM users WHERE id = ?').get(bob.id) as { household_id: number };
    const aliceRow = testDb.prepare('SELECT household_id FROM users WHERE id = ?').get(alice.id) as { household_id: number };
    expect(bobRow.household_id).toBe(aliceRow.household_id);
  });

  it('rejects accept by a user whose email does not match the invite', async () => {
    const { user: alice } = createUser(testDb);
    const { user: bob } = createUser(testDb);
    const { user: carol } = createUser(testDb);
    await request(app).post('/api/household').set('Cookie', authCookie(alice.id)).send({});
    const inv = await request(app).post('/api/household/invites').set('Cookie', authCookie(alice.id)).send({ email: bob.email });
    const res = await request(app).post(`/api/household/invites/${inv.body.invite.token}/accept`).set('Cookie', authCookie(carol.id));
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('INVITE_NOT_FOR_YOU');
  });

  it('returns 404 on unknown token', async () => {
    const { user } = createUser(testDb);
    const res = await request(app).post('/api/household/invites/garbage-token/accept').set('Cookie', authCookie(user.id));
    expect(res.status).toBe(404);
  });
});

describe('POST /api/household/invites/:token/decline', () => {
  it('marks the invite declined and does NOT add the user', async () => {
    const { user: alice } = createUser(testDb);
    const { user: bob } = createUser(testDb);
    await request(app).post('/api/household').set('Cookie', authCookie(alice.id)).send({});
    const inv = await request(app).post('/api/household/invites').set('Cookie', authCookie(alice.id)).send({ email: bob.email });
    const res = await request(app).post(`/api/household/invites/${inv.body.invite.token}/decline`).set('Cookie', authCookie(bob.id));
    expect(res.status).toBe(200);
    const bobRow = testDb.prepare('SELECT household_id FROM users WHERE id = ?').get(bob.id) as { household_id: number | null };
    expect(bobRow.household_id).toBeNull();
  });
});

describe('DELETE /api/household/invites/:id (cancel)', () => {
  it('cancels an outgoing invite', async () => {
    const { user } = createUser(testDb);
    await request(app).post('/api/household').set('Cookie', authCookie(user.id)).send({});
    const inv = await request(app).post('/api/household/invites').set('Cookie', authCookie(user.id)).send({ email: 'x@example.com' });
    const res = await request(app).delete(`/api/household/invites/${inv.body.invite.id}`).set('Cookie', authCookie(user.id));
    expect(res.status).toBe(200);
    const row = testDb.prepare('SELECT status FROM household_invites WHERE id = ?').get(inv.body.invite.id) as { status: string };
    expect(row.status).toBe('cancelled');
  });
});

// ── Named members ──────────────────────────────────────────────────────────

describe('Named members CRUD', () => {
  it('creates a member', async () => {
    const { user } = createUser(testDb);
    await request(app).post('/api/household').set('Cookie', authCookie(user.id)).send({});
    const res = await request(app).post('/api/household/members').set('Cookie', authCookie(user.id)).send({ name: 'Emily', dob: '2018-04-12' });
    expect(res.status).toBe(201);
    expect(res.body.member.name).toBe('Emily');
    expect(res.body.member.dob).toBe('2018-04-12');
  });

  it('updates a member partially', async () => {
    const { user } = createUser(testDb);
    await request(app).post('/api/household').set('Cookie', authCookie(user.id)).send({});
    const m = await request(app).post('/api/household/members').set('Cookie', authCookie(user.id)).send({ name: 'Emily' });
    const res = await request(app).put(`/api/household/members/${m.body.member.id}`).set('Cookie', authCookie(user.id)).send({ dob: '2018-04-12' });
    expect(res.status).toBe(200);
    expect(res.body.member.name).toBe('Emily');
    expect(res.body.member.dob).toBe('2018-04-12');
  });

  it('deletes a member', async () => {
    const { user } = createUser(testDb);
    await request(app).post('/api/household').set('Cookie', authCookie(user.id)).send({});
    const m = await request(app).post('/api/household/members').set('Cookie', authCookie(user.id)).send({ name: 'Emily' });
    const res = await request(app).delete(`/api/household/members/${m.body.member.id}`).set('Cookie', authCookie(user.id));
    expect(res.status).toBe(200);
    const row = testDb.prepare('SELECT id FROM household_members WHERE id = ?').get(m.body.member.id);
    expect(row).toBeUndefined();
  });

  it('blocks editing a member of a different household (403)', async () => {
    const { user: alice } = createUser(testDb);
    const { user: bob } = createUser(testDb);
    await request(app).post('/api/household').set('Cookie', authCookie(alice.id)).send({});
    await request(app).post('/api/household').set('Cookie', authCookie(bob.id)).send({});
    const aliceMember = await request(app).post('/api/household/members').set('Cookie', authCookie(alice.id)).send({ name: 'Emily' });
    const res = await request(app).put(`/api/household/members/${aliceMember.body.member.id}`).set('Cookie', authCookie(bob.id)).send({ name: 'Hijacked' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('NOT_AUTHORISED');
  });
});

// Legacy M3 partner endpoints were removed in M11 slice 3 — no tests
// against them.
