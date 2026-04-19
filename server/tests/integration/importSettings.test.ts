/**
 * Integration tests for admin Smart Import settings (Milestone 2, slice 1).
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
import { createUser, createAdmin } from '../helpers/factories';
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

describe('Smart Import settings', () => {
  it('non-admin gets 403', async () => {
    const { user } = createUser(testDb);
    const res = await request(app)
      .get('/api/admin/import-settings')
      .set('Cookie', authCookie(user.id));
    expect(res.status).toBe(403);
  });

  it('unauthenticated gets 401', async () => {
    const res = await request(app).get('/api/admin/import-settings');
    expect(res.status).toBe(401);
  });

  it('GET returns defaults when no settings saved', async () => {
    const { user: admin } = createAdmin(testDb);
    const res = await request(app)
      .get('/api/admin/import-settings')
      .set('Cookie', authCookie(admin.id));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      provider: 'disabled',
      ollama_url: 'http://localhost:11434',
      ollama_model: 'llama3.1:8b',
      anthropic_key_set: false,
      openai_key_set: false,
      ocr_enabled: false,
    });
  });

  it('PUT round-trip saves all fields', async () => {
    const { user: admin } = createAdmin(testDb);
    const putRes = await request(app)
      .put('/api/admin/import-settings')
      .set('Cookie', authCookie(admin.id))
      .send({
        provider: 'ollama',
        ollama_url: 'http://10.0.0.5:11434',
        ollama_model: 'mistral:7b',
        anthropic_key: 'sk-ant-test-key-123',
        openai_key: 'sk-test-openai-456',
        ocr_enabled: true,
      });
    expect(putRes.status).toBe(200);
    expect(putRes.body.provider).toBe('ollama');
    expect(putRes.body.ollama_url).toBe('http://10.0.0.5:11434');
    expect(putRes.body.ollama_model).toBe('mistral:7b');
    expect(putRes.body.anthropic_key_set).toBe(true);
    expect(putRes.body.openai_key_set).toBe(true);
    expect(putRes.body.ocr_enabled).toBe(true);

    const getRes = await request(app)
      .get('/api/admin/import-settings')
      .set('Cookie', authCookie(admin.id));
    expect(getRes.body).toMatchObject({
      provider: 'ollama',
      ollama_url: 'http://10.0.0.5:11434',
      anthropic_key_set: true,
      openai_key_set: true,
      ocr_enabled: true,
    });
  });

  it('GET never returns plaintext API keys', async () => {
    const { user: admin } = createAdmin(testDb);
    await request(app)
      .put('/api/admin/import-settings')
      .set('Cookie', authCookie(admin.id))
      .send({ anthropic_key: 'sk-ant-secret-plaintext' });
    const res = await request(app)
      .get('/api/admin/import-settings')
      .set('Cookie', authCookie(admin.id));
    expect(res.body.anthropic_key_set).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain('sk-ant-secret-plaintext');
    expect(res.body.anthropic_key).toBeUndefined();
  });

  it('API keys are encrypted at rest', async () => {
    const { user: admin } = createAdmin(testDb);
    await request(app)
      .put('/api/admin/import-settings')
      .set('Cookie', authCookie(admin.id))
      .send({ openai_key: 'sk-openai-raw-12345' });
    const row = testDb.prepare('SELECT value FROM app_settings WHERE key = ?').get('import_openai_key') as { value: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.value.startsWith('enc:v1:')).toBe(true);
    expect(row!.value).not.toContain('sk-openai-raw-12345');
  });

  it('PUT anthropic_key: null clears the stored key', async () => {
    const { user: admin } = createAdmin(testDb);
    await request(app)
      .put('/api/admin/import-settings')
      .set('Cookie', authCookie(admin.id))
      .send({ anthropic_key: 'sk-ant-initial' });
    const afterSet = await request(app)
      .get('/api/admin/import-settings')
      .set('Cookie', authCookie(admin.id));
    expect(afterSet.body.anthropic_key_set).toBe(true);

    await request(app)
      .put('/api/admin/import-settings')
      .set('Cookie', authCookie(admin.id))
      .send({ anthropic_key: null });
    const afterClear = await request(app)
      .get('/api/admin/import-settings')
      .set('Cookie', authCookie(admin.id));
    expect(afterClear.body.anthropic_key_set).toBe(false);
  });

  it('rejects invalid provider', async () => {
    const { user: admin } = createAdmin(testDb);
    const res = await request(app)
      .put('/api/admin/import-settings')
      .set('Cookie', authCookie(admin.id))
      .send({ provider: 'bogus' });
    expect(res.status).toBe(400);
  });
});
