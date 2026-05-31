/**
 * Unit tests for the household service (M11 slice 1).
 *
 * Mirrors the structure of the deleted partnerService.test.ts but exercises
 * the multi-user + named-member model. Slice-2 invite/accept tests live in
 * tests/integration/household.test.ts when slice 2 ships.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

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

vi.mock('../../../src/db/database', () => dbMock);

import { createTables } from '../../../src/db/schema';
import { runMigrations } from '../../../src/db/migrations';
import { resetTestDb } from '../../helpers/test-db';
import { createUser } from '../../helpers/factories';
import {
  createHousehold,
  getHouseholdForUser,
  getOtherHouseholdUserIds,
  renameHousehold,
  leaveHousehold,
  addMember,
  updateMember,
  deleteMember,
  autoAddHouseholdToTrip,
} from '../../../src/services/householdService';

beforeAll(() => {
  createTables(testDb);
  runMigrations(testDb);
});

beforeEach(() => {
  resetTestDb(testDb);
});

// ---------------------------------------------------------------------------
// createHousehold + getHouseholdForUser
// ---------------------------------------------------------------------------

describe('createHousehold', () => {
  it('creates a household, sets users.household_id, and returns a snapshot', () => {
    const { user } = createUser(testDb);
    const result = createHousehold({ userId: user.id, name: 'The Keys' });
    expect('household' in result).toBe(true);
    if (!('household' in result)) return;
    expect(result.household.name).toBe('The Keys');
    expect(result.household.users).toHaveLength(1);
    expect(result.household.users[0].id).toBe(user.id);
    expect(result.household.members).toEqual([]);

    const after = testDb.prepare('SELECT household_id FROM users WHERE id = ?').get(user.id) as { household_id: number };
    expect(after.household_id).toBe(result.household.id);
  });

  it('rejects a user who is already in a household', () => {
    const { user } = createUser(testDb);
    createHousehold({ userId: user.id });
    const second = createHousehold({ userId: user.id, name: 'Take 2' });
    expect('error' in second).toBe(true);
    if ('error' in second) {
      expect(second.code).toBe('ALREADY_IN_HOUSEHOLD');
    }
  });

  it('accepts a null name', () => {
    const { user } = createUser(testDb);
    const result = createHousehold({ userId: user.id });
    if (!('household' in result)) throw new Error('unreachable');
    expect(result.household.name).toBeNull();
  });

  it('trims and caps the name at 100 chars', () => {
    const { user } = createUser(testDb);
    const long = '  ' + 'x'.repeat(200) + '  ';
    const result = createHousehold({ userId: user.id, name: long });
    if (!('household' in result)) throw new Error('unreachable');
    expect(result.household.name?.length).toBe(100);
  });
});

describe('getHouseholdForUser', () => {
  it('returns null when the user is not in a household', () => {
    const { user } = createUser(testDb);
    expect(getHouseholdForUser(user.id)).toBeNull();
  });

  it('returns the household snapshot with all users + members', () => {
    const { user: u1 } = createUser(testDb);
    const { user: u2 } = createUser(testDb);
    const result = createHousehold({ userId: u1.id, name: 'Both' });
    if (!('household' in result)) throw new Error('unreachable');
    testDb.prepare('UPDATE users SET household_id = ? WHERE id = ?').run(result.household.id, u2.id);
    addMember({ userId: u1.id, name: 'Emily', dob: '2018-04-12', relationship: 'daughter' });

    const snap = getHouseholdForUser(u1.id);
    expect(snap).not.toBeNull();
    expect(snap!.users.map(u => u.id).sort()).toEqual([u1.id, u2.id].sort());
    expect(snap!.members).toHaveLength(1);
    expect(snap!.members[0].name).toBe('Emily');
    expect(snap!.members[0].relationship).toBe('daughter');
  });
});

// ---------------------------------------------------------------------------
// getOtherHouseholdUserIds (used by trip auto-add)
// ---------------------------------------------------------------------------

describe('getOtherHouseholdUserIds', () => {
  it('returns empty for a user without a household', () => {
    const { user } = createUser(testDb);
    expect(getOtherHouseholdUserIds(user.id)).toEqual([]);
  });

  it('returns peers excluding the caller', () => {
    const { user: u1 } = createUser(testDb);
    const { user: u2 } = createUser(testDb);
    const { user: u3 } = createUser(testDb);
    const result = createHousehold({ userId: u1.id });
    if (!('household' in result)) throw new Error('unreachable');
    testDb.prepare('UPDATE users SET household_id = ? WHERE id IN (?, ?)').run(result.household.id, u2.id, u3.id);
    const peers = getOtherHouseholdUserIds(u1.id).sort();
    expect(peers).toEqual([u2.id, u3.id].sort());
  });
});

// ---------------------------------------------------------------------------
// renameHousehold
// ---------------------------------------------------------------------------

describe('renameHousehold', () => {
  it('rejects when the user is not in a household', () => {
    const { user } = createUser(testDb);
    const result = renameHousehold({ userId: user.id, name: 'Hi' });
    expect('error' in result).toBe(true);
  });

  it('updates the name and clears it on empty input', () => {
    const { user } = createUser(testDb);
    createHousehold({ userId: user.id, name: 'Original' });
    const after = renameHousehold({ userId: user.id, name: 'Renamed' });
    if (!('household' in after)) throw new Error('unreachable');
    expect(after.household.name).toBe('Renamed');
    const cleared = renameHousehold({ userId: user.id, name: '   ' });
    if (!('household' in cleared)) throw new Error('unreachable');
    expect(cleared.household.name).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// leaveHousehold
// ---------------------------------------------------------------------------

describe('leaveHousehold', () => {
  it('is a no-op when the user is not in a household', () => {
    const { user } = createUser(testDb);
    const result = leaveHousehold(user.id);
    expect('ok' in result && result.ok).toBe(true);
  });

  it('removes the user but keeps the household when peers remain', () => {
    const { user: u1 } = createUser(testDb);
    const { user: u2 } = createUser(testDb);
    const result = createHousehold({ userId: u1.id });
    if (!('household' in result)) throw new Error('unreachable');
    testDb.prepare('UPDATE users SET household_id = ? WHERE id = ?').run(result.household.id, u2.id);

    leaveHousehold(u1.id);

    const row1 = testDb.prepare('SELECT household_id FROM users WHERE id = ?').get(u1.id) as { household_id: number | null };
    const row2 = testDb.prepare('SELECT household_id FROM users WHERE id = ?').get(u2.id) as { household_id: number | null };
    expect(row1.household_id).toBeNull();
    expect(row2.household_id).toBe(result.household.id);

    const hh = testDb.prepare('SELECT id FROM households WHERE id = ?').get(result.household.id);
    expect(hh).toBeDefined();
  });

  it('deletes the household when the last user leaves', () => {
    const { user } = createUser(testDb);
    const result = createHousehold({ userId: user.id });
    if (!('household' in result)) throw new Error('unreachable');
    addMember({ userId: user.id, name: 'Emily' });

    leaveHousehold(user.id);

    const hh = testDb.prepare('SELECT id FROM households WHERE id = ?').get(result.household.id);
    expect(hh).toBeUndefined();
    const members = testDb.prepare('SELECT id FROM household_members WHERE household_id = ?').all(result.household.id);
    expect(members).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Named members CRUD
// ---------------------------------------------------------------------------

describe('addMember', () => {
  it('rejects when the user has no household', () => {
    const { user } = createUser(testDb);
    const result = addMember({ userId: user.id, name: 'Emily' });
    expect('error' in result).toBe(true);
  });

  it('rejects an empty name', () => {
    const { user } = createUser(testDb);
    createHousehold({ userId: user.id });
    const result = addMember({ userId: user.id, name: '   ' });
    if (!('error' in result)) throw new Error('expected error');
    expect(result.code).toBe('INVALID_INPUT');
  });

  it('creates a member with optional dob and relationship', () => {
    const { user } = createUser(testDb);
    createHousehold({ userId: user.id });
    const result = addMember({ userId: user.id, name: 'Emily', dob: '2018-04-12', relationship: 'daughter' });
    if (!('member' in result)) throw new Error('unreachable');
    expect(result.member.name).toBe('Emily');
    expect(result.member.dob).toBe('2018-04-12');
    expect(result.member.relationship).toBe('daughter');
  });
});

describe('updateMember', () => {
  it('updates only the provided fields and leaves others alone', () => {
    const { user } = createUser(testDb);
    createHousehold({ userId: user.id });
    const created = addMember({ userId: user.id, name: 'Emily', relationship: 'daughter' });
    if (!('member' in created)) throw new Error('unreachable');

    const updated = updateMember({ userId: user.id, memberId: created.member.id, dob: '2018-04-12' });
    if (!('member' in updated)) throw new Error('unreachable');
    expect(updated.member.name).toBe('Emily'); // unchanged
    expect(updated.member.relationship).toBe('daughter'); // unchanged
    expect(updated.member.dob).toBe('2018-04-12'); // updated
  });

  it('rejects editing a member of another household', () => {
    const { user: u1 } = createUser(testDb);
    const { user: u2 } = createUser(testDb);
    createHousehold({ userId: u1.id });
    createHousehold({ userId: u2.id });
    const u1Member = addMember({ userId: u1.id, name: 'Emily' });
    if (!('member' in u1Member)) throw new Error('unreachable');

    const result = updateMember({ userId: u2.id, memberId: u1Member.member.id, name: 'Stolen' });
    if (!('error' in result)) throw new Error('expected error');
    expect(result.code).toBe('NOT_AUTHORISED');
  });
});

describe('deleteMember', () => {
  it('removes a member from the caller\'s household', () => {
    const { user } = createUser(testDb);
    createHousehold({ userId: user.id });
    const m = addMember({ userId: user.id, name: 'Emily' });
    if (!('member' in m)) throw new Error('unreachable');

    deleteMember({ userId: user.id, memberId: m.member.id });

    const row = testDb.prepare('SELECT id FROM household_members WHERE id = ?').get(m.member.id);
    expect(row).toBeUndefined();
  });

  it('is idempotent on a non-existent member', () => {
    const { user } = createUser(testDb);
    createHousehold({ userId: user.id });
    const result = deleteMember({ userId: user.id, memberId: 99999 });
    expect('ok' in result && result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// autoAddHouseholdToTrip
// ---------------------------------------------------------------------------

describe('autoAddHouseholdToTrip', () => {
  it('returns empty list when the owner has no household', () => {
    const { user } = createUser(testDb);
    const result = autoAddHouseholdToTrip(user.id, 1);
    expect(result.added).toEqual([]);
  });

  it('adds every peer as trip_member and skips the owner', () => {
    const { user: u1 } = createUser(testDb);
    const { user: u2 } = createUser(testDb);
    const { user: u3 } = createUser(testDb);
    const hh = createHousehold({ userId: u1.id });
    if (!('household' in hh)) throw new Error('unreachable');
    testDb.prepare('UPDATE users SET household_id = ? WHERE id IN (?, ?)').run(hh.household.id, u2.id, u3.id);

    const tripRes = testDb.prepare(
      "INSERT INTO trips (user_id, title) VALUES (?, ?)"
    ).run(u1.id, 'Sydney');
    const tripId = Number(tripRes.lastInsertRowid);

    const result = autoAddHouseholdToTrip(u1.id, tripId);
    expect(result.added.sort()).toEqual([u2.id, u3.id].sort());

    const members = testDb.prepare('SELECT user_id FROM trip_members WHERE trip_id = ? ORDER BY user_id').all(tripId) as Array<{ user_id: number }>;
    expect(members.map(m => m.user_id).sort()).toEqual([u2.id, u3.id].sort());
  });

  it('does not duplicate when called twice', () => {
    const { user: u1 } = createUser(testDb);
    const { user: u2 } = createUser(testDb);
    const hh = createHousehold({ userId: u1.id });
    if (!('household' in hh)) throw new Error('unreachable');
    testDb.prepare('UPDATE users SET household_id = ? WHERE id = ?').run(hh.household.id, u2.id);
    const tripRes = testDb.prepare("INSERT INTO trips (user_id, title) VALUES (?, ?)").run(u1.id, 'X');
    const tripId = Number(tripRes.lastInsertRowid);

    autoAddHouseholdToTrip(u1.id, tripId);
    const second = autoAddHouseholdToTrip(u1.id, tripId);
    expect(second.added).toEqual([]);

    const count = testDb.prepare('SELECT COUNT(*) AS c FROM trip_members WHERE trip_id = ? AND user_id = ?').get(tripId, u2.id) as { c: number };
    expect(count.c).toBe(1);
  });
});
