/**
 * [460-fork] Milestone 9 — pre-trip availability polls.
 * Covers POLL-001 to POLL-008.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import type { Application } from 'express';

const { testDb, dbMock } = vi.hoisted(() => {
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  const mock = {
    db,
    closeDb: () => {},
    reinitialize: () => {},
    canAccessTrip: () => null,
    isOwner: () => false,
  };
  return { testDb: db, dbMock: mock };
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
import { loginAttempts, mfaAttempts } from '../../src/routes/auth';

const app: Application = createApp();

beforeAll(() => {
  createTables(testDb);
  runMigrations(testDb);
});

beforeEach(() => {
  resetTestDb(testDb);
  loginAttempts.clear();
  mfaAttempts.clear();
});

afterAll(() => {
  testDb.close();
});

describe('Owner CRUD', () => {
  it('POLL-001 — POST creates a poll with options and returns a share_token', async () => {
    const { user } = createUser(testDb);
    const res = await request(app)
      .post('/api/polls')
      .set('Cookie', authCookie(user.id))
      .send({
        title: 'Easter trip dates?',
        description: 'When can the four of us go?',
        options: [
          { start_date: '2026-04-03', end_date: '2026-04-10' },
          { start_date: '2026-04-10', end_date: '2026-04-17' },
        ],
      });
    expect(res.status).toBe(201);
    expect(res.body.poll.title).toBe('Easter trip dates?');
    expect(res.body.poll.share_token).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.body.poll.options).toHaveLength(2);
    expect(res.body.poll.options[0].sort_order).toBe(0);
    expect(res.body.poll.options[1].sort_order).toBe(1);
  });

  it('POLL-002 — POST without title or options returns 400', async () => {
    const { user } = createUser(testDb);
    const r1 = await request(app).post('/api/polls').set('Cookie', authCookie(user.id)).send({ title: '', options: [{ start_date: '2026-04-03', end_date: '2026-04-10' }] });
    expect(r1.status).toBe(400);
    const r2 = await request(app).post('/api/polls').set('Cookie', authCookie(user.id)).send({ title: 'X', options: [] });
    expect(r2.status).toBe(400);
  });

  it('POLL-003 — GET / lists my polls only', async () => {
    const { user: a } = createUser(testDb);
    const { user: b } = createUser(testDb);
    await request(app).post('/api/polls').set('Cookie', authCookie(a.id)).send({ title: 'A poll', options: [{ start_date: '2026-05-01', end_date: '2026-05-08' }] });
    await request(app).post('/api/polls').set('Cookie', authCookie(b.id)).send({ title: 'B poll', options: [{ start_date: '2026-05-01', end_date: '2026-05-08' }] });

    const res = await request(app).get('/api/polls').set('Cookie', authCookie(a.id));
    expect(res.body.polls).toHaveLength(1);
    expect(res.body.polls[0].title).toBe('A poll');
  });

  it('POLL-004 — DELETE removes the poll and cascades to options + votes', async () => {
    const { user } = createUser(testDb);
    const created = await request(app).post('/api/polls').set('Cookie', authCookie(user.id)).send({
      title: 'Doomed', options: [{ start_date: '2026-06-01', end_date: '2026-06-08' }],
    });
    const pollId = created.body.poll.id;

    // Cast a public vote so we can verify the cascade.
    const token = created.body.poll.share_token;
    const optionId = created.body.poll.options[0].id;
    await request(app).post(`/api/polls/share/${token}/votes`).send({
      voter_name: 'Anon', voter_browser_id: 'browser-1',
      choices: [{ option_id: optionId, choice: 'yes' }],
    });

    const del = await request(app).delete(`/api/polls/${pollId}`).set('Cookie', authCookie(user.id));
    expect(del.status).toBe(200);

    const opts = testDb.prepare('SELECT id FROM availability_poll_options WHERE poll_id = ?').all(pollId);
    const votes = testDb.prepare('SELECT id FROM availability_poll_votes WHERE poll_id = ?').all(pollId);
    expect(opts).toHaveLength(0);
    expect(votes).toHaveLength(0);
  });
});

describe('Public share + voting', () => {
  it('POLL-005 — GET /share/:token returns poll without owner_user_id', async () => {
    const { user } = createUser(testDb);
    const created = await request(app).post('/api/polls').set('Cookie', authCookie(user.id)).send({
      title: 'Share me', options: [{ start_date: '2026-07-01', end_date: '2026-07-08' }],
    });
    const token = created.body.poll.share_token;

    // No auth cookie — public access.
    const res = await request(app).get(`/api/polls/share/${token}`);
    expect(res.status).toBe(200);
    expect(res.body.poll.title).toBe('Share me');
    expect(res.body.poll.owner_user_id).toBeUndefined();
    expect(res.body.poll.finalised_trip_id).toBeUndefined();
    expect(res.body.poll.options).toHaveLength(1);
    expect(res.body.poll.votes).toEqual([]);
  });

  it('POLL-006 — POST /share/:token/votes upserts so the same browser can revise', async () => {
    const { user } = createUser(testDb);
    const created = await request(app).post('/api/polls').set('Cookie', authCookie(user.id)).send({
      title: 'Revise', options: [
        { start_date: '2026-08-01', end_date: '2026-08-08' },
        { start_date: '2026-08-15', end_date: '2026-08-22' },
      ],
    });
    const token = created.body.poll.share_token;
    const optA = created.body.poll.options[0].id;
    const optB = created.body.poll.options[1].id;

    // First submission.
    const r1 = await request(app).post(`/api/polls/share/${token}/votes`).send({
      voter_name: 'Alice',
      voter_browser_id: 'browser-alice',
      choices: [
        { option_id: optA, choice: 'yes' },
        { option_id: optB, choice: 'no' },
      ],
    });
    expect(r1.status).toBe(200);
    expect(r1.body.votes).toHaveLength(2);

    // Same browser revises.
    const r2 = await request(app).post(`/api/polls/share/${token}/votes`).send({
      voter_name: 'Alice',
      voter_browser_id: 'browser-alice',
      choices: [
        { option_id: optA, choice: 'maybe' },
        { option_id: optB, choice: 'yes' },
      ],
    });
    expect(r2.status).toBe(200);

    // Read full poll — should still be 2 votes (upsert, not duplicate).
    const owner = await request(app).get(`/api/polls/${created.body.poll.id}`).set('Cookie', authCookie(user.id));
    expect(owner.body.poll.votes).toHaveLength(2);
    const choices = owner.body.poll.votes.reduce((acc: Record<number, string>, v: { option_id: number; choice: string }) => { acc[v.option_id] = v.choice; return acc; }, {});
    expect(choices[optA]).toBe('maybe');
    expect(choices[optB]).toBe('yes');
  });

  it('POLL-007 — different voters can both vote without conflict', async () => {
    const { user } = createUser(testDb);
    const created = await request(app).post('/api/polls').set('Cookie', authCookie(user.id)).send({
      title: 'Multi-voter', options: [{ start_date: '2026-09-01', end_date: '2026-09-08' }],
    });
    const token = created.body.poll.share_token;
    const optId = created.body.poll.options[0].id;

    await request(app).post(`/api/polls/share/${token}/votes`).send({
      voter_name: 'Alice', voter_browser_id: 'b-alice', choices: [{ option_id: optId, choice: 'yes' }],
    });
    await request(app).post(`/api/polls/share/${token}/votes`).send({
      voter_name: 'Bob', voter_browser_id: 'b-bob', choices: [{ option_id: optId, choice: 'no' }],
    });

    const res = await request(app).get(`/api/polls/${created.body.poll.id}`).set('Cookie', authCookie(user.id));
    expect(res.body.poll.votes).toHaveLength(2);
  });

  it('POLL-008 — GET /share/:badtoken returns 404', async () => {
    const res = await request(app).get('/api/polls/share/totally-not-a-token');
    expect(res.status).toBe(404);
  });
});

describe('Convert poll to trip (slice 9.3)', () => {
  it('POLL-009 — POST /:id/convert creates a trip with the option dates and sets finalised_trip_id', async () => {
    const { user } = createUser(testDb);
    const created = await request(app).post('/api/polls').set('Cookie', authCookie(user.id)).send({
      title: 'Convert me',
      options: [
        { start_date: '2026-09-01', end_date: '2026-09-08' },
        { start_date: '2026-09-15', end_date: '2026-09-22' },
      ],
    });
    const pollId = created.body.poll.id;
    const winningOptId = created.body.poll.options[1].id;

    const res = await request(app).post(`/api/polls/${pollId}/convert`).set('Cookie', authCookie(user.id)).send({ option_id: winningOptId, title: 'Tuscany trip' });
    expect(res.status).toBe(201);
    expect(res.body.trip_id).toBeGreaterThan(0);

    const trip = testDb.prepare('SELECT * FROM trips WHERE id = ?').get(res.body.trip_id) as { title: string; start_date: string; end_date: string; user_id: number };
    expect(trip.title).toBe('Tuscany trip');
    expect(trip.start_date).toBe('2026-09-15');
    expect(trip.end_date).toBe('2026-09-22');
    expect(trip.user_id).toBe(user.id);

    const refreshed = await request(app).get(`/api/polls/${pollId}`).set('Cookie', authCookie(user.id));
    expect(refreshed.body.poll.finalised_trip_id).toBe(res.body.trip_id);
  });

  it('POLL-010 — voter with matching email is auto-invited; unmatched surface as manual hints', async () => {
    const { user: owner } = createUser(testDb, { email: 'owner@test.example.com' });
    const { user: alice } = createUser(testDb, { email: 'alice@test.example.com' });
    // bob has no account on this instance.

    const created = await request(app).post('/api/polls').set('Cookie', authCookie(owner.id)).send({
      title: 'Multi voter convert',
      options: [{ start_date: '2026-10-05', end_date: '2026-10-12' }],
    });
    const pollId = created.body.poll.id;
    const optId = created.body.poll.options[0].id;
    const token = created.body.poll.share_token;

    // Alice voted yes WITH her real email.
    await request(app).post(`/api/polls/share/${token}/votes`).send({
      voter_name: 'Alice', voter_email: 'alice@test.example.com', voter_browser_id: 'b-alice',
      choices: [{ option_id: optId, choice: 'yes' }],
    });
    // Bob voted maybe WITHOUT email.
    await request(app).post(`/api/polls/share/${token}/votes`).send({
      voter_name: 'Bob', voter_browser_id: 'b-bob',
      choices: [{ option_id: optId, choice: 'maybe' }],
    });
    // Carol voted no — should not show up in invites.
    await request(app).post(`/api/polls/share/${token}/votes`).send({
      voter_name: 'Carol', voter_email: 'carol@test.example.com', voter_browser_id: 'b-carol',
      choices: [{ option_id: optId, choice: 'no' }],
    });

    const res = await request(app).post(`/api/polls/${pollId}/convert`).set('Cookie', authCookie(owner.id)).send({ option_id: optId });
    expect(res.status).toBe(201);
    expect(res.body.invited_user_ids).toEqual([alice.id]);
    expect(res.body.manual_invite_hints).toHaveLength(1);
    expect(res.body.manual_invite_hints[0].name).toBe('Bob');
    expect(res.body.manual_invite_hints[0].email).toBeNull();

    // Confirm trip_members row was created for Alice.
    const member = testDb.prepare('SELECT user_id FROM trip_members WHERE trip_id = ?').get(res.body.trip_id) as { user_id: number };
    expect(member.user_id).toBe(alice.id);
  });

  it('POLL-011 — converting twice returns 409', async () => {
    const { user } = createUser(testDb);
    const created = await request(app).post('/api/polls').set('Cookie', authCookie(user.id)).send({
      title: 'Double convert',
      options: [{ start_date: '2026-11-01', end_date: '2026-11-08' }],
    });
    const pollId = created.body.poll.id;
    const optId = created.body.poll.options[0].id;

    const r1 = await request(app).post(`/api/polls/${pollId}/convert`).set('Cookie', authCookie(user.id)).send({ option_id: optId });
    expect(r1.status).toBe(201);
    const r2 = await request(app).post(`/api/polls/${pollId}/convert`).set('Cookie', authCookie(user.id)).send({ option_id: optId });
    expect(r2.status).toBe(409);
  });

  it('POLL-012 — non-owner cannot convert', async () => {
    const { user: owner } = createUser(testDb);
    const { user: stranger } = createUser(testDb);
    const created = await request(app).post('/api/polls').set('Cookie', authCookie(owner.id)).send({
      title: 'Owner-only convert',
      options: [{ start_date: '2026-12-01', end_date: '2026-12-08' }],
    });
    const pollId = created.body.poll.id;
    const optId = created.body.poll.options[0].id;

    const res = await request(app).post(`/api/polls/${pollId}/convert`).set('Cookie', authCookie(stranger.id)).send({ option_id: optId });
    expect(res.status).toBe(403);
  });
});
