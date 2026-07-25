// [460-fork] quick-jump — pure section-derivation logic, kept import-light
// (types only) so it runs under the node test environment. The component
// (SectionJumpMenu.tsx) renders these.
import type { Day, Assignment } from '../../types'

export interface Section {
  dayId: number
  label: string
  date: string | null
  /** true when it came from a user-set label (vs auto-derived). */
  named: boolean
}

/**
 * Hybrid source: the trip's user-named sections (days with a `section_label`)
 * if any exist, otherwise one entry per accommodation stay so the menu is
 * useful before anything has been named.
 */
export function deriveSections(days: Day[], accommodations: Assignment[]): Section[] {
  const named = days
    .filter((d) => d.section_label && d.section_label.trim())
    .map((d) => ({ dayId: d.id, label: d.section_label!.trim(), date: d.date, named: true }))
  if (named.length) return named

  const dayById = new Map(days.map((d) => [d.id, d]))
  const out: Section[] = []
  const seen = new Set<number>()
  const stays = accommodations
    .filter((a) => a.start_day_id != null && dayById.has(a.start_day_id))
    .sort((a, b) => dayById.get(a.start_day_id!)!.day_number - dayById.get(b.start_day_id!)!.day_number)
  for (const a of stays) {
    if (seen.has(a.start_day_id!)) continue
    seen.add(a.start_day_id!)
    const d = dayById.get(a.start_day_id!)!
    out.push({ dayId: d.id, label: a.place_name || 'Stay', date: d.date, named: false })
  }
  return out
}
