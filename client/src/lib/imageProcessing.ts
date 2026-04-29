// [460-fork] Milestone 6 slice 2 — client-side image processing.
//
// Three responsibilities, intentionally decoupled from the upload component:
//   - extractMetadata(file) → EXIF date / GPS / altitude / camera, all
//     individually nullable.
//   - resize(file, maxLongEdge) → JPEG Blob downscaled to fit within
//     maxLongEdge px, with EXIF Orientation BAKED INTO the pixels via
//     createImageBitmap({ imageOrientation: 'from-image' }) so portrait-
//     shot phone photos don't end up sideways after the canvas re-encode.
//   - prepareForUpload(file) → both, in a single call.
//
// Why client-side: M6 is offline-first, so resizing on the device avoids
// shipping originals over flaky travel connections. EXIF capture-date
// also lets the memoir mode (slice 3) order photos chronologically even
// when uploads happen out of order.
import exifr from 'exifr'

const DEFAULT_MAX_LONG_EDGE = 2048
const DEFAULT_QUALITY = 0.85

export interface PhotoMetadata {
  /** ISO 8601 from EXIF DateTimeOriginal / CreateDate / ModifyDate. */
  takenAt: string | null
  /** Decimal degrees. */
  lat: number | null
  lng: number | null
  /** Metres above sea level. */
  altitude: number | null
  /** Combined "Make Model" string, e.g. "Apple iPhone 15 Pro". */
  camera: string | null
}

/** EXIF read covering everything we want. Each field is nullable
 *  independently — a screenshot may have nothing; a phone photo with
 *  location off has date + camera but no GPS; etc.
 *
 *  Two parallel exifr calls because the `pick` option filters by RAW
 *  tag name (e.g. GPSLatitude) but `latitude` / `longitude` are
 *  computed virtuals — including them in `pick` causes exifr to
 *  return undefined for the whole result. The dedicated `exifr.gps()`
 *  helper does the right thing. */
export async function extractMetadata(file: Blob): Promise<PhotoMetadata> {
  try {
    const [meta, gps] = await Promise.all([
      exifr.parse(file, {
        pick: [
          'DateTimeOriginal', 'CreateDate', 'ModifyDate',
          'Make', 'Model',
          'GPSAltitude', 'GPSAltitudeRef',
        ],
      }) as Promise<{
        DateTimeOriginal?: Date | string
        CreateDate?: Date | string
        ModifyDate?: Date | string
        Make?: string
        Model?: string
        GPSAltitude?: number
        GPSAltitudeRef?: number
      } | undefined>,
      exifr.gps(file).catch(() => undefined) as Promise<{ latitude?: number; longitude?: number } | undefined>,
    ])

    // Capture date.
    let takenAt: string | null = null
    const d = meta?.DateTimeOriginal ?? meta?.CreateDate ?? meta?.ModifyDate
    if (d) {
      const date = d instanceof Date ? d : new Date(d)
      if (!isNaN(date.getTime())) takenAt = date.toISOString()
    }

    // GPS — from the dedicated helper, with bounds check.
    let lat: number | null = null
    let lng: number | null = null
    if (gps && typeof gps.latitude === 'number' && typeof gps.longitude === 'number'
        && isFinite(gps.latitude) && isFinite(gps.longitude)
        && gps.latitude >= -90 && gps.latitude <= 90
        && gps.longitude >= -180 && gps.longitude <= 180) {
      lat = gps.latitude
      lng = gps.longitude
    }

    // Altitude. GPSAltitudeRef = 1 means "below sea level" (negate the value).
    let altitude: number | null = null
    if (meta && typeof meta.GPSAltitude === 'number' && isFinite(meta.GPSAltitude)) {
      altitude = meta.GPSAltitudeRef === 1 ? -meta.GPSAltitude : meta.GPSAltitude
    }

    // Camera. Concat Make + Model, but if Model already starts with Make
    // (e.g. Make="NIKON CORPORATION", Model="NIKON D850") avoid duplication.
    let camera: string | null = null
    const make = (meta?.Make ?? '').trim()
    const model = (meta?.Model ?? '').trim()
    if (model.length > 0) {
      if (make.length > 0 && !model.toLowerCase().startsWith(make.toLowerCase())) {
        camera = `${make} ${model}`
      } else {
        camera = model
      }
    } else if (make.length > 0) {
      camera = make
    }
    if (camera) camera = camera.slice(0, 80)

    return { takenAt, lat, lng, altitude, camera }
  } catch {
    return { takenAt: null, lat: null, lng: null, altitude: null, camera: null }
  }
}

export interface ResizeResult {
  blob: Blob
  width: number
  height: number
  /** True when the input was already within the cap and we returned it
   *  (or a re-encoded version) without scaling. */
  unchanged: boolean
}

/** Decode the file via createImageBitmap with EXIF orientation honoured,
 *  draw to a canvas at most `maxLongEdge` on the longer dimension, and
 *  re-encode as JPEG. Without `imageOrientation: 'from-image'` the
 *  canvas re-encode would drop the orientation tag and portrait photos
 *  would render sideways. */
export async function resize(
  file: Blob,
  maxLongEdge: number = DEFAULT_MAX_LONG_EDGE,
  quality: number = DEFAULT_QUALITY,
): Promise<ResizeResult> {
  const bitmap = await decodeWithOrientation(file)
  const { width: w, height: h } = bitmap
  const longEdge = Math.max(w, h)

  // Even when the image is already small enough we still re-encode if a
  // rotation was applied — otherwise the original file's orientation tag
  // persists and downstream `<img>` rendering would double-rotate. Use
  // `unchanged: true` only when we can safely return the exact bytes.
  // For simplicity we always go through the canvas path when an EXIF
  // orientation transform may have happened (i.e. always, since we don't
  // know cheaply). Cost: tiny.
  const scale = longEdge > maxLongEdge ? maxLongEdge / longEdge : 1
  const targetW = Math.round(w * scale)
  const targetH = Math.round(h * scale)

  const canvas = document.createElement('canvas')
  canvas.width = targetW
  canvas.height = targetH
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Could not allocate canvas context')
  ctx.drawImage(bitmap, 0, 0, targetW, targetH)
  bitmap.close?.()

  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(b => b ? resolve(b) : reject(new Error('canvas.toBlob returned null')), 'image/jpeg', quality)
  })
  return { blob, width: targetW, height: targetH, unchanged: scale === 1 }
}

/** createImageBitmap with EXIF Orientation baked in. Falls back to a
 *  plain `<img>` decode (no rotation) on the unlikely browser that
 *  doesn't support imageOrientation — better to upload a sideways photo
 *  than fail the upload. */
async function decodeWithOrientation(file: Blob): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' } as ImageBitmapOptions)
  } catch {
    return await createImageBitmap(file)
  }
}

/** Apple-ecosystem files arrive as HEIC; Chrome/Firefox/Safari can decode
 *  HEIC inside `<img>` (Safari only) but not in canvas / createImageBitmap,
 *  which is what our resize step needs. heic2any wraps libheif (WASM) and
 *  produces a JPEG Blob we can run through the rest of the pipeline. */
export function isHeic(file: File | Blob): boolean {
  if ('name' in file && typeof file.name === 'string' && /\.hei[cf]$/i.test(file.name)) return true
  return /image\/hei[cf]/i.test(file.type)
}

async function convertHeicToJpeg(file: Blob): Promise<Blob> {
  // Lazy import: heic2any pulls in ~1 MB of libheif WASM; keep it out of
  // the initial bundle so JPEG-only flows aren't penalised.
  const mod = await import('heic2any')
  const result = await mod.default({ blob: file, toType: 'image/jpeg', quality: 0.92 })
  // Multi-frame HEICs return Blob[]; we only care about the primary frame.
  return Array.isArray(result) ? result[0] : result
}

/** Convenience: full pipeline — read EXIF metadata + (HEIC-decode if
 *  needed) + resize. EXIF reads from the ORIGINAL file (exifr supports
 *  HEIC natively); the canvas re-encode and heic2any conversion both
 *  drop the EXIF block, so you have to grab it before either runs. */
export async function prepareForUpload(
  file: File,
  maxLongEdge: number = DEFAULT_MAX_LONG_EDGE,
): Promise<{ blob: Blob } & PhotoMetadata> {
  if (isHeic(file)) {
    const [meta, converted] = await Promise.all([
      extractMetadata(file),
      convertHeicToJpeg(file),
    ])
    const resized = await resize(converted, maxLongEdge)
    return { blob: resized.blob, ...meta }
  }
  const [meta, resized] = await Promise.all([
    extractMetadata(file),
    resize(file, maxLongEdge),
  ])
  return { blob: resized.blob, ...meta }
}
