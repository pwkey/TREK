import type { ReservationDraftParsed, flightLegSchema } from './schema';
import type { z } from 'zod';

export type SourceType = 'pdf' | 'email_text' | 'ocr';

export type ReservationKind = ReservationDraftParsed['type'];

export type FlightLeg = z.infer<typeof flightLegSchema>;

export type ReservationDraft = ReservationDraftParsed;

export interface ExtractSource {
  kind: SourceType;
  text: string;
}

export interface ExtractContext {
  tripId: number;
  userId: number;
  clientMutationId?: string | null;
}

export interface ExtractResult {
  draft: ReservationDraft;
  confidence: number;
  provider_used: 'ollama' | 'anthropic' | 'openai';
  model_used: string;
  raw_text: string;
}

export interface LlmProviderConfig {
  ollama_url?: string;
  ollama_model?: string;
  anthropic_key?: string | null;
  anthropic_model?: string;
  openai_key?: string | null;
  openai_model?: string;
}

export interface LlmProvider {
  readonly name: 'ollama' | 'anthropic' | 'openai';
  readonly model: string;
  extract(prompt: string, jsonSchema: unknown, rawText: string): Promise<{ parsed: unknown; model: string }>;
}

export class ExtractError extends Error {
  readonly code:
    | 'PROVIDER_ERROR'
    | 'PROVIDER_TIMEOUT'
    | 'PROVIDER_INVALID_JSON'
    | 'PROVIDER_SCHEMA_MISMATCH'
    | 'PDF_EMPTY'
    | 'EMPTY_INPUT'
    | 'PROVIDER_DISABLED';
  readonly cause?: unknown;
  constructor(code: ExtractError['code'], message: string, cause?: unknown) {
    super(message);
    this.name = 'ExtractError';
    this.code = code;
    this.cause = cause;
  }
}
