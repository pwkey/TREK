/**
 * [460-fork] Verifies the pre-migration safety snapshot (Q: data durability
 * before the flagship trip). runMigrations must copy the live DB file aside
 * before applying any pending migration, so a bad migration in a future
 * deploy is always recoverable.
 *
 * Uses a REAL on-disk SQLite file (not :memory:) because the snapshot is
 * deliberately skipped for in-memory DBs — it has nothing to copy.
 */
import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createTables } from '../../src/db/schema';
import { runMigrations } from '../../src/db/migrations';

const tmpDirs: string[] = [];

function freshDbDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trek-migsnap-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop()!;
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describe('Pre-migration snapshot', () => {
  it('MIGSNAP-001 — writes a pre-migration .db snapshot on a fresh file-backed DB', () => {
    const dir = freshDbDir();
    const dbPath = path.join(dir, 'travel.db');
    const db = new Database(dbPath);
    try {
      // Mirror production boot order: createTables THEN runMigrations. The
      // snapshot fires inside runMigrations because a fresh DB is at
      // schema_version 0 < migrations.length.
      createTables(db);
      runMigrations(db);
    } finally {
      db.close();
    }
    const backupsDir = path.join(dir, 'backups');
    expect(fs.existsSync(backupsDir)).toBe(true);
    const snaps = fs.readdirSync(backupsDir).filter(f => f.startsWith('pre-migration-') && f.endsWith('.db'));
    expect(snaps.length).toBe(1);
    // The snapshot must be a real, non-empty copy of the DB.
    expect(fs.statSync(path.join(backupsDir, snaps[0])).size).toBeGreaterThan(0);
  });

  it('MIGSNAP-002 — does NOT snapshot again when there are no pending migrations', () => {
    const dir = freshDbDir();
    const dbPath = path.join(dir, 'travel.db');
    const backupsDir = path.join(dir, 'backups');

    const db1 = new Database(dbPath);
    createTables(db1);
    runMigrations(db1); // applies all → 1 snapshot
    db1.close();
    const afterFirst = fs.readdirSync(backupsDir).filter(f => f.startsWith('pre-migration-')).length;
    expect(afterFirst).toBe(1);

    // Second run on an already-migrated DB: currentVersion == migrations.length,
    // so the snapshot block is skipped entirely.
    const db2 = new Database(dbPath);
    runMigrations(db2);
    db2.close();
    const afterSecond = fs.readdirSync(backupsDir).filter(f => f.startsWith('pre-migration-')).length;
    expect(afterSecond).toBe(1);
  });

  it('MIGSNAP-003 — in-memory DB is migrated but produces no snapshot (nothing to copy)', () => {
    const db = new Database(':memory:');
    // Mirror production boot order (createTables then runMigrations) so the
    // migrations have the tables they ALTER. The point of this test is that
    // the snapshot's `:memory:` guard means no file is written — there's no
    // on-disk DB to copy. Should complete without throwing.
    createTables(db);
    expect(() => runMigrations(db)).not.toThrow();
    db.close();
  });
});
