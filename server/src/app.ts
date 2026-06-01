import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import fs from 'node:fs';

import jwt from 'jsonwebtoken';
import { JWT_SECRET } from './config';
import { logDebug, logWarn, logError } from './services/auditLog';
import { enforceGlobalMfaPolicy } from './middleware/mfaPolicy';
import { authenticate } from './middleware/auth';
import { db } from './db/database';

import authRoutes from './routes/auth';
import householdRoutes from './routes/household'; // [460-fork] Milestone 11 slice 2
import tripsRoutes from './routes/trips';
import daysRoutes, { accommodationsRouter as accommodationsRoutes } from './routes/days';
import placesRoutes from './routes/places';
import assignmentsRoutes from './routes/assignments';
import packingRoutes from './routes/packing';
import todoRoutes from './routes/todo';
import tagsRoutes from './routes/tags';
import categoriesRoutes from './routes/categories';
import adminRoutes from './routes/admin';
import mapsRoutes from './routes/maps';
import filesRoutes from './routes/files';
import reservationsRoutes from './routes/reservations';
import reservationImportRoutes from './routes/reservationImport';
import dayNotesRoutes from './routes/dayNotes';
import journalRoutes from './routes/journals'; // [460-fork] Milestone 6 slice 1
import dayPhotosRoutes from './routes/dayPhotos'; // [460-fork] Milestone 6 slice 2
import photoRouteOverridesRoutes from './routes/photoRouteOverrides'; // [460-fork] M6 follow-up
import gpxTracksRoutes from './routes/gpxTracks'; // [460-fork] M6 follow-up
import exportRoutes from './routes/export'; // [460-fork] Milestone 7 slice 1
import importRoutes from './routes/import'; // [460-fork] Milestone 7 slice 3
import pollsRoutes from './routes/polls'; // [460-fork] Milestone 9
import weatherRoutes from './routes/weather';
import settingsRoutes from './routes/settings';
import budgetRoutes from './routes/budget';
import collabRoutes from './routes/collab';
import backupRoutes from './routes/backup';
import oidcRoutes from './routes/oidc';
import vacayRoutes from './routes/vacay';
import segmentsRoutes from './routes/segments'; // [460-fork] Milestone 4
import conflictsRoutes from './routes/conflicts'; // [460-fork] Milestone 5
import atlasRoutes from './routes/atlas';
import memoriesRoutes from './routes/memories/unified';
import notificationRoutes from './routes/notifications';
import shareRoutes from './routes/share';
import { mcpHandler } from './mcp';
import { Addon } from './types';
import { getPhotoProviderConfig } from './services/memories/helpersService';

export function createApp(): express.Application {
  const app = express();

  // Trust first proxy (nginx/Docker) for correct req.ip
  if (process.env.NODE_ENV === 'production' || process.env.TRUST_PROXY) {
    app.set('trust proxy', Number.parseInt(process.env.TRUST_PROXY) || 1);
  }

  const allowedOrigins = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim()).filter(Boolean)
    : null;

  // [460-fork] In dev mode allow ANY origin regardless of ALLOWED_ORIGINS so
  // tunnels (ngrok / Cloudflare / Tailscale) work for phone-install testing
  // without having to keep .env in sync with the rotating tunnel hostname.
  // In production, ALLOWED_ORIGINS is the cross-origin allowlist; same-origin
  // requests always pass (browsers send Origin even for same-origin module
  // fetches, and rejecting those breaks the PWA serving its own JS bundle).
  const isProduction = process.env.NODE_ENV === 'production';
  // Delegate form so we can inspect the request to detect same-origin.
  const corsDelegate: (req: Request, cb: (err: Error | null, opts?: cors.CorsOptions) => void) => void = (req, cb) => {
    const origin = req.headers.origin as string | undefined;
    if (!isProduction || !origin) {
      cb(null, { origin: true, credentials: true });
      return;
    }
    // Same-origin: Origin header matches the request's own scheme + host.
    const proto = (req.headers['x-forwarded-proto'] as string) || (req.secure ? 'https' : 'http');
    const host = (req.headers['x-forwarded-host'] as string) || req.headers.host;
    if (host && origin === `${proto}://${host}`) {
      cb(null, { origin: true, credentials: true });
      return;
    }
    if (allowedOrigins && allowedOrigins.includes(origin)) {
      cb(null, { origin: true, credentials: true });
      return;
    }
    cb(new Error('Not allowed by CORS'));
  };

  const shouldForceHttps = process.env.FORCE_HTTPS === 'true';

  app.use(cors(corsDelegate));
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://unpkg.com"],
        imgSrc: ["'self'", "data:", "blob:", "https:"],
        connectSrc: [
          "'self'", "ws:", "wss:",
          "https://nominatim.openstreetmap.org", "https://overpass-api.de",
          "https://places.googleapis.com", "https://api.openweathermap.org",
          "https://en.wikipedia.org", "https://commons.wikimedia.org",
          "https://*.basemaps.cartocdn.com", "https://*.tile.openstreetmap.org",
          "https://unpkg.com", "https://open-meteo.com", "https://api.open-meteo.com",
          "https://geocoding-api.open-meteo.com", "https://api.exchangerate-api.com",
          "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_admin_0_countries.geojson",
          "https://router.project-osrm.org/route/v1/"
        ],
        fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
        objectSrc: ["'none'"],
        frameSrc: ["'none'"],
        frameAncestors: ["'self'"],
        upgradeInsecureRequests: shouldForceHttps ? [] : null
      }
    },
    crossOriginEmbedderPolicy: false,
    hsts: shouldForceHttps ? { maxAge: 31536000, includeSubDomains: false } : false,
  }));

  if (shouldForceHttps) {
    app.use((req: Request, res: Response, next: NextFunction) => {
      // [460-fork] Exempt /api/health from the HTTPS redirect so internal
      // Docker/Coolify healthchecks (which hit http://localhost:3000 directly,
      // without going through Traefik and so without an X-Forwarded-Proto
      // header) get a 200 instead of being redirected to https://localhost,
      // which then fails SSL handshake against the plain-HTTP container.
      if (req.path === '/api/health') return next();
      if (req.secure || req.headers['x-forwarded-proto'] === 'https') return next();
      res.redirect(301, 'https://' + req.headers.host + req.url);
    });
  }

  app.use(express.json({ limit: '100kb' }));
  app.use(express.urlencoded({ extended: true }));
  app.use(cookieParser());
  app.use(enforceGlobalMfaPolicy);

  // Request logging with sensitive field redaction
  {
    const SENSITIVE_KEYS = new Set(['password', 'new_password', 'current_password', 'token', 'jwt', 'authorization', 'cookie', 'client_secret', 'mfa_token', 'code', 'smtp_pass']);
    const redact = (value: unknown): unknown => {
      if (!value || typeof value !== 'object') return value;
      if (Array.isArray(value)) return (value as unknown[]).map(redact);
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = SENSITIVE_KEYS.has(k.toLowerCase()) ? '[REDACTED]' : redact(v);
      }
      return out;
    };

    app.use((req: Request, res: Response, next: NextFunction) => {
      if (req.path === '/api/health') return next();
      const startedAt = Date.now();
      res.on('finish', () => {
        const ms = Date.now() - startedAt;
        if (res.statusCode >= 500) {
          logError(`${req.method} ${req.path} ${res.statusCode} ${ms}ms ip=${req.ip}`);
        } else if (res.statusCode === 401 || res.statusCode === 403) {
          logDebug(`${req.method} ${req.path} ${res.statusCode} ${ms}ms ip=${req.ip}`);
        } else if (res.statusCode >= 400) {
          logWarn(`${req.method} ${req.path} ${res.statusCode} ${ms}ms ip=${req.ip}`);
        }
        const q = Object.keys(req.query).length ? ` query=${JSON.stringify(redact(req.query))}` : '';
        const b = req.body && Object.keys(req.body).length ? ` body=${JSON.stringify(redact(req.body))}` : '';
        logDebug(`${req.method} ${req.path} ${res.statusCode} ${ms}ms ip=${req.ip}${q}${b}`);
      });
      next();
    });
  }

  // Static: avatars and covers are public
  app.use('/uploads/avatars', express.static(path.join(__dirname, '../uploads/avatars')));
  app.use('/uploads/covers', express.static(path.join(__dirname, '../uploads/covers')));

  // Photos require auth or valid share token
  app.get('/uploads/photos/:filename', (req: Request, res: Response) => {
    const safeName = path.basename(req.params.filename);
    const filePath = path.join(__dirname, '../uploads/photos', safeName);
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(path.resolve(__dirname, '../uploads/photos'))) {
      return res.status(403).send('Forbidden');
    }
    if (!fs.existsSync(resolved)) return res.status(404).send('Not found');

    const authHeader = req.headers.authorization;
    const token = (req.query.token as string) || (authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null);
    if (!token) return res.status(401).send('Authentication required');

    try {
      jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
    } catch {
      const shareRow = db.prepare('SELECT id FROM share_tokens WHERE token = ?').get(token);
      if (!shareRow) return res.status(401).send('Authentication required');
    }
    res.sendFile(resolved);
  });

  // Block direct access to /uploads/files
  app.use('/uploads/files', (_req: Request, res: Response) => {
    res.status(401).send('Authentication required');
  });

  // API Routes
  app.use('/api/auth', authRoutes);
  app.use('/api/auth/oidc', oidcRoutes);
  app.use('/api/household', householdRoutes); // [460-fork] Milestone 11 slice 2
  // [460-fork] Milestone 7 slice 3 — mount BEFORE /api/trips so the
  // string "import" can't be matched as a trip id by tripsRoutes.
  app.use('/api/trips/import', importRoutes);
  app.use('/api/trips', tripsRoutes);
  app.use('/api/trips/:tripId/days', daysRoutes);
  app.use('/api/trips/:tripId/accommodations', accommodationsRoutes);
  app.use('/api/trips/:tripId/places', placesRoutes);
  app.use('/api/trips/:tripId/packing', packingRoutes);
  app.use('/api/trips/:tripId/todo', todoRoutes);
  app.use('/api/trips/:tripId/files', filesRoutes);
  app.use('/api/trips/:tripId/budget', budgetRoutes);
  app.use('/api/trips/:tripId/collab', collabRoutes);
  app.use('/api/trips/:tripId/reservations', reservationsRoutes);
  app.use('/api/trips/:tripId/reservation-imports', reservationImportRoutes);
  app.use('/api/trips/:tripId/days/:dayId/notes', dayNotesRoutes);
  app.use('/api/trips/:tripId/days/:dayId/journal', journalRoutes); // [460-fork] Milestone 6 slice 1
  app.use('/api/trips/:tripId/days/:dayId/photos', dayPhotosRoutes); // [460-fork] Milestone 6 slice 2
  app.use('/api/trips/:tripId/photo-route-overrides', photoRouteOverridesRoutes); // [460-fork] M6 follow-up
  app.use('/api/trips/:tripId/gpx-tracks', gpxTracksRoutes); // [460-fork] M6 follow-up
  app.use('/api/trips', exportRoutes); // [460-fork] Milestone 7 slice 1 — exposes /:tripId/export
  app.use('/api/polls', pollsRoutes); // [460-fork] Milestone 9
  // [460-fork] Health endpoint reports the build commit so a deploy can be
  // VERIFIED to be live (not just "webhook accepted"). SOURCE_COMMIT is
  // baked in at Docker build time (ARG -> ENV); falls back to 'unknown'
  // for local/dev runs where it isn't set. The CI post-deploy step polls
  // this until it sees the SHA it pushed — see .github/workflows/ci.yml.
  app.get('/api/health', (_req: Request, res: Response) => res.json({
    status: 'ok',
    commit: process.env.SOURCE_COMMIT || 'unknown',
  }));
  app.use('/api', assignmentsRoutes);
  app.use('/api/segments', segmentsRoutes); // [460-fork] Milestone 4
  app.use('/api/conflicts', conflictsRoutes); // [460-fork] Milestone 5
  app.use('/api/tags', tagsRoutes);
  app.use('/api/categories', categoriesRoutes);
  app.use('/api/admin', adminRoutes);

  // Addons list endpoint
  app.get('/api/addons', authenticate, (_req: Request, res: Response) => {
    const addons = db.prepare('SELECT id, name, type, icon, enabled FROM addons WHERE enabled = 1 ORDER BY sort_order').all() as Pick<Addon, 'id' | 'name' | 'type' | 'icon' | 'enabled'>[];
    const providers = db.prepare(`
      SELECT id, name, icon, enabled, sort_order
      FROM photo_providers
      WHERE enabled = 1
      ORDER BY sort_order, id
    `).all() as Array<{ id: string; name: string; icon: string; enabled: number; sort_order: number }>;
    const fields = db.prepare(`
      SELECT provider_id, field_key, label, input_type, placeholder, required, secret, settings_key, payload_key, sort_order
      FROM photo_provider_fields
      ORDER BY sort_order, id
    `).all() as Array<{
      provider_id: string;
      field_key: string;
      label: string;
      input_type: string;
      placeholder?: string | null;
      required: number;
      secret: number;
      settings_key?: string | null;
      payload_key?: string | null;
      sort_order: number;
    }>;

    const fieldsByProvider = new Map<string, typeof fields>();
    for (const field of fields) {
      const arr = fieldsByProvider.get(field.provider_id) || [];
      arr.push(field);
      fieldsByProvider.set(field.provider_id, arr);
    }

    res.json({
      addons: [
        ...addons.map(a => ({ ...a, enabled: !!a.enabled })),
        ...providers.map(p => ({
          id: p.id,
          name: p.name,
          type: 'photo_provider',
          icon: p.icon,
          enabled: !!p.enabled,
          config: getPhotoProviderConfig(p.id),
          fields: (fieldsByProvider.get(p.id) || []).map(f => ({
            key: f.field_key,
            label: f.label,
            input_type: f.input_type,
            placeholder: f.placeholder || '',
            required: !!f.required,
            secret: !!f.secret,
            settings_key: f.settings_key || null,
            payload_key: f.payload_key || null,
            sort_order: f.sort_order,
          })),
        })),
      ],
    });
  });

  // Addon routes
  app.use('/api/addons/vacay', vacayRoutes);
  app.use('/api/addons/atlas', atlasRoutes);
  app.use('/api/integrations/memories', memoriesRoutes);
  app.use('/api/maps', mapsRoutes);
  app.use('/api/weather', weatherRoutes);
  app.use('/api/settings', settingsRoutes);
  app.use('/api/backup', backupRoutes);
  app.use('/api/notifications', notificationRoutes);
  app.use('/api', shareRoutes);

  // MCP endpoint
  app.post('/mcp', mcpHandler);
  app.get('/mcp', mcpHandler);
  app.delete('/mcp', mcpHandler);

  // Production static file serving
  if (process.env.NODE_ENV === 'production') {
    const publicPath = path.join(__dirname, '../public');
    app.use(express.static(publicPath, {
      setHeaders: (res, filePath) => {
        if (filePath.endsWith('index.html')) {
          res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        }
      },
    }));
    app.get('*', (_req: Request, res: Response) => {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.sendFile(path.join(publicPath, 'index.html'));
    });
  }

  // Global error handler
  app.use((err: Error & { status?: number; statusCode?: number }, _req: Request, res: Response, _next: NextFunction) => {
    if (process.env.NODE_ENV === 'production') {
      console.error('Unhandled error:', err.message);
    } else {
      console.error('Unhandled error:', err);
    }
    const status = err.statusCode || 500;
    res.status(status).json({ error: 'Internal server error' });
  });

  return app;
}
