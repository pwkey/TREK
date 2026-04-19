import { db } from '../db/database';
import { decrypt_api_key, maybe_encrypt_api_key } from './apiKeyCrypto';

export type ImportProvider = 'disabled' | 'ollama' | 'anthropic' | 'openai';

export interface ImportSettings {
  provider: ImportProvider;
  ollama_url: string;
  ollama_model: string;
  anthropic_model: string;
  openai_model: string;
  anthropic_key_set: boolean;
  openai_key_set: boolean;
  ocr_enabled: boolean;
}

export interface ImportSettingsUpdate {
  provider?: ImportProvider;
  ollama_url?: string;
  ollama_model?: string;
  anthropic_model?: string;
  openai_model?: string;
  anthropic_key?: string | null;
  openai_key?: string | null;
  ocr_enabled?: boolean;
}

export interface ResolvedImportSettings {
  provider: ImportProvider;
  ollama_url: string;
  ollama_model: string;
  anthropic_model: string;
  openai_model: string;
  anthropic_key: string | null;
  openai_key: string | null;
  ocr_enabled: boolean;
}

const KEYS = {
  provider: 'import_provider',
  ollama_url: 'import_ollama_url',
  ollama_model: 'import_ollama_model',
  anthropic_key: 'import_anthropic_key',
  anthropic_model: 'import_anthropic_model',
  openai_key: 'import_openai_key',
  openai_model: 'import_openai_model',
  ocr_enabled: 'import_ocr_enabled',
} as const;

const DEFAULTS = {
  provider: 'disabled' as ImportProvider,
  ollama_url: 'http://localhost:11434',
  ollama_model: 'llama3.1:8b',
  anthropic_model: 'claude-sonnet-4-5',
  openai_model: 'gpt-4o-mini',
  ocr_enabled: false,
};

const VALID_PROVIDERS: ReadonlySet<ImportProvider> = new Set(['disabled', 'ollama', 'anthropic', 'openai']);

function readRaw(key: string): string {
  return (db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? '';
}

function writeRaw(key: string, value: string): void {
  db.prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)').run(key, value);
}

function coerceProvider(value: string): ImportProvider {
  return (VALID_PROVIDERS.has(value as ImportProvider) ? value : DEFAULTS.provider) as ImportProvider;
}

export function getImportSettings(): ImportSettings {
  const anthropicKey = decrypt_api_key(readRaw(KEYS.anthropic_key));
  const openaiKey = decrypt_api_key(readRaw(KEYS.openai_key));
  return {
    provider: coerceProvider(readRaw(KEYS.provider) || DEFAULTS.provider),
    ollama_url: readRaw(KEYS.ollama_url) || DEFAULTS.ollama_url,
    ollama_model: readRaw(KEYS.ollama_model) || DEFAULTS.ollama_model,
    anthropic_model: readRaw(KEYS.anthropic_model) || DEFAULTS.anthropic_model,
    openai_model: readRaw(KEYS.openai_model) || DEFAULTS.openai_model,
    anthropic_key_set: !!anthropicKey,
    openai_key_set: !!openaiKey,
    ocr_enabled: readRaw(KEYS.ocr_enabled) === 'true',
  };
}

export function getResolvedImportSettings(): ResolvedImportSettings {
  return {
    provider: coerceProvider(readRaw(KEYS.provider) || DEFAULTS.provider),
    ollama_url: readRaw(KEYS.ollama_url) || DEFAULTS.ollama_url,
    ollama_model: readRaw(KEYS.ollama_model) || DEFAULTS.ollama_model,
    anthropic_model: readRaw(KEYS.anthropic_model) || DEFAULTS.anthropic_model,
    openai_model: readRaw(KEYS.openai_model) || DEFAULTS.openai_model,
    anthropic_key: decrypt_api_key(readRaw(KEYS.anthropic_key)),
    openai_key: decrypt_api_key(readRaw(KEYS.openai_key)),
    ocr_enabled: readRaw(KEYS.ocr_enabled) === 'true',
  };
}

export function updateImportSettings(data: ImportSettingsUpdate): ImportSettings {
  if (data.provider !== undefined) {
    if (!VALID_PROVIDERS.has(data.provider)) {
      throw new Error(`Invalid provider: ${data.provider}`);
    }
    writeRaw(KEYS.provider, data.provider);
  }
  if (data.ollama_url !== undefined) writeRaw(KEYS.ollama_url, (data.ollama_url || '').trim() || DEFAULTS.ollama_url);
  if (data.ollama_model !== undefined) writeRaw(KEYS.ollama_model, (data.ollama_model || '').trim() || DEFAULTS.ollama_model);
  if (data.anthropic_model !== undefined) writeRaw(KEYS.anthropic_model, (data.anthropic_model || '').trim() || DEFAULTS.anthropic_model);
  if (data.openai_model !== undefined) writeRaw(KEYS.openai_model, (data.openai_model || '').trim() || DEFAULTS.openai_model);
  if (data.anthropic_key !== undefined) {
    writeRaw(KEYS.anthropic_key, data.anthropic_key === null ? '' : maybe_encrypt_api_key(data.anthropic_key) ?? '');
  }
  if (data.openai_key !== undefined) {
    writeRaw(KEYS.openai_key, data.openai_key === null ? '' : maybe_encrypt_api_key(data.openai_key) ?? '');
  }
  if (data.ocr_enabled !== undefined) writeRaw(KEYS.ocr_enabled, data.ocr_enabled ? 'true' : 'false');

  return getImportSettings();
}
