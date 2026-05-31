// [460-fork] Q6 — Warning dialog shown when a single-photo upload's
// EXIF date doesn't match the target day's date. See
// utils/photoTimestampCheck.ts for the conditions that trigger it.
//
// Three actions:
//   1. Add to {selectedDay} anyway — proceed with the upload as the
//      user requested
//   2. Use photo's date — only shown when a day in the trip matches
//      the photo's EXIF date; uploads to that day instead
//   3. Cancel — abort the upload
import React from 'react'
import { AlertTriangle, Calendar, Camera, X } from 'lucide-react'
import Modal from '../shared/Modal'
import type { Day } from '../../types'

interface PhotoTimestampWarningProps {
  isOpen: boolean
  photoDate: string
  targetDay: Day
  matchingDay: Day | null
  /** Optional thumbnail data URL for the file being uploaded. */
  thumbnail?: string | null
  onAddAnyway: () => void
  /** Only called when matchingDay is set. */
  onUsePhotoDate: () => void
  onCancel: () => void
}

function formatDayLabel(day: Day): string {
  if (day.title && day.title.trim()) return `${day.title} (${day.date})`
  return day.date || `Day ${day.id}`
}

export default function PhotoTimestampWarning({
  isOpen, photoDate, targetDay, matchingDay, thumbnail,
  onAddAnyway, onUsePhotoDate, onCancel,
}: PhotoTimestampWarningProps) {
  return (
    <Modal isOpen={isOpen} onClose={onCancel} title="Photo date doesn't match day" size="md" hideCloseButton>
      <div className="space-y-4">
        <div className="flex items-start gap-3 p-3 rounded-lg" style={{ background: 'var(--bg-warning, #fef3c7)', color: 'var(--text-warning, #92400e)' }}>
          <AlertTriangle size={18} className="shrink-0 mt-0.5" />
          <div className="text-sm">
            <div className="font-medium mb-1">This photo's date doesn't match the day you're adding it to.</div>
            <div className="opacity-90">
              You can still add it to the selected day, route it to the day in this trip whose date matches, or cancel.
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
          <div className="flex items-center gap-2 p-3 rounded-lg" style={{ background: 'var(--bg-tertiary)' }}>
            <Camera size={16} className="shrink-0" style={{ color: 'var(--text-faint)' }} />
            <div className="min-w-0">
              <div className="text-xs uppercase tracking-wide" style={{ color: 'var(--text-faint)' }}>Photo taken</div>
              <div className="font-medium truncate" style={{ color: 'var(--text-primary)' }}>{photoDate}</div>
            </div>
          </div>
          <div className="flex items-center gap-2 p-3 rounded-lg" style={{ background: 'var(--bg-tertiary)' }}>
            <Calendar size={16} className="shrink-0" style={{ color: 'var(--text-faint)' }} />
            <div className="min-w-0">
              <div className="text-xs uppercase tracking-wide" style={{ color: 'var(--text-faint)' }}>Selected day</div>
              <div className="font-medium truncate" style={{ color: 'var(--text-primary)' }}>{formatDayLabel(targetDay)}</div>
            </div>
          </div>
        </div>

        {thumbnail && (
          <div className="flex justify-center">
            <img src={thumbnail} alt="" style={{ maxHeight: 140, maxWidth: '100%', borderRadius: 8, border: '1px solid var(--border-faint)' }} />
          </div>
        )}

        <div className="flex flex-col gap-2 pt-2">
          <button
            type="button"
            onClick={onAddAnyway}
            className="px-4 py-2 rounded-lg text-sm font-medium text-left"
            style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)', border: '1px solid var(--border-primary)' }}
          >
            <div className="font-medium">Add to selected day anyway</div>
            <div className="text-xs mt-0.5" style={{ color: 'var(--text-faint)' }}>
              Upload to {formatDayLabel(targetDay)}
            </div>
          </button>

          {matchingDay && (
            <button
              type="button"
              onClick={onUsePhotoDate}
              className="px-4 py-2 rounded-lg text-sm font-medium text-left"
              style={{ background: 'var(--accent)', color: 'var(--accent-text)', border: '1px solid var(--accent)' }}
            >
              <div className="font-medium">Use photo's date</div>
              <div className="text-xs mt-0.5 opacity-90">
                Upload to {formatDayLabel(matchingDay)} instead
              </div>
            </button>
          )}

          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-2 rounded-lg text-sm font-medium flex items-center justify-center gap-2"
            style={{ background: 'transparent', color: 'var(--text-faint)', border: '1px solid var(--border-faint)' }}
          >
            <X size={14} /> Cancel
          </button>
        </div>
      </div>
    </Modal>
  )
}
