import express, { Request, Response } from 'express';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { authenticate } from '../middleware/auth';
import { AuthRequest } from '../types';
import { checkPermission } from '../services/permissions';
import { verifyTripAccess } from '../services/reservationService';
import { createFile, filesDir } from '../services/fileService';
import { db } from '../db/database';
import { extractReservationDraft } from '../services/reservationImport/extractor';
import { extractPdfText } from '../services/reservationImport/pdfTextExtractor';
import { extractRequestSchema, normaliseAutoAttach } from '../services/reservationImport/validation';
import { matchPassengers, PassengerMatchCandidate } from '../services/reservationImport/passengerMatcher';
import {
  findByClientMutationId,
  recordImportStart,
  recordImportComplete,
  recordImportFailure,
} from '../services/reservationImport/importAuditService';
import { ExtractError } from '../services/reservationImport/types';

const router = express.Router({ mergeParams: true });

const MAX_PDF_BYTES = 10 * 1024 * 1024; // 10 MB
const TMP_DIR = path.join(os.tmpdir(), '460-trip-planner-reservation-imports');

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });
    cb(null, TMP_DIR);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname) || '.pdf';
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 10)}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_PDF_BYTES },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext !== '.pdf' && file.mimetype !== 'application/pdf') {
      cb(new Error('Only PDF files are accepted'));
      return;
    }
    cb(null, true);
  },
});

// Wraps multer so upload errors (wrong type, too big) return a clean 400
// instead of bubbling to the global 500 handler.
function singlePdfUpload(req: Request, res: Response, next: (err?: unknown) => void) {
  upload.single('file')(req, res, (err: unknown) => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      return res.status(400).json({ error: err.message, code: 'UPLOAD_ERROR' });
    }
    if (err instanceof Error && err.message === 'Only PDF files are accepted') {
      return res.status(400).json({ error: err.message, code: 'UPLOAD_ERROR' });
    }
    return next(err);
  });
}

function cleanupTmp(filePath: string | undefined) {
  if (!filePath) return;
  fs.unlink(filePath, () => undefined);
}

// [460-fork] M3 slice 5 / M11 — build the candidate list for the
// passenger matcher. The candidate set is the calling user + every other
// user in their household + every named household member.
//
// User-account candidates are aliased on username, email local-part, and
// full email so the matcher can score token splits. Named members are
// aliased only on their name (the matcher's token-set + Levenshtein logic
// handles "Emily" vs "Emily Key" within reason).
function buildMatchCandidates(userId: number): PassengerMatchCandidate[] {
  const user = db.prepare('SELECT id, username, email, household_id FROM users WHERE id = ?').get(userId) as { id: number; username: string; email: string; household_id: number | null } | undefined;
  if (!user) return [];
  const candidates: PassengerMatchCandidate[] = [aliasesFor(user.id, user.username, user.email)];
  if (user.household_id) {
    const others = db
      .prepare('SELECT id, username, email FROM users WHERE household_id = ? AND id != ?')
      .all(user.household_id, user.id) as Array<{ id: number; username: string; email: string }>;
    for (const peer of others) {
      candidates.push(aliasesFor(peer.id, peer.username, peer.email));
    }
    // [460-fork] M11 slice 5 — named household_members (no-account):
    // pets, kids, granny. Single-alias entries; matcher token-logic
    // handles "Emily" vs "Emily Key" reasonably.
    const members = db
      .prepare('SELECT id, name FROM household_members WHERE household_id = ?')
      .all(user.household_id) as Array<{ id: number; name: string }>;
    for (const m of members) {
      candidates.push({ id: m.id, kind: 'member', aliases: [m.name].filter(Boolean) });
    }
  }
  return candidates;
}

// [460-fork] M11 slice 5 — split a matchPassengers result into the two
// shaped fields the wire API exposes: matched_user_ids[] for user-account
// matches (legacy field, unchanged shape) and matched_member_ids[] for
// named household_members (new field, additive — clients that don't read
// it ignore it harmlessly).
function splitMatchedIds(matches: ReturnType<typeof matchPassengers>): { matched_user_ids: Array<number | null>; matched_member_ids: Array<number | null> } {
  const matched_user_ids: Array<number | null> = [];
  const matched_member_ids: Array<number | null> = [];
  for (const m of matches) {
    if (!m) {
      matched_user_ids.push(null);
      matched_member_ids.push(null);
    } else if (m.kind === 'user') {
      matched_user_ids.push(m.id);
      matched_member_ids.push(null);
    } else {
      matched_user_ids.push(null);
      matched_member_ids.push(m.id);
    }
  }
  return { matched_user_ids, matched_member_ids };
}

function aliasesFor(id: number, username: string, email: string): PassengerMatchCandidate {
  const emailLocal = (email || '').split('@')[0] || '';
  return { id, aliases: [username, emailLocal, email].filter(Boolean) };
}

function mapErrorToResponse(err: unknown): { status: number; body: Record<string, unknown> } {
  if (err instanceof ExtractError) {
    switch (err.code) {
      case 'EMPTY_INPUT':
      case 'PDF_EMPTY':
        return { status: 400, body: { error: err.message, code: err.code } };
      case 'PROVIDER_DISABLED':
        return { status: 409, body: { error: err.message, code: 'IMPORT_DISABLED' } };
      case 'PROVIDER_TIMEOUT':
        return { status: 504, body: { error: err.message, code: err.code } };
      case 'PROVIDER_ERROR':
      case 'PROVIDER_INVALID_JSON':
      case 'PROVIDER_SCHEMA_MISMATCH':
        return { status: 502, body: { error: err.message, code: err.code } };
    }
  }
  return { status: 500, body: { error: (err as Error)?.message || 'Extraction failed', code: 'INTERNAL' } };
}

// POST /api/trips/:tripId/reservation-imports/extract
router.post('/extract', authenticate, singlePdfUpload, async (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const tripId = Number(req.params.tripId);
  const uploadedFile = (req as unknown as { file?: Express.Multer.File }).file;

  try {
    const trip = verifyTripAccess(tripId, authReq.user.id);
    if (!trip) {
      cleanupTmp(uploadedFile?.path);
      return res.status(404).json({ error: 'Trip not found' });
    }

    if (!checkPermission('reservation_edit', authReq.user.role, trip.user_id, authReq.user.id, trip.user_id !== authReq.user.id)) {
      cleanupTmp(uploadedFile?.path);
      return res.status(403).json({ error: 'No permission' });
    }

    const parsed = extractRequestSchema.safeParse({
      email_text: typeof req.body?.email_text === 'string' ? req.body.email_text : undefined,
      auto_attach: req.body?.auto_attach,
    });
    if (!parsed.success) {
      cleanupTmp(uploadedFile?.path);
      return res.status(400).json({ error: parsed.error.message, code: 'INVALID_INPUT' });
    }

    const emailText = parsed.data.email_text;
    if (!uploadedFile && !emailText) {
      return res.status(400).json({ error: 'Provide a PDF file or email_text', code: 'EMPTY_INPUT' });
    }
    if (uploadedFile && emailText) {
      cleanupTmp(uploadedFile.path);
      return res.status(400).json({ error: 'Provide either a file OR email_text, not both', code: 'INVALID_INPUT' });
    }

    // Idempotency: if the client retries with the same X-Client-Mutation-Id, return the cached result.
    // [460-fork] Note: in practice this per-route check is unreachable
    // because the global idempotency middleware (Milestone 5 slice 2,
    // src/middleware/idempotency.ts) fires earlier and serves cached
    // responses keyed by (user_id, mutation_id). Kept as a defensive
    // fallback for the (tripId, cmid) edge case where the same cmid is
    // reused across different trips — the global middleware would
    // collide on (userId, cmid) and incorrectly serve the wrong trip's
    // cached response, but the global middleware is the actual fix.
    const clientMutationId = (req.headers['x-client-mutation-id'] as string | undefined)?.trim() || null;
    if (clientMutationId) {
      const existing = findByClientMutationId(tripId, clientMutationId);
      if (existing && existing.status === 'draft' && existing.parsed_json) {
        cleanupTmp(uploadedFile?.path);
        const replayedDraft = JSON.parse(existing.parsed_json);
        const split = splitMatchedIds(matchPassengers(
          Array.isArray(replayedDraft?.passenger_names) ? replayedDraft.passenger_names : [],
          buildMatchCandidates(authReq.user.id),
        ));
        return res.json({
          import_id: existing.id,
          draft: replayedDraft,
          confidence: existing.confidence ?? 0,
          provider_used: existing.provider,
          attached_file_id: existing.source_file_id ?? null,
          matched_user_ids: split.matched_user_ids,
          matched_member_ids: split.matched_member_ids,
          replayed: true,
        });
      }
    }

    const sourceType: 'pdf' | 'email_text' = uploadedFile ? 'pdf' : 'email_text';
    const importId = recordImportStart({
      tripId,
      userId: authReq.user.id,
      sourceType,
      clientMutationId,
    });

    let rawText: string;
    try {
      if (uploadedFile) {
        const buffer = await fs.promises.readFile(uploadedFile.path);
        const pdfResult = await extractPdfText(buffer);
        if (!pdfResult.hadText) {
          throw new ExtractError('PDF_EMPTY', 'PDF has no extractable text layer. OCR fallback ships in slice 6.');
        }
        rawText = pdfResult.text;
      } else {
        rawText = emailText!;
      }

      const result = await extractReservationDraft(
        { kind: sourceType, text: rawText },
        { tripId, userId: authReq.user.id, clientMutationId },
      );
      recordImportComplete(importId, result);

      // Auto-attach: on successful PDF extraction, move the tmp file into the
      // trip's files directory and register a trip_files row (not yet linked
      // to a reservation — the reservation doesn't exist until the user saves).
      let attachedFileId: number | null = null;
      if (uploadedFile && normaliseAutoAttach(req.body?.auto_attach)) {
        try {
          if (!fs.existsSync(filesDir)) fs.mkdirSync(filesDir, { recursive: true });
          const ext = path.extname(uploadedFile.originalname) || '.pdf';
          const storedName = `${randomUUID()}${ext}`;
          const destPath = path.join(filesDir, storedName);
          await fs.promises.copyFile(uploadedFile.path, destPath);
          const created = createFile(
            tripId,
            { filename: storedName, originalname: uploadedFile.originalname, size: uploadedFile.size, mimetype: uploadedFile.mimetype },
            authReq.user.id,
            {},
          );
          attachedFileId = created.id as number;
          db.prepare('UPDATE reservation_imports SET source_file_id = ? WHERE id = ?').run(attachedFileId, importId);
        } catch (attachErr) {
          console.error('[reservation-import] auto-attach failed:', attachErr);
        }
      }

      const split = splitMatchedIds(matchPassengers(
        result.draft.passenger_names ?? [],
        buildMatchCandidates(authReq.user.id),
      ));
      return res.json({
        import_id: importId,
        draft: result.draft,
        confidence: result.confidence,
        provider_used: result.provider_used,
        attached_file_id: attachedFileId,
        matched_user_ids: split.matched_user_ids,
        matched_member_ids: split.matched_member_ids,
      });
    } catch (innerErr) {
      const msg = innerErr instanceof Error ? innerErr.message : String(innerErr);
      recordImportFailure(importId, msg);
      const mapped = mapErrorToResponse(innerErr);
      return res.status(mapped.status).json({ ...mapped.body, import_id: importId });
    }
  } catch (err) {
    const mapped = mapErrorToResponse(err);
    return res.status(mapped.status).json(mapped.body);
  } finally {
    cleanupTmp(uploadedFile?.path);
    // Touch auto_attach so the linter doesn't warn — value is used in slice 4.
    void normaliseAutoAttach(req.body?.auto_attach);
  }
});

export default router;
