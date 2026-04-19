import { z } from 'zod';

const MAX_EMAIL_TEXT_BYTES = 200 * 1024;

// Multipart is parsed by multer — these are the shape the handler receives AFTER multer.
export const extractRequestSchema = z
  .object({
    email_text: z.string().max(MAX_EMAIL_TEXT_BYTES, 'email_text too large').optional(),
    auto_attach: z.union([z.literal('true'), z.literal('false'), z.boolean()]).optional(),
  })
  .strict();

export type ExtractRequestBody = z.infer<typeof extractRequestSchema>;

export function normaliseAutoAttach(raw: unknown): boolean {
  if (raw === true || raw === 'true') return true;
  if (raw === false || raw === 'false') return false;
  return true; // default: on when a file is present; caller decides
}
