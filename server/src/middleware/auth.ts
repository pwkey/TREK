import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { db } from '../db/database';
import { JWT_SECRET } from '../config';
import { AuthRequest, OptionalAuthRequest, User } from '../types';
import { idempotency } from './idempotency'; // [460-fork] Milestone 5

export function extractToken(req: Request): string | null {
  // Prefer httpOnly cookie; fall back to Authorization: Bearer (MCP, API clients)
  const cookieToken = (req as any).cookies?.trek_session;
  if (cookieToken) return cookieToken;
  const authHeader = req.headers['authorization'];
  return (authHeader && authHeader.split(' ')[1]) || null;
}

const _doAuthenticate = (req: Request, res: Response, next: NextFunction): void => {
  const token = extractToken(req);

  if (!token) {
    res.status(401).json({ error: 'Access token required', code: 'AUTH_REQUIRED' });
    return;
  }

  let user: User | undefined;
  try {
    const decoded = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] }) as { id: number };
    user = db.prepare(
      'SELECT id, username, email, role FROM users WHERE id = ?'
    ).get(decoded.id) as User | undefined;
  } catch {
    res.status(401).json({ error: 'Invalid or expired token', code: 'AUTH_REQUIRED' });
    return;
  }
  if (!user) {
    res.status(401).json({ error: 'User not found', code: 'AUTH_REQUIRED' });
    return;
  }
  (req as AuthRequest).user = user;
  // next() runs OUTSIDE the catch above so that downstream middleware errors
  // don't get mistaken for an auth failure.
  next();
};

// [460-fork] Milestone 5 — chain the idempotency middleware after auth so
// every authenticated mutation route automatically gets request-level
// dedup via X-Client-Mutation-Id.
const authenticate = (req: Request, res: Response, next: NextFunction): void => {
  _doAuthenticate(req, res, (err?: unknown) => {
    if (err) return next(err);
    if (res.headersSent) return;
    idempotency(req, res, next);
  });
};

const optionalAuth = (req: Request, res: Response, next: NextFunction): void => {
  const token = extractToken(req);

  if (!token) {
    (req as OptionalAuthRequest).user = null;
    return next();
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] }) as { id: number };
    const user = db.prepare(
      'SELECT id, username, email, role FROM users WHERE id = ?'
    ).get(decoded.id) as User | undefined;
    (req as OptionalAuthRequest).user = user || null;
  } catch (err: unknown) {
    (req as OptionalAuthRequest).user = null;
  }
  next();
};

const adminOnly = (req: Request, res: Response, next: NextFunction): void => {
  const authReq = req as AuthRequest;
  if (!authReq.user || authReq.user.role !== 'admin') {
    res.status(403).json({ error: 'Admin access required' });
    return;
  }
  next();
};

const demoUploadBlock = (req: Request, res: Response, next: NextFunction): void => {
  const authReq = req as AuthRequest;
  if (process.env.DEMO_MODE === 'true' && authReq.user?.email === 'demo@nomad.app') {
    res.status(403).json({ error: 'Uploads are disabled in demo mode. Self-host NOMAD for full functionality.' });
    return;
  }
  next();
};

export { authenticate, optionalAuth, adminOnly, demoUploadBlock };
