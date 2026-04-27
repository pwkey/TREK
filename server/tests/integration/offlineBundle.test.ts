/**
 * Integration test for GET /api/trips/:id/offline-bundle (Milestone 5 slice 5).
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
      canAccessTrip: (tripId: any, userId: number) =>
        db.prepare(`SELECT t.id, t.user_id FROM trips t LEFT JOIN trip_members m ON m.trip_id = t.id AND m.user_id = ? WHERE t.id = ? AND (t.user_id = ? OR m.user_id IS NOT NULL)`).get(userId, tripId, userId),
      isOwner: (tripId: any, userId: number) =>
        !!db.prepare('SELECT id FROM trips WHERE id = ? AND user_id = ?').get(tripId, userId),
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
import { createUser, createTrip } from '../helpers/factories';
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

describe('GET /api/trips/:id/offline-bundle', () => {
  it('returns the trip + days + places + budget + packing + todo + reservations + files in one payload', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id, { title: 'Europe', start_date: '2027-06-10', end_date: '2027-06-12' });
    const res = await request(app).get(`/api/trips/${trip.id}/offline-bundle`).set('Cookie', authCookie(user.id));
    expect(res.status).toBe(200);
    expect(res.body.schema_version).toBe(1);
    expect(res.body.bundled_at).toBeTruthy();
    expect(res.body.trip.id).toBe(trip.id);
    expect(Array.isArray(res.body.days)).toBe(true);
    expect(res.body.days.length).toBe(3);
    expect(Array.isArray(res.body.places)).toBe(true);
    expect(Array.isArray(res.body.reservations)).toBe(true);
    expect(Array.isArray(res.body.budget_items)).toBe(true);
    expect(Array.isArray(res.body.packing_items)).toBe(true);
    expect(Array.isArray(res.body.todo_items)).toBe(true);
    expect(Array.isArray(res.body.files)).toBe(true);
  });

  it('404s for an unrelated user (no trip access)', async () => {
    const { user: alice } = createUser(testDb);
    const { user: bob } = createUser(testDb);
    const aTrip = createTrip(testDb, alice.id, { title: "Alice's" });
    const res = await request(app).get(`/api/trips/${aTrip.id}/offline-bundle`).set('Cookie', authCookie(bob.id));
    expect(res.status).toBe(404);
  });

  it('401s without auth', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id, { title: 'T' });
    const res = await request(app).get(`/api/trips/${trip.id}/offline-bundle`);
    expect(res.status).toBe(401);
  });
});
