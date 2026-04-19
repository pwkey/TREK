import { ExtractError, LlmProvider } from '../types';

// Cold-start on a CPU-only box (mmap disabled) can take 3-5 min to load the
// 4.7 GB model into RAM. Once loaded, Ollama keeps it resident for 5 min.
// If a caller times out, Ollama aborts the load, so generous is safer.
const DEFAULT_TIMEOUT_MS = 300_000;

interface OllamaGenerateResponse {
  response?: string;
  error?: string;
}

export class OllamaProvider implements LlmProvider {
  readonly name = 'ollama' as const;
  readonly model: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(opts: { url: string; model: string; timeoutMs?: number }) {
    this.baseUrl = opts.url.replace(/\/+$/, '');
    this.model = opts.model;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async extract(prompt: string, _jsonSchema: unknown): Promise<{ parsed: unknown; model: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          model: this.model,
          prompt,
          stream: false,
          // Ollama's `format: "json"` is a much cheaper CPU constraint than a
          // full JSON-schema `format: <schema>` — tokens aren't validated against
          // every nested field. Post-parse + zod still enforces the schema.
          format: 'json',
          options: { temperature: 0.1, num_ctx: 4096 },
        }),
      });
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        throw new ExtractError('PROVIDER_TIMEOUT', `Ollama timed out after ${this.timeoutMs}ms`, err);
      }
      throw new ExtractError('PROVIDER_ERROR', `Ollama request failed: ${err?.message ?? String(err)}`, err);
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new ExtractError('PROVIDER_ERROR', `Ollama returned HTTP ${res.status}: ${detail.slice(0, 200)}`);
    }

    const body = (await res.json()) as OllamaGenerateResponse;
    if (body.error) {
      throw new ExtractError('PROVIDER_ERROR', `Ollama error: ${body.error}`);
    }

    const raw = (body.response ?? '').trim();
    if (!raw) {
      throw new ExtractError('PROVIDER_INVALID_JSON', 'Ollama returned an empty response');
    }

    try {
      return { parsed: JSON.parse(raw), model: this.model };
    } catch (err) {
      throw new ExtractError('PROVIDER_INVALID_JSON', `Ollama response was not valid JSON: ${raw.slice(0, 200)}`, err);
    }
  }
}
