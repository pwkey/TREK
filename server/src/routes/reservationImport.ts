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
    const clientMutationId = (req.headers['x-client-mutation-id'] as string | undefined)?.trim() || null;
    if (clientMutationId) {
      const existing = findByClientMutationId(tripId, clientMutationId);
      if (existing && existing.status === 'draft' && existing.parsed_json) {
        cleanupTmp(uploadedFile?.path);
        return res.json({
          import_id: existing.id,
          draft: JSON.parse(existing.parsed_json),
          confidence: existing.confidence ?? 0,
          provider_used: existing.provider,
          attached_file_id: existing.source_file_id ?? null,
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

      return res.json({
        import_id: importId,
        draft: result.draft,
        confidence: result.confidence,
        provider_used: result.provider_used,
        attached_file_id: attachedFileId,
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
