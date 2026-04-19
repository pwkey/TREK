/**
 * Unit tests for the extract-reservation-draft orchestrator.
 * Mocks the settings service and the OllamaProvider.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/services/importSettingsService', () => ({
  getResolvedImportSettings: vi.fn(),
}));

vi.mock('../../../src/services/reservationImport/providers/ollamaProvider', () => {
  return {
    OllamaProvider: vi.fn().mockImplementation(() => ({
      name: 'ollama',
      model: 'llama3.1:8b',
      extract: vi.fn(),
    })),
  };
});

import { extractReservationDraft } from '../../../src/services/reservationImport/extractor';
import { ExtractError } from '../../../src/services/reservationImport/types';
import * as settings from '../../../src/services/importSettingsService';
import { OllamaProvider } from '../../../src/services/reservationImport/providers/ollamaProvider';

const baseSettings = {
  provider: 'ollama' as const,
  ollama_url: 'http://localhost:11434',
  ollama_model: 'llama3.1:8b',
  anthropic_model: '',
  openai_model: '',
  anthropic_key: null,
  openai_key: null,
  ocr_enabled: false,
};

const flightDraft = {
  type: 'flight' as const,
  title: 'QF9 SYD → LHR',
  reservation_time: '2026-07-15T09:15:00+10:00',
  reservation_end_time: '2026-07-16T06:50:00+01:00',
  location: 'Sydney → London Heathrow',
  confirmation_number: 'ABC123',
  provider: 'Qantas',
  passenger_names: ['Peter Key'],
  legs: [
    {
      origin: 'SYD',
      destination: 'LHR',
      departure_time: '2026-07-15T09:15:00+10:00',
      arrival_time: '2026-07-16T06:50:00+01:00',
      flight_number: 'QF9',
      airline: 'Qantas',
      cabin: 'Premium Economy',
    },
  ],
  notes: null,
  price: 3200,
  currency: 'AUD',
};

describe('extractReservationDraft', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns a typed draft when provider yields valid JSON', async () => {
    vi.mocked(settings.getResolvedImportSettings).mockReturnValue({ ...baseSettings });
    vi.mocked(OllamaProvider).mockImplementation(() => ({
      name: 'ollama',
      model: 'llama3.1:8b',
      extract: vi.fn().mockResolvedValue({ parsed: flightDraft, model: 'llama3.1:8b' }),
    } as any));

    const result = await extractReservationDraft(
      { kind: 'email_text', text: 'Your flight is confirmed' },
      { tripId: 1, userId: 1 },
    );

    expect(result.draft.type).toBe('flight');
    expect(result.draft.confirmation_number).toBe('ABC123');
    expect(result.provider_used).toBe('ollama');
    expect(result.model_used).toBe('llama3.1:8b');
    expect(result.confidence).toBeGreaterThan(0.5);
  });

  it('throws EMPTY_INPUT when source text is blank', async () => {
    await expect(
      extractReservationDraft({ kind: 'email_text', text: '   ' }, { tripId: 1, userId: 1 })
    ).rejects.toMatchObject({ code: 'EMPTY_INPUT' });
  });

  it('throws PROVIDER_DISABLED when provider setting is disabled', async () => {
    vi.mocked(settings.getResolvedImportSettings).mockReturnValue({ ...baseSettings, provider: 'disabled' });
    await expect(
      extractReservationDraft({ kind: 'email_text', text: 'something' }, { tripId: 1, userId: 1 })
    ).rejects.toMatchObject({ code: 'PROVIDER_DISABLED' });
  });

  it('throws PROVIDER_DISABLED when anthropic selected but no API key', async () => {
    vi.mocked(settings.getResolvedImportSettings).mockReturnValue({ ...baseSettings, provider: 'anthropic', anthropic_key: null });
    await expect(
      extractReservationDraft({ kind: 'email_text', text: 'something' }, { tripId: 1, userId: 1 })
    ).rejects.toMatchObject({ code: 'PROVIDER_DISABLED' });
  });

  it('throws PROVIDER_DISABLED when openai selected (not yet implemented)', async () => {
    vi.mocked(settings.getResolvedImportSettings).mockReturnValue({ ...baseSettings, provider: 'openai', openai_key: 'sk-o-x' });
    await expect(
      extractReservationDraft({ kind: 'email_text', text: 'something' }, { tripId: 1, userId: 1 })
    ).rejects.toMatchObject({ code: 'PROVIDER_DISABLED' });
  });

  it('throws PROVIDER_SCHEMA_MISMATCH when parsed JSON does not validate', async () => {
    vi.mocked(settings.getResolvedImportSettings).mockReturnValue({ ...baseSettings });
    vi.mocked(OllamaProvider).mockImplementation(() => ({
      name: 'ollama',
      model: 'llama3.1:8b',
      extract: vi.fn().mockResolvedValue({ parsed: { not: 'a draft' }, model: 'llama3.1:8b' }),
    } as any));

    await expect(
      extractReservationDraft({ kind: 'email_text', text: 'something' }, { tripId: 1, userId: 1 })
    ).rejects.toMatchObject({ code: 'PROVIDER_SCHEMA_MISMATCH' });
  });

  it('clears legs for non-flight types', async () => {
    const hotelDraft = { ...flightDraft, type: 'hotel' as const, legs: [flightDraft.legs[0]] };
    vi.mocked(settings.getResolvedImportSettings).mockReturnValue({ ...baseSettings });
    vi.mocked(OllamaProvider).mockImplementation(() => ({
      name: 'ollama',
      model: 'llama3.1:8b',
      extract: vi.fn().mockResolvedValue({ parsed: hotelDraft, model: 'llama3.1:8b' }),
    } as any));

    const result = await extractReservationDraft(
      { kind: 'email_text', text: 'Your booking' },
      { tripId: 1, userId: 1 },
    );
    expect(result.draft.legs).toEqual([]);
  });
});

describe('ExtractError', () => {
  it('propagates code and cause', () => {
    const err = new ExtractError('PROVIDER_ERROR', 'boom', new Error('inner'));
    expect(err.code).toBe('PROVIDER_ERROR');
    expect(err.message).toBe('boom');
    expect(err.cause).toBeInstanceOf(Error);
  });
});
