// [460-fork] Offline-first idempotency middleware (Milestone 5).
//
// Reads X-Client-Mutation-Id off authenticated mutation requests and consults
// the client_mutations table. A previously-seen (user_id, mutation_id) pair
// short-circuits with the cached status + body. A first-time request runs the
// real handler; on the way out the response is recorded so a subsequent retry
// returns the same result instead of applying the mutation twice.
//
// Notes:
// - Mounted AFTER `authenticate` so user_id scoping is in place.
// - Skips GET/HEAD/OPTIONS — caching only matters for state-changing methods.
// - Skips if the header is absent. Endpoints that already manage idempotency
//   (e.g. reservation imports, partner invites, segment create) keep their
//   per-route logic; both layers are now idempotent.

import { Request, Response, NextFunction } from 'express';
import { db } from '../db/database';
import { AuthRequest } from '../types';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

interface CachedRow {
  status_code: number;
  response_body: string;
}

export function idempotency(req: Request, res: Response, next: NextFunction): void {
  if (SAFE_METHODS.has(req.method)) return next();

  const mutationId = (req.header('X-Client-Mutation-Id') || '').trim();
  if (!mutationId) return next();

  const userId = (req as AuthRequest).user?.id;
  if (!userId) return next();

  const cached = db
    .prepare('SELECT status_code, response_body FROM client_mutations WHERE user_id = ? AND client_mutation_id = ?')
    .get(userId, mutationId) as CachedRow | undefined;

  if (cached) {
    try {
      res.status(cached.status_code).json(JSON.parse(cached.response_body));
    } catch {
      // Stored row was somehow malformed; fall through to the real handler.
      // Best-effort recovery, shouldn't happen.
    }
    return;
  }

  // No cache: wrap res.json so we can capture the response on the way out.
  const originalJson = res.json.bind(res);
  res.json = (body: unknown): Response => {
    const status = res.statusCode || 200;
    if (status >= 200 && status < 400) {
      try {
        db.prepare(`
          INSERT OR IGNORE INTO client_mutations
            (client_mutation_id, user_id, endpoint, method, status_code, response_body)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(mutationId, userId, req.path, req.method, status, JSON.stringify(body));
      } catch (err) {
        // Logging only — don't fail the request if caching breaks.
        console.error('[idempotency] failed to cache response:', err instanceof Error ? err.message : err);
      }
    }
    return originalJson(body);
  };

  next();
}
