
// [460-fork] quick-jump — section-derivation logic (pure, node-testable).
import { describe, it, expect } from 'vitest'
import { deriveSections } from './sectionJump'
import type { Day, Assignment } from '../../types'

const day = (id: number, day_number: number, date: string, section_label?: string | null): Day =>
  ({ id, trip_id: 1, day_number, date, title: null, notes: null, assignments: [], notes_items: [], section_label } as Day)

const stay = (start_day_id: number, place_name: string): Assignment =>
  ({ start_day_id, place_name } as Assignment)

describe('deriveSections', () => {
  it('uses user-named sections when any exist', () => {
    const days = [day(1, 1, '2026-07-30'), day(2, 2, '2026-07-31', 'Morocco'), day(3, 3, '2026-08-11', 'Balkans')]
    const out = deriveSections(days, [stay(1, 'Some Hotel')])
    expect(out.map((s) => s.label)).toEqual(['Morocco', 'Balkans'])
    expect(out.every((s) => s.named)).toBe(true)
    expect(out[0].dayId).toBe(2)
  })

  it('falls back to accommodation stays when nothing is named', () => {
    const days = [day(1, 1, '2026-07-30'), day(2, 2, '2026-07-31'), day(3, 3, '2026-08-11')]
    const accs = [stay(3, 'Lake Bled'), stay(1, 'Moroccan House')] // out of order on purpose
    const out = deriveSections(days, accs)
    expect(out.map((s) => s.label)).toEqual(['Moroccan House', 'Lake Bled']) // sorted by day_number
    expect(out.every((s) => !s.named)).toBe(true)
  })

  it('dedupes a multi-night stay to a single entry', () => {
    const days = [day(1, 1, '2026-07-30'), day(2, 2, '2026-07-31')]
    const accs = [stay(1, 'Moroccan House'), stay(1, 'Moroccan House')]
    expect(deriveSections(days, accs)).toHaveLength(1)
  })

  it('ignores a blank/whitespace label (treated as unnamed)', () => {
    const days = [day(1, 1, '2026-07-30', '   '), day(2, 2, '2026-07-31')]
    const out = deriveSections(days, [stay(2, 'Hotel')])
    expect(out.map((s) => s.label)).toEqual(['Hotel']) // blank label didn't count as named
  })

  it('returns empty when there is nothing to jump to', () => {
    expect(deriveSections([day(1, 1, '2026-07-30')], [])).toEqual([])
  })
})
