// [460-fork] Milestone 13 — load the segments a trip is linked to, so booking
// and file rows can offer "share into segment" toggles. Best-effort: failures
// (offline, none linked) yield an empty list and the share UI simply hides.
import { useState, useEffect } from 'react'
import { segmentsApi, type SegmentSummaryForTrip } from '../../api/segments'

export function useTripSegments(tripId: number): SegmentSummaryForTrip[] {
  const [segments, setSegments] = useState<SegmentSummaryForTrip[]>([])
  useEffect(() => {
    let active = true
    segmentsApi.listForTrip(tripId)
      .then(d => { if (active) setSegments(d.segments || []) })
      .catch(() => { if (active) setSegments([]) })
    return () => { active = false }
  }, [tripId])
  return segments
}
