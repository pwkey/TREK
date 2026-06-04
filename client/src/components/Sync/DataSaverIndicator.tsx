// [460-fork] Milestone 14 slice 1 — navbar Data-saver chip.
//
// Shown only while Data-saver is effectively active (so it's never silently
// throttling). Clicking deep-links to Settings → Display where the mode lives.
// On iOS there's no way to detect the connection, so this chip is the user's
// only signal that large transfers are being held back.
import { useNavigate } from 'react-router-dom'
import { Gauge } from 'lucide-react'
import { useDataSaverActive } from '../../store/dataSaverStore'
import { useTranslation } from '../../i18n'

export default function DataSaverIndicator() {
  const active = useDataSaverActive()
  const navigate = useNavigate()
  const { t } = useTranslation()

  if (!active) return null

  const label = t('dataSaver.chip') || 'Data saver'
  return (
    <div
      title={t('dataSaver.chipTooltip') || 'Data saver is on — large uploads/downloads wait for Wi-Fi. Tap to change.'}
      aria-label={label}
      role="button"
      onClick={() => navigate('/settings?tab=display')}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 5,
        padding: '4px 9px', borderRadius: 999,
        fontSize: 11, fontWeight: 600,
        color: '#a16207',
        background: 'rgba(245, 158, 11, 0.15)',
        border: '1px solid rgba(245, 158, 11, 0.35)',
        cursor: 'pointer', userSelect: 'none',
      }}
    >
      <Gauge size={12} strokeWidth={2.2} />
      {label}
    </div>
  )
}
