/**
 * Unit tests for OllamaProvider.
 * Mocks global fetch to avoid hitting a real Ollama instance.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { OllamaProvider } from '../../../src/services/reservationImport/providers/ollamaProvider';
import { ExtractError } from '../../../src/services/reservationImport/types';

const schema = { type: 'object' } as const;

describe('OllamaProvider', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('parses a valid JSON response', async () => {
    const body = {
      response: JSON.stringify({
        type: 'flight',
        title: 'QF9 SYD → LHR',
        reservation_time: null,
        reservation_end_time: null,
        location: null,
        confirmation_number: 'ABC123',
        provider: 'Qantas',
        passenger_names: ['Peter Key'],
        legs: [],
        notes: null,
        price: null,
        currency: null,
      }),
    };
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as any);

    const provider = new OllamaProvider({ url: 'http://localhost:11434', model: 'llama3.1:8b' });
    const { parsed, model } = await provider.extract('prompt', schema, 'raw');

    expect(model).toBe('llama3.1:8b');
    expect((parsed as any).confirmation_number).toBe('ABC123');
    const call = fetchMock.mock.calls[0];
    expect(call[0]).toBe('http://localhost:11434/api/generate');
    const sent = JSON.parse((call[1] as RequestInit).body as string);
    expect(sent.model).toBe('llama3.1:8b');
    expect(sent.stream).toBe(false);
    expect(sent.format).toEqual(schema);
  });

  it('strips trailing slash from base URL', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ response: '{"type":"hotel","title":"x","reservation_time":null,"reservation_end_time":null,"location":null,"confirmation_number":null,"provider":null,"passenger_names":[],"legs":[],"notes":null,"price":null,"currency":null}' }),
      text: async () => '',
    } as any);
    const provider = new OllamaProvider({ url: 'http://host/', model: 'm' });
    await provider.extract('p', schema, 'r');
    expect(fetchMock.mock.calls[0][0]).toBe('http://host/api/generate');
  });

  it('throws PROVIDER_ERROR on non-2xx', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({}),
      text: async () => 'boom',
    } as any);
    const provider = new OllamaProvider({ url: 'http://localhost', model: 'm' });
    await expect(provider.extract('p', schema, 'r')).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
  });

  it('throws PROVIDER_INVALID_JSON on malformed response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ response: 'this is not json' }),
      text: async () => '',
    } as any);
    const provider = new OllamaProvider({ url: 'http://localhost', model: 'm' });
    await expect(provider.extract('p', schema, 'r')).rejects.toMatchObject({ code: 'PROVIDER_INVALID_JSON' });
  });

  it('throws PROVIDER_TIMEOUT on abort', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init: any) => {
      return new Promise((_, reject) => {
        init.signal?.addEventListener('abort', () => {
          const err = new Error('aborted');
          (err as any).name = 'AbortError';
          reject(err);
        });
      });
    });
    const provider = new OllamaProvider({ url: 'http://localhost', model: 'm', timeoutMs: 10 });
    await expect(provider.extract('p', schema, 'r')).rejects.toBeInstanceOf(ExtractError);
  });
});
