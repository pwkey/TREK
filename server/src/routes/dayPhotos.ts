// [460-fork] Milestone 6 slice 2 — per-day photo endpoints.
//
//   GET    /api/trips/:tripId/days/:dayId/photos
//   POST   /api/trips/:tripId/days/:dayId/photos          multipart upload
//   PUT    /api/trips/:tripId/days/:dayId/photos/reorder  { orderedIds: [] }
//   PUT    /api/trips/:tripId/days/:dayId/photos/:id      { caption?, taken_at? }
//   DELETE /api/trips/:tripId/days/:dayId/photos/:id
//
// The route reuses fileService.createFile to land bytes in the existing
// trip_files store (so the file shows up in the Files tab as well) and
// dayPhotoService.attachPhoto to pin it to the day. Client-side resize and
// EXIF capture-date extraction (slice 2 client work) flow through as
// regular form fields (`taken_at`, `caption`).
import express, { Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { authenticate, demoUploadBlock } from '../middleware/auth';
import { broadcast } from '../websocket';
import { checkPermission } from '../services/permissions';
import { AuthRequest } from '../types';
import { MAX_FILE_SIZE, BLOCKED_EXTENSIONS, filesDir, getAllowedExtensions, createFile } from '../services/fileService';
import * as dayPhotoService from '../services/dayPhotoService';

const router = express.Router({ mergeParams: true });

// Multer setup mirrors files.ts so allowed-extension config and storage
// paths stay consistent. We could refactor to a shared multer factory
// later — for now copying keeps the M6 footprint additive.
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    if (!fs.existsSync(filesDir)) fs.mkdirSync(filesDir, { recursive: true });
    cb(null, filesDir);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${uuidv4()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE },
  defParamCharset: 'utf8',
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (BLOCKED_EXTENSIONS.includes(ext) || file.mimetype.includes('svg')) {
      const err: Error & { statusCode?: number } = new Error('File type not allowed');
      err.statusCode = 400;
      return cb(err);
    }
    // Photos must actually be images. Strip the rest of the trip_files
    // allowlist down to image-only here: we don't want PDFs uploaded as
    // "photos" via this endpoint.
    if (!file.mimetype.startsWith('image/')) {
      const err: Error & { statusCode?: number } = new Error('Only image files are allowed for photos');
      err.statusCode = 400;
      return cb(err);
    }
    const allowed = getAllowedExtensions().split(',').map(e => e.trim().toLowerCase());
    const fileExt = ext.replace('.', '');
    if (allowed.includes(fileExt) || (allowed.includes('*') && !BLOCKED_EXTENSIONS.includes(ext))) {
      cb(null, true);
    } else {
      const err: Error & { statusCode?: number } = new Error('File type not allowed');
      err.statusCode = 400;
      cb(err);
    }
  },
});

router.get('/', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId, dayId } = req.params;
  if (!dayPhotoService.verifyTripAccess(tripId, authReq.user.id)) return res.status(404).json({ error: 'Trip not found' });
  if (!dayPhotoService.dayAccessible(dayId, tripId)) return res.status(404).json({ error: 'Day not found' });
  res.json({ photos: dayPhotoService.listPhotos(Number(dayId), Number(tripId)) });
});

router.post('/', authenticate, demoUploadBlock, upload.single('file'), (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId, dayId } = req.params;
  const access = dayPhotoService.verifyTripAccess(tripId, authReq.user.id);
  if (!access) {
    if (req.file?.path) try { fs.unlinkSync(req.file.path); } catch { /* best effort */ }
    return res.status(404).json({ error: 'Trip not found' });
  }
  if (!checkPermission('day_edit', authReq.user.role, access.user_id, authReq.user.id, access.user_id !== authReq.user.id)) {
    if (req.file?.path) try { fs.unlinkSync(req.file.path); } catch { /* best effort */ }
    return res.status(403).json({ error: 'No permission' });
  }
  if (!dayPhotoService.dayAccessible(dayId, tripId)) {
    if (req.file?.path) try { fs.unlinkSync(req.file.path); } catch { /* best effort */ }
    return res.status(404).json({ error: 'Day not found' });
  }
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const created = createFile(
    tripId,
    { filename: req.file.filename, originalname: req.file.originalname, size: req.file.size, mimetype: req.file.mimetype },
    authReq.user.id,
    { description: typeof req.body.caption === 'string' ? req.body.caption : null },
  );

  // EXIF metadata arrives as form-data strings if the client extracted it.
  // Validate each one independently — skip junk, never reject the upload.
  const latRaw = parseFloat(typeof req.body.lat === 'string' ? req.body.lat : '');
  const lngRaw = parseFloat(typeof req.body.lng === 'string' ? req.body.lng : '');
  const altRaw = parseFloat(typeof req.body.altitude === 'string' ? req.body.altitude : '');
  const latValid = Number.isFinite(latRaw) && latRaw >= -90 && latRaw <= 90;
  const lngValid = Number.isFinite(lngRaw) && lngRaw >= -180 && lngRaw <= 180;
  // Mariana Trench is ~-11 km; Mt Everest is ~8.85 km; commercial planes ~12 km.
  // 30 km cap rejects EXIF nonsense without artificially limiting drone shots.
  const altValid = Number.isFinite(altRaw) && altRaw >= -12_000 && altRaw <= 30_000;
  const cameraRaw = typeof req.body.camera === 'string' ? req.body.camera.trim().slice(0, 80) : '';

  const photo = dayPhotoService.attachPhoto({
    dayId: Number(dayId),
    tripId: Number(tripId),
    uploadId: created.id,
    caption: typeof req.body.caption === 'string' ? req.body.caption : null,
    takenAt: typeof req.body.taken_at === 'string' ? req.body.taken_at : null,
    lat: latValid ? latRaw : null,
    lng: lngValid ? lngRaw : null,
    altitude: altValid ? altRaw : null,
    camera: cameraRaw.length > 0 ? cameraRaw : null,
  });

  res.status(201).json({ photo });
  broadcast(tripId, 'dayPhoto:created', { dayId: Number(dayId), photo }, req.headers['x-socket-id'] as string);
});

router.put('/reorder', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId, dayId } = req.params;
  const access = dayPhotoService.verifyTripAccess(tripId, authReq.user.id);
  if (!access) return res.status(404).json({ error: 'Trip not found' });
  if (!checkPermission('day_edit', authReq.user.role, access.user_id, authReq.user.id, access.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission' });
  if (!dayPhotoService.dayAccessible(dayId, tripId)) return res.status(404).json({ error: 'Day not found' });

  const orderedIds = Array.isArray(req.body?.orderedIds) ? (req.body.orderedIds as unknown[]).map(Number).filter(n => Number.isFinite(n)) : null;
  if (!orderedIds) return res.status(400).json({ error: 'orderedIds must be an array of numbers' });

  const photos = dayPhotoService.reorderPhotos(Number(dayId), Number(tripId), orderedIds);
  res.json({ photos });
  broadcast(tripId, 'dayPhoto:reordered', { dayId: Number(dayId), orderedIds }, req.headers['x-socket-id'] as string);
});

router.put('/:id', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId, dayId, id } = req.params;
  const access = dayPhotoService.verifyTripAccess(tripId, authReq.user.id);
  if (!access) return res.status(404).json({ error: 'Trip not found' });
  if (!checkPermission('day_edit', authReq.user.role, access.user_id, authReq.user.id, access.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission' });

  const current = dayPhotoService.getPhoto(Number(id));
  if (!current || current.day_id !== Number(dayId) || current.trip_id !== Number(tripId)) return res.status(404).json({ error: 'Photo not found' });

  const { caption, position, taken_at } = req.body ?? {};
  if (caption !== undefined && caption !== null && typeof caption !== 'string') return res.status(400).json({ error: 'caption must be a string or null' });
  if (position !== undefined && (typeof position !== 'number' || !Number.isFinite(position))) return res.status(400).json({ error: 'position must be a finite number' });
  if (taken_at !== undefined && taken_at !== null && typeof taken_at !== 'string') return res.status(400).json({ error: 'taken_at must be an ISO string or null' });

  const photo = dayPhotoService.updatePhoto(Number(id), current, { caption, position, taken_at });
  res.json({ photo });
  broadcast(tripId, 'dayPhoto:updated', { dayId: Number(dayId), photo }, req.headers['x-socket-id'] as string);
});

router.delete('/:id', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId, dayId, id } = req.params;
  const access = dayPhotoService.verifyTripAccess(tripId, authReq.user.id);
  if (!access) return res.status(404).json({ error: 'Trip not found' });
  if (!checkPermission('day_edit', authReq.user.role, access.user_id, authReq.user.id, access.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission' });

  const current = dayPhotoService.getPhoto(Number(id));
  if (!current || current.day_id !== Number(dayId) || current.trip_id !== Number(tripId)) return res.status(404).json({ error: 'Photo not found' });

  const { uploadFilename } = dayPhotoService.detachPhoto(current);
  // Best-effort disk cleanup. If the file is already gone (e.g. previous
  // failed delete) we just move on.
  try {
    const onDisk = path.join(filesDir, uploadFilename);
    if (fs.existsSync(onDisk)) fs.unlinkSync(onDisk);
  } catch { /* best effort */ }

  res.json({ success: true });
  broadcast(tripId, 'dayPhoto:deleted', { dayId: Number(dayId), photoId: Number(id) }, req.headers['x-socket-id'] as string);
});

export default router;
