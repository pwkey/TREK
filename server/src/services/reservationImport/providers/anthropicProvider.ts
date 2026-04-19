import Anthropic from '@anthropic-ai/sdk';
import { ExtractError, LlmProvider } from '../types';

const DEFAULT_TIMEOUT_MS = 60_000;

export class AnthropicProvider implements LlmProvider {
  readonly name = 'anthropic' as const;
  readonly model: string;
  private readonly client: Anthropic;
  private readonly timeoutMs: number;

  constructor(opts: { apiKey: string; model: string; timeoutMs?: number }) {
    this.model = opts.model;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.client = new Anthropic({ apiKey: opts.apiKey, timeout: this.timeoutMs });
  }

  async extract(prompt: string, jsonSchema: unknown): Promise<{ parsed: unknown; model: string }> {
    let response;
    try {
      response = await this.client.messages.create({
        model: this.model,
        max_tokens: 1024,
        // Forcing a tool call with our schema guarantees valid structured JSON.
        // Works on all current Anthropic models including Haiku 4.5.
        tools: [
          {
            name: 'extract_reservation',
            description: 'Return the extracted reservation fields as a structured object.',
            input_schema: jsonSchema as Anthropic.Tool.InputSchema,
          },
        ],
        tool_choice: { type: 'tool', name: 'extract_reservation' },
        messages: [{ role: 'user', content: prompt }],
      });
    } catch (err: unknown) {
      if (err instanceof Anthropic.APIConnectionTimeoutError) {
        throw new ExtractError('PROVIDER_TIMEOUT', `Anthropic timed out after ${this.timeoutMs}ms`, err);
      }
      if (err instanceof Anthropic.APIError) {
        throw new ExtractError('PROVIDER_ERROR', `Anthropic ${err.status}: ${err.message}`, err);
      }
      const message = err instanceof Error ? err.message : String(err);
      throw new ExtractError('PROVIDER_ERROR', `Anthropic call failed: ${message}`, err);
    }

    const toolUse = response.content.find((b) => b.type === 'tool_use');
    if (!toolUse || toolUse.type !== 'tool_use') {
      throw new ExtractError(
        'PROVIDER_INVALID_JSON',
        `Anthropic returned no tool_use block (stop_reason=${response.stop_reason})`,
      );
    }
    return { parsed: toolUse.input, model: this.model };
  }
}
