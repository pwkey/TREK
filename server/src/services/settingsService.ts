import { db } from '../db/database';
import { maybe_encrypt_api_key } from './apiKeyCrypto';

const ENCRYPTED_SETTING_KEYS = new Set(['webhook_url']);

export function getUserSettings(userId: number): Record<string, unknown> {
  const rows = db.prepare('SELECT key, value FROM settings WHERE user_id = ?').all(userId) as { key: string; value: string }[];
  const settings: Record<string, unknown> = {};
  for (const row of rows) {
    if (ENCRYPTED_SETTING_KEYS.has(row.key)) {
      settings[row.key] = row.value ? '••••••••' : '';
      continue;
    }
    try {
      settings[row.key] = JSON.parse(row.value);
    } catch {
      settings[row.key] = row.value;
    }
  }
  return settings;
}

function serializeValue(key: string, value: unknown): string {
  const raw = typeof value === 'object' ? JSON.stringify(value) : String(value !== undefined ? value : '');
  if (ENCRYPTED_SETTING_KEYS.has(key)) return maybe_encrypt_api_key(raw) ?? raw;
  return raw;
}

export function upsertSetting(userId: number, key: string, value: unknown) {
  db.prepare(`
    INSERT INTO settings (user_id, key, value) VALUES (?, ?, ?)
    ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value
  `).run(userId, key, serializeValue(key, value));
}

export function bulkUpsertSettings(userId: number, settings: Record<string, unknown>) {
  const upsert = db.prepare(`
    INSERT INTO settings (user_id, key, value) VALUES (?, ?, ?)
    ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value
  `);
  db.exec('BEGIN');
  try {
    for (const [key, value] of Object.entries(settings)) {
      upsert.run(userId, key, serializeValue(key, value));
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return Object.keys(settings).length;
}
