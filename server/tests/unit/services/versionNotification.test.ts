/**
 * Unit tests for checkAndNotifyVersion() in adminService.
 * Covers VNOTIF-001 to VNOTIF-007.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';

const { testDb, dbMock } = vi.hoisted(() => {
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  const mock = {
    db,
    closeDb: () => {},
    reinitialize: () => {},
    getPlaceWithTags: () => null,
    canAccessTrip: () => null,
    isOwner: () => false,
  };
  return { testDb: db, dbMock: mock };
});

vi.mock('../../../src/db/database', () => dbMock);
vi.mock('../../../src/config', () => ({
  JWT_SECRET: 'test-jwt-secret-for-trek-testing-only',
  ENCRYPTION_KEY: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6a7b8c9d0e1f2a3b4c5d6a7b8c9d0e1f2',
  updateJwtSecret: () => {},
}));
vi.mock('../../../src/websocket', () => ({ broadcastToUser: vi.fn() }));
// Mock MCP to avoid session side-effects
vi.mock('../../../src/mcp', () => ({ revokeUserSessions: vi.fn() }));

import { createTables } from '../../../src/db/schema';
import { runMigrations } from '../../../src/db/migrations';
import { resetTestDb } from '../../helpers/test-db';
import { createAdmin } from '../../helpers/factories';
import { checkAndNotifyVersion } from '../../../src/services/adminService';

// Helper: mock the GitHub releases/latest endpoint
function mockGitHubLatest(tagName: string, ok = true): void {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok,
    json: async () => ({ tag_name: tagName, html_url: `https://github.com/mauriceboe/TREK/releases/tag/${tagName}` }),
  }));
}

function mockGitHubFetchFailure(): void {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')));
}

function getLastNotifiedVersion(): string | undefined {
  return (testDb.prepare('SELECT value FROM app_settings WHERE key = ?').get('last_notified_version') as { value: string } | undefined)?.value;
}

function getNotificationCount(): number {
  return (testDb.prepare('SELECT COUNT(*) as c FROM notifications').get() as { c: number }).c;
}

beforeAll(() => {
  createTables(testDb);
  runMigrations(testDb);
});

beforeEach(() => {
  resetTestDb(testDb);
  vi.unstubAllGlobals();
});

afterAll(() => {
  testDb.close();
  vi.unstubAllGlobals();
});

// ─────────────────────────────────────────────────────────────────────────────
// checkAndNotifyVersion
// ─────────────────────────────────────────────────────────────────────────────

describe('checkAndNotifyVersion', () => {
  it('VNOTIF-001 — does nothing when no update is available', async () => {
    createAdmin(testDb);
    // GitHub reports same version as package.json (or older) → update_available: false
    const { version } = require('../../../package.json');
    mockGitHubLatest(`v${version}`);

    await checkAndNotifyVersion();

    expect(getNotificationCount()).toBe(0);
    expect(getLastNotifiedVersion()).toBeUndefined();
  });

  // [460-fork] checkAndNotifyVersion was deliberately turned into a no-op in
  // commit 37d50a9. Upstream's version checker compares OUR fork's
  // package.json version against the latest mauriceboe/TREK GitHub release
  // and fires a "version available" admin notification — misleading on a
  // fork, which tracks upstream via git, not an in-app nag. So the tests
  // that previously asserted a notification IS created now assert the
  // opposite: regardless of what GitHub reports, NOTHING is sent and no
  // state is written. (VNOTIF-002 replaces the old 002–006 block.)
  it('VNOTIF-002 — does NOT notify even when GitHub reports a much newer release (fork: checker disabled)', async () => {
    createAdmin(testDb);
    createAdmin(testDb);
    mockGitHubLatest('v99.0.0');

    await checkAndNotifyVersion();

    expect(getNotificationCount()).toBe(0);
    expect(getLastNotifiedVersion()).toBeUndefined();
  });

  it('VNOTIF-003 — no notification regardless of any prior last_notified_version state', async () => {
    createAdmin(testDb);
    // Even with a stale "previously notified" marker for an older version,
    // the disabled checker writes nothing new.
    testDb.prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)').run('last_notified_version', '98.0.0');
    mockGitHubLatest('v99.3.0');

    await checkAndNotifyVersion();

    expect(getNotificationCount()).toBe(0);
    // The pre-existing marker is left untouched (we never reach the write path).
    expect(getLastNotifiedVersion()).toBe('98.0.0');
  });

  it('VNOTIF-007 — silently handles GitHub API fetch failure (no crash, no notification)', async () => {
    createAdmin(testDb);
    mockGitHubFetchFailure();

    // Should not throw
    await expect(checkAndNotifyVersion()).resolves.toBeUndefined();
    expect(getNotificationCount()).toBe(0);
    expect(getLastNotifiedVersion()).toBeUndefined();
  });
});
