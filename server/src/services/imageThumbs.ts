// [460-fork] Photo thumbnail generation (sharp).
//
// Kept separate from fileService so the sharp/libvips native dependency only
// loads where thumbnails are actually generated (the photo upload path) — the
// rest of fileService (path helpers, delete cleanup) stays sharp-free.
//
// Generation is always best-effort: a failure (undecodable image, missing
// libvips codec, etc.) is logged and swallowed. The download route falls back
// to the original file whenever a thumbnail is absent, so nothing breaks.
import fs from 'fs';
import sharp from 'sharp';
import { filesDir, thumbsDir, thumbFilename, resolveFilePath } from './fileService';
import path from 'path';

// 400px longest edge, JPEG q70 — ~20–50 KB, plenty for grids and the memoir.
const THUMB_MAX_EDGE = 400;
const THUMB_QUALITY = 70;

/** Generate (or regenerate) the thumbnail for an uploaded image. Returns whether one was written. */
export async function generateThumbnail(filename: string): Promise<boolean> {
  try {
    const { resolved: src, safe } = resolveFilePath(filename);
    if (!safe || !fs.existsSync(src)) return false;
    if (!fs.existsSync(thumbsDir)) fs.mkdirSync(thumbsDir, { recursive: true });
    const dest = path.join(thumbsDir, thumbFilename(filename));
    await sharp(src)
      .rotate() // bake in EXIF orientation
      .resize(THUMB_MAX_EDGE, THUMB_MAX_EDGE, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: THUMB_QUALITY })
      .toFile(dest);
    return true;
  } catch (e) {
    console.error('[Thumbs] generate failed for', filename, '—', e instanceof Error ? e.message : e);
    return false;
  }
}
