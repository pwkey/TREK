/**
 * [460-fork] Regression: boot against an EXISTING (pre-migration) database.
 *
 * Why this exists: CI's other suites all start from a fresh :memory: DB, where
 * createTables() builds the modern schema in one CREATE-TABLE shot — so any
 * column referenced by an index in createTables exists and the index builds
 * fine. PRODUCTION is different: the users table already exists, so
 * `CREATE TABLE IF NOT EXISTS users (...)` is a NO-OP and ignores newly-added
 * columns; those columns only appear when the matching ALTER-TABLE migration
 * runs LATER. If createTables itself tries to CREATE INDEX on such a column it
 * crashes at boot with "no such column: …", the container is unhealthy, and
 * Coolify rolls back — which is exactly what silently happened with
 * idx_users_household (M11) for ~30 deploys.
 *
 * EXIST-001 reproduces the precise bug site: createTables run against a users
 * table that predates household_id. It must NOT throw — createTables must be
 * safe to run on any historical DB shape, deferring all column-dependent index
 * creation to the migrations that add those columns.
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { createTables } from '../../src/db/schema';
import { runMigrations } from '../../src/db/migrations';

describe('Existing-DB boot (production schema path)', () => {
  it('EXIST-001 — createTables is safe on a users table that predates household_id', () => {
    // Simulate a long-lived production DB: users exists WITHOUT the modern
    // household_id column (it was added by a later migration). This is the
    // exact precondition that crashed prod — createTables ran CREATE INDEX on
    // users(household_id) while the column didn't exist yet.
    const db = new Database(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'user',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);
    db.prepare("INSERT INTO users (username, email, password_hash) VALUES ('alice','alice@example.com','x')").run();
    try {
      // With the bug present, this throws "no such column: household_id".
      // With the fix (index lives in the migration, not createTables), it
      // creates the new household tables and leaves users alone — no throw.
      expect(() => createTables(db)).not.toThrow();
    } finally {
      db.close();
    }
  });

  it('EXIST-002 — fresh full boot: household_id column + index are present afterwards', () => {
    // The happy path other tests rely on, asserted explicitly here so the
    // migration that actually creates the index is covered.
    const db = new Database(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    try {
      createTables(db);
      runMigrations(db);
      const cols = (db.prepare("PRAGMA table_info('users')").all() as Array<{ name: string }>).map(c => c.name);
      expect(cols).toContain('household_id');
      const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_users_household'").get();
      expect(idx).toBeTruthy();
    } finally {
      db.close();
    }
  });

  it('EXIST-003 — booting TWICE is idempotent (simulates a redeploy)', () => {
    const db = new Database(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    try {
      createTables(db);
      runMigrations(db);
      // Second boot on the same DB — must be a clean no-op, never throw.
      expect(() => { createTables(db); runMigrations(db); }).not.toThrow();
    } finally {
      db.close();
    }
  });
});
