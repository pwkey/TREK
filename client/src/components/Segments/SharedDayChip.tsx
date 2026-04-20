// [460-fork] Shared segments (Milestone 4) — compact marker rendered on a
// day row in the planner when that day belongs to a shared segment.
import { Link2 } from 'lucide-react'

interface Props {
  title: string
  /** Optional: other-trip count so the tooltip can hint at reach. */
  linkedTripCount?: number
}

export default function SharedDayChip({ title, linkedTripCount }: Props) {
  const tooltip = linkedTripCount && linkedTripCount > 1
    ? `Shared with ${linkedTripCount - 1} other trip${linkedTripCount - 1 === 1 ? '' : 's'} · ${title}`
    : `Shared · ${title}`

  return (
    <span
      title={tooltip}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 4,
        padding: '1px 7px', borderRadius: 999,
        fontSize: 10, fontWeight: 600,
        background: 'rgba(16, 185, 129, 0.12)',
        color: '#0e7a5a',
        border: '1px solid rgba(16, 185, 129, 0.3)',
        whiteSpace: 'nowrap', maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis',
      }}
    >
      <Link2 size={9} strokeWidth={2.5} />
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{title}</span>
    </span>
  )
}
