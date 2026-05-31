// [460-fork] Q6 — EXIF-timestamp check for single-photo uploads.
//
// When the user uploads a photo from the day-detail panel or the
// day-header camera button (Q5), we compare the photo's EXIF taken_at
// to the target day's date. If they don't match, the upload path
// surfaces a warning dialog with three actions (covered in
// components/Photos/PhotoTimestampWarning.tsx):
//
//   1. Add to {selectedDay} anyway
//   2. Use photo's date → uploads to the day in the trip whose
//      date matches the EXIF taken_at (only offered when such a day
//      exists)
//   3. Cancel
//
// The check is bypassed silently when:
//   - the photo has no EXIF taken_at (nothing to compare)
//   - the EXIF date matches the selected day's date
//   - the user has disabled "Warn when photo date doesn't match day"
//     in Settings → Display (Settings.check_photo_timestamp)
//
// Batch uploads (multiple files in one drop) skip the check too —
// the batch-import flow already does smart day-by-EXIF matching with
// per-row overrides, so re-prompting per file would be duplicative.

import { extractMetadata } from '../lib/imageProcessing'
import type { Day } from '../types'

/**
 * Extracts a YYYY-MM-DD calendar date from the EXIF `taken_at` of a file.
 * Returns null if no EXIF date exists or extraction fails.
 *
 * Uses the existing extractMetadata() in lib/imageProcessing, which
 * the dayPhotosSlice.uploadDayPhoto path also uses — so the date we
 * compare against here is the same date the server stores.
 */
export async function getPhotoExifDate(file: File): Promise<string | null> {
  try {
    const meta = await extractMetadata(file)
    if (!meta.takenAt) return null
    // takenAt is ISO 8601 (e.g. "2026-07-15T09:15:00.000Z"). Reduce
    // to YYYY-MM-DD using the photo's local time-of-day rather than
    // UTC — a photo taken at 11pm Sydney time should match Sydney's
    // current day, not the next UTC day.
    const d = new Date(meta.takenAt)
    if (isNaN(d.getTime())) return null
    const year = d.getFullYear()
    const month = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    return `${year}-${month}-${day}`
  } catch {
    return null
  }
}

/**
 * Finds the day in the current trip whose `date` field equals the
 * given EXIF date string (YYYY-MM-DD). Returns null if no such day
 * exists (i.e. the photo was taken outside the trip's date range).
 */
export function findDayByDate(days: Day[], exifDate: string): Day | null {
  return days.find(d => d.date === exifDate) ?? null
}

export interface PhotoTimestampCheck {
  /** True if the warning dialog should be shown for this file. */
  shouldWarn: boolean
  /** The photo's EXIF calendar date (YYYY-MM-DD), if any. */
  photoDate: string | null
  /** The day in the trip whose date matches the photo's EXIF date, if any. */
  matchingDay: Day | null
}

/**
 * Determines whether a single-photo upload to `targetDayId` should
 * trigger the timestamp warning dialog. Encapsulates all the "skip
 * silently" cases so callers just branch on `shouldWarn`.
 */
export async function checkPhotoTimestamp(
  file: File,
  targetDayId: number,
  days: Day[],
  enabled: boolean,
): Promise<PhotoTimestampCheck> {
  if (!enabled) return { shouldWarn: false, photoDate: null, matchingDay: null }
  const targetDay = days.find(d => d.id === targetDayId)
  if (!targetDay?.date) return { shouldWarn: false, photoDate: null, matchingDay: null }
  const photoDate = await getPhotoExifDate(file)
  if (!photoDate) return { shouldWarn: false, photoDate: null, matchingDay: null }
  if (photoDate === targetDay.date) return { shouldWarn: false, photoDate, matchingDay: null }
  const matchingDay = findDayByDate(days, photoDate)
  return { shouldWarn: true, photoDate, matchingDay }
}
