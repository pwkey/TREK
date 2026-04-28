// [460-fork] Milestone 7 slice 3 — JSON / bundle import.
//
// POST /api/trips/import          (multipart/form-data, field "file")
//   ?dry_run=true (default)       returns DryRunReport, no DB writes
//   ?dry_run=false                creates a fresh trip, returns
//                                 { trip_id, created }
//
// Auth: any authenticated user. Imports always create a NEW trip owned
// by the importer; restore-by-UUID is slice 7.4. Demo users are blocked
// per the existing demoUploadBlock pattern (parity with files.ts).
import express, { Request, Response } from 'express';
import multer from 'multer';
import { authenticate, demoUploadBlock } from '../middleware/auth';
import { AuthRequest } from '../types';
import { parseImportInput, dryRunImport, applyImport } from '../services/importService';

const router = express.Router({ mergeParams: true });

// In-memory upload — bundles are typically a few MB and we'd rather not
// leave half-extracted files on disk if validation fails partway. Cap at
// 200 MB to keep a single bad upload from OOMing the server.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 } });

router.post('/', authenticate, demoUploadBlock, upload.single('file'), async (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  if (!req.file) return res.status(400).json({ error: 'No file uploaded (expected multipart field "file")' });

  let input;
  try {
    input = await parseImportInput(req.file.buffer);
  } catch (err) {
    return res.status(400).json({ error: err instanceof Error ? err.message : 'Could not parse file' });
  }

  const dryRun = req.query.dry_run !== 'false'; // default true
  const report = dryRunImport(input);
  if (dryRun) {
    return res.json({ dry_run: true, report });
  }

  if (report.errors.length > 0) {
    return res.status(400).json({ dry_run: false, report, error: 'Import has validation errors — see report.errors' });
  }

  try {
    const result = applyImport(input, authReq.user.id);
    return res.status(201).json({ dry_run: false, report, result });
  } catch (err) {
    return res.status(500).json({ error: err instanceof Error ? err.message : 'Import failed' });
  }
});

export default router;
