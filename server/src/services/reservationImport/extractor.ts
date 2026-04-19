import { getResolvedImportSettings } from '../importSettingsService';
import { OllamaProvider } from './providers/ollamaProvider';
import { AnthropicProvider } from './providers/anthropicProvider';
import { buildExtractionPrompt } from './prompts';
import { reservationDraftJsonSchema, reservationDraftSchema } from './schema';
import { ExtractContext, ExtractError, ExtractResult, ExtractSource, LlmProvider, ReservationDraft } from './types';

export async function extractReservationDraft(
  source: ExtractSource,
  _context: ExtractContext,
): Promise<ExtractResult> {
  const rawText = (source.text || '').trim();
  if (!rawText) {
    throw new ExtractError('EMPTY_INPUT', 'No text to extract from');
  }

  const provider = buildProviderFromSettings();
  const prompt = buildExtractionPrompt(rawText);
  const { parsed, model } = await provider.extract(prompt, reservationDraftJsonSchema, rawText);

  const result = reservationDraftSchema.safeParse(parsed);
  if (!result.success) {
    throw new ExtractError(
      'PROVIDER_SCHEMA_MISMATCH',
      `Provider output did not match schema: ${result.error.message}`,
      result.error,
    );
  }

  const draft: ReservationDraft = {
    ...result.data,
    passenger_names: result.data.passenger_names ?? [],
    legs: result.data.type === 'flight' ? result.data.legs ?? [] : [],
  };

  return {
    draft,
    confidence: computeConfidence(draft),
    provider_used: provider.name,
    model_used: model,
    raw_text: rawText,
  };
}

function buildProviderFromSettings(): LlmProvider {
  const settings = getResolvedImportSettings();
  switch (settings.provider) {
    case 'disabled':
      throw new ExtractError('PROVIDER_DISABLED', 'Smart import is disabled in admin settings');
    case 'ollama':
      return new OllamaProvider({ url: settings.ollama_url, model: settings.ollama_model });
    case 'anthropic':
      if (!settings.anthropic_key) {
        throw new ExtractError('PROVIDER_DISABLED', 'Anthropic API key is not set in admin settings.');
      }
      return new AnthropicProvider({ apiKey: settings.anthropic_key, model: settings.anthropic_model });
    case 'openai':
      // Slice 5b: not yet implemented. Fall through to disabled.
      throw new ExtractError(
        'PROVIDER_DISABLED',
        'OpenAI provider is not yet implemented. Use "anthropic" or "ollama".',
      );
    default:
      throw new ExtractError('PROVIDER_DISABLED', `Unknown provider: ${settings.provider}`);
  }
}

function computeConfidence(draft: ReservationDraft): number {
  // Cheap heuristic until models start self-reporting reliably.
  // All required anchor fields present = 1.0; scale down per missing field.
  const anchors: Array<keyof ReservationDraft> = ['type', 'title', 'reservation_time', 'confirmation_number'];
  const missing = anchors.filter((k) => {
    const v = draft[k];
    return v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
  }).length;
  return Math.max(0.2, 1 - missing * 0.2);
}
