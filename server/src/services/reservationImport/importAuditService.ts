import { randomUUID } from 'node:crypto';
import { db } from '../../db/database';
import { ExtractResult } from './types';

export type ImportStatus = 'draft' | 'applied' | 'discarded' | 'failed';

export interface ImportAuditRow {
  id: string;
  trip_id: number;
  reservation_id: number | null;
  source_type: string;
  source_file_id: number | null;
  raw_text: string | null;
  parsed_json: string | null;
  confidence: number | null;
  status: ImportStatus;
  provider: string | null;
  model: string | null;
  error_message: string | null;
  client_mutation_id: string | null;
  created_at: string;
  updated_at: string;
  created_by: number;
  updated_by: number | null;
}

export function findByClientMutationId(tripId: number, clientMutationId: string): ImportAuditRow | null {
  return (db
    .prepare('SELECT * FROM reservation_imports WHERE trip_id = ? AND client_mutation_id = ?')
    .get(tripId, clientMutationId) as ImportAuditRow | undefined) ?? null;
}

export function recordImportStart(params: {
  tripId: number;
  userId: number;
  sourceType: 'pdf' | 'email_text' | 'ocr';
  clientMutationId?: string | null;
}): string {
  const id = randomUUID();
  db.prepare(`
    INSERT INTO reservation_imports (
      id, trip_id, source_type, status, client_mutation_id, created_by, updated_by
    ) VALUES (?, ?, ?, 'draft', ?, ?, ?)
  `).run(id, params.tripId, params.sourceType, params.clientMutationId ?? null, params.userId, params.userId);
  return id;
}

export function recordImportComplete(id: string, result: ExtractResult): void {
  db.prepare(`
    UPDATE reservation_imports
       SET raw_text = ?,
           parsed_json = ?,
           confidence = ?,
           provider = ?,
           model = ?,
           status = 'draft',
           updated_at = CURRENT_TIMESTAMP
     WHERE id = ?
  `).run(
    result.raw_text,
    JSON.stringify(result.draft),
    result.confidence,
    result.provider_used,
    result.model_used,
    id,
  );
}

export function recordImportFailure(id: string, errorMessage: string): void {
  db.prepare(`
    UPDATE reservation_imports
       SET status = 'failed',
           error_message = ?,
           updated_at = CURRENT_TIMESTAMP
     WHERE id = ?
  `).run(errorMessage.slice(0, 2000), id);
}

export function getImport(id: string): ImportAuditRow | null {
  return (db.prepare('SELECT * FROM reservation_imports WHERE id = ?').get(id) as ImportAuditRow | undefined) ?? null;
}

export function listImports(tripId: number, limit = 50): ImportAuditRow[] {
  return db
    .prepare('SELECT * FROM reservation_imports WHERE trip_id = ? ORDER BY created_at DESC LIMIT ?')
    .all(tripId, limit) as ImportAuditRow[];
}
