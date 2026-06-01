// [460-fork] Helper for "this upload should be refused" tests.
//
// When an endpoint rejects a multipart upload at a middleware BEFORE multer
// consumes the request body (e.g. requireTripAccess -> 404, demoUploadBlock
// -> 403), the server closes the socket while the client is still streaming
// the file. Node/supertest then surface this as a thrown `ECONNRESET` rather
// than delivering the HTTP error response. Whether the client observes the
// status code or the connection reset is purely timing — it flakes under
// parallel test load.
//
// Both outcomes prove exactly what these tests assert: the upload was
// refused before the body was read. This helper accepts either, while still
// FAILING if the server actually ACCEPTS the upload (any 2xx/3xx), so a
// genuine authorization/permission regression is still caught.
import { expect } from 'vitest';
import type { Test } from 'supertest';

const RESET_CODES = new Set(['ECONNRESET', 'EPIPE']);

export async function expectUploadRefused(req: Test, expectedStatus: number): Promise<void> {
  try {
    const res = await req;
    // A response arrived — it MUST be the rejection status, never a success.
    expect(res.status).toBe(expectedStatus);
  } catch (err: unknown) {
    const code = (err as { code?: string }).code;
    const message = (err as { message?: string }).message ?? '';
    const isReset = (code && RESET_CODES.has(code)) || /ECONNRESET|socket hang up|EPIPE/i.test(message);
    if (!isReset) throw err; // a real, unexpected error — surface it
    // ECONNRESET here == server closed the connection refusing the upload
    // before reading the body. That is the refusal we're asserting.
  }
}
