/**
 * Integration tests for the partner-pairing HTTP surface (Milestone 3 slice 2).
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
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

afterAll(() => {
  testDb.close();
});

describe('GET /api/auth/me/partner', () => {
  it('401 unauthenticated', async () => {
    const res = await request(app).get('/api/auth/me/partner');
    expect(res.status).toBe(401);
  });

  it('returns null partner and empty invite arrays for a fresh user', async () => {
    const { user } = createUser(testDb);
    const res = await request(app)
      .get('/api/auth/me/partner')
      .set('Cookie', authCookie(user.id));
    expect(res.status).toBe(200);
    expect(res.body.partner).toBeNull();
    expect(res.body.incoming).toEqual([]);
    expect(res.body.outgoing).toEqual([]);
  });
});

describe('POST /api/auth/me/partner/invites', () => {
  it('rejects missing identifier', async () => {
    const { user } = createUser(testDb);
    const res = await request(app)
      .post('/api/auth/me/partner/invites')
      .set('Cookie', authCookie(user.id))
      .send({});
    expect(res.status).toBe(400);
  });

  it('rejects self-invite', async () => {
    const { user } = createUser(testDb);
    const res = await request(app)
      .post('/api/auth/me/partner/invites')
      .set('Cookie', authCookie(user.id))
      .send({ identifier: user.email });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('SELF_INVITE');
  });

  it('returns 404 for unknown identifier', async () => {
    const { user } = createUser(testDb);
    const res = await request(app)
      .post('/api/auth/me/partner/invites')
      .set('Cookie', authCookie(user.id))
      .send({ identifier: 'nobody@example.com' });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('USER_NOT_FOUND');
  });

  it('creates invite and shows it in target incoming + inviter outgoing', async () => {
    const { user: alice } = createUser(testDb);
    const { user: bob } = createUser(testDb);
    const post = await request(app)
      .post('/api/auth/me/partner/invites')
      .set('Cookie', authCookie(alice.id))
      .send({ identifier: bob.email, message: 'Be my partner!' });
    expect(post.status).toBe(201);
    expect(post.body.invite.target.id).toBe(bob.id);
    expect(post.body.invite.message).toBe('Be my partner!');

    const bobView = await request(app).get('/api/auth/me/partner').set('Cookie', authCookie(bob.id));
    expect(bobView.body.incoming).toHaveLength(1);
    expect(bobView.body.incoming[0].inviter.id).toBe(alice.id);

    const aliceView = await request(app).get('/api/auth/me/partner').set('Cookie', authCookie(alice.id));
    expect(aliceView.body.outgoing).toHaveLength(1);
  });

  it('idempotent on X-Client-Mutation-Id replay', async () => {
    const { user: alice } = createUser(testDb);
    const { user: bob } = createUser(testDb);
    const cmid = 'test-cmid-' + Math.random();
    const first = await request(app)
      .post('/api/auth/me/partner/invites')
      .set('Cookie', authCookie(alice.id))
      .set('X-Client-Mutation-Id', cmid)
      .send({ identifier: bob.email });
    const second = await request(app)
      .post('/api/auth/me/partner/invites')
      .set('Cookie', authCookie(alice.id))
      .set('X-Client-Mutation-Id', cmid)
      .send({ identifier: bob.email });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body.invite.id).toBe(first.body.invite.id);
  });
});

describe('DELETE /api/auth/me/partner/invites/:id (cancel)', () => {
  it('only inviter can cancel; non-inviter gets 404', async () => {
    const { user: alice } = createUser(testDb);
    const { user: bob } = createUser(testDb);
    const send = await request(app)
      .post('/api/auth/me/partner/invites')
      .set('Cookie', authCookie(alice.id))
      .send({ identifier: bob.email });
    const inviteId = send.body.invite.id;

    const wrong = await request(app)
      .delete(`/api/auth/me/partner/invites/${inviteId}`)
      .set('Cookie', authCookie(bob.id));
    expect(wrong.status).toBe(404);

    const right = await request(app)
      .delete(`/api/auth/me/partner/invites/${inviteId}`)
      .set('Cookie', authCookie(alice.id));
    expect(right.status).toBe(200);
  });
});

describe('Partner pair/unpair via notification respond endpoint', () => {
  it('accept via respond endpoint pairs both users and /me returns partner', async () => {
    const { user: alice } = createUser(testDb);
    const { user: bob } = createUser(testDb);

    // Alice sends invite
    const send = await request(app)
      .post('/api/auth/me/partner/invites')
      .set('Cookie', authCookie(alice.id))
      .send({ identifier: bob.email });
    expect(send.status).toBe(201);

    // The in-app boolean notification created for Bob will have a
    // corresponding notification row. Poll briefly for it — the dispatch
    // uses dynamic import().then() so it lands a microtask or two later.
    let notif: { id: number; type: string } | undefined;
    for (let i = 0; i < 40; i++) {
      notif = testDb
        .prepare("SELECT id, type FROM notifications WHERE recipient_id = ? AND title_key = 'notif.partner_invite.title' ORDER BY id DESC LIMIT 1")
        .get(bob.id) as { id: number; type: string } | undefined;
      if (notif) break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    expect(notif).toBeDefined();
    expect(notif?.type).toBe('boolean');

    const respond = await request(app)
      .post(`/api/notifications/in-app/${notif!.id}/respond`)
      .set('Cookie', authCookie(bob.id))
      .send({ response: 'positive' });
    if (respond.status !== 200) {
      console.log('respond body:', respond.body);
      console.log('notif row:', testDb.prepare('SELECT * FROM notifications WHERE id = ?').get(notif!.id));
    }
    expect(respond.status).toBe(200);

    // Both users are now paired — check users table directly (the /me
    // endpoint's partner field is exercised in a separate test).
    const aliceRow = testDb.prepare('SELECT partner_user_id FROM users WHERE id = ?').get(alice.id) as any;
    const bobRow = testDb.prepare('SELECT partner_user_id FROM users WHERE id = ?').get(bob.id) as any;
    expect(aliceRow.partner_user_id).toBe(bob.id);
    expect(bobRow.partner_user_id).toBe(alice.id);

    // And /api/auth/me/partner + /api/auth/me both reflect the pairing.
    const aliceGet = await request(app).get('/api/auth/me/partner').set('Cookie', authCookie(alice.id));
    expect(aliceGet.body.partner?.id).toBe(bob.id);

    const aliceMe = await request(app).get('/api/auth/me').set('Cookie', authCookie(alice.id));
    expect(aliceMe.body.user.partner?.id).toBe(bob.id);
  });
});

describe('DELETE /api/auth/me/partner (unpair)', () => {
  it('clears both users symmetrically and preserves trip_members history', async () => {
    const { user: alice } = createUser(testDb);
    const { user: bob } = createUser(testDb);

    // Pair directly via SQL for speed — service-level happy path is covered above.
    testDb.prepare('UPDATE users SET partner_user_id = ? WHERE id = ?').run(bob.id, alice.id);
    testDb.prepare('UPDATE users SET partner_user_id = ? WHERE id = ?').run(alice.id, bob.id);

    // Arrange: Alice has a trip; Bob is a trip_member (as if he'd been auto-added earlier).
    const tripRes = testDb.prepare('INSERT INTO trips (user_id, title) VALUES (?, ?)').run(alice.id, 'Europe');
    const tripId = tripRes.lastInsertRowid as number;
    testDb.prepare('INSERT INTO trip_members (trip_id, user_id, invited_by) VALUES (?, ?, ?)').run(tripId, bob.id, alice.id);

    const res = await request(app)
      .delete('/api/auth/me/partner')
      .set('Cookie', authCookie(alice.id));
    expect(res.status).toBe(200);

    const aliceRow = testDb.prepare('SELECT partner_user_id FROM users WHERE id = ?').get(alice.id) as any;
    const bobRow = testDb.prepare('SELECT partner_user_id FROM users WHERE id = ?').get(bob.id) as any;
    expect(aliceRow.partner_user_id).toBeNull();
    expect(bobRow.partner_user_id).toBeNull();

    const member = testDb.prepare('SELECT * FROM trip_members WHERE trip_id = ? AND user_id = ?').get(tripId, bob.id);
    expect(member).toBeDefined();
  });

  it('unpair when not paired is success (idempotent)', async () => {
    const { user: alice } = createUser(testDb);
    const res = await request(app)
      .delete('/api/auth/me/partner')
      .set('Cookie', authCookie(alice.id));
    expect(res.status).toBe(200);
  });
});
