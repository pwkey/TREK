// [460-fork] Milestone 14 slice 2 — data-cost confirmation dialog.
//
// A single instance lives at the app root and renders whatever request
// confirmDataCost() has parked in the store. Kept separate from the logic
// module so that (a) the logic stays unit-testable under the node env and
// (b) the i18n/React import chain only loads in the app, not in tests.
import { Gauge } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { useDataCostStore, formatBytes } from './dataCostConfirm'

export function DataCostConfirmHost() {
  const req = useDataCostStore((s) => s.req)
  const setReq = useDataCostStore((s) => s.set)
  const { t } = useTranslation()

  if (!req) return null

  const done = (proceed: boolean) => {
    req.resolve(proceed)
    setReq(null)
  }

  const opName = t(`dataCost.op.${req.opKey}`) || req.opKey
  const size = formatBytes(req.bytes)
  const hasSize = size !== ''
  const messageKey = hasSize
    ? (req.active ? 'dataCost.messageSaver' : 'dataCost.message')
    : (req.active ? 'dataCost.messageUnknownSaver' : 'dataCost.messageUnknown')
  const message = t(messageKey, hasSize ? { op: opName, size } : { op: opName })

  // When Data-saver is active the safe choice (wait) is the emphasised button;
  // otherwise "Continue" leads.
  const primaryLabel = req.active
    ? (t('dataCost.waitWifi') || 'Wait for Wi-Fi')
    : (t('dataCost.continue') || 'Continue')
  const secondaryLabel = req.active
    ? (t('dataCost.continueAnyway') || 'Continue anyway')
    : (t('common.cancel') || 'Cancel')
  const onPrimary = () => done(!req.active) // active → wait (false); inactive → continue (true)
  const onSecondary = () => done(req.active) // active → continue (true); inactive → cancel (false)

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center px-4"
      style={{ backgroundColor: 'rgba(15, 23, 42, 0.5)' }}
      onClick={() => done(false)}
    >
      <div
        className="rounded-2xl shadow-2xl w-full max-w-sm p-6"
        style={{ animation: 'modalIn 0.2s ease-out forwards', background: 'var(--bg-card)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-4">
          <div
            className="flex-shrink-0 w-10 h-10 rounded-full flex items-center justify-center"
            style={{ background: 'rgba(245, 158, 11, 0.15)' }}
          >
            <Gauge className="w-5 h-5" style={{ color: '#a16207' }} />
          </div>
          <div className="flex-1">
            <h3 className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>
              {t('dataCost.title') || 'Heads up — data usage'}
            </h3>
            <p className="mt-1 text-sm" style={{ color: 'var(--text-secondary)' }}>
              {message}
            </p>
          </div>
        </div>

        <div className="flex justify-end gap-3 mt-6">
          <button
            onClick={onSecondary}
            className="px-4 py-2 text-sm font-medium rounded-lg transition-colors"
            style={{ color: 'var(--text-secondary)', border: '1px solid var(--border-secondary)' }}
          >
            {secondaryLabel}
          </button>
          <button
            onClick={onPrimary}
            className="px-4 py-2 text-sm font-medium rounded-lg transition-colors text-white bg-blue-600 hover:bg-blue-700"
          >
            {primaryLabel}
          </button>
        </div>
      </div>

      <style>{`
        @keyframes modalIn {
          from { opacity: 0; transform: scale(0.95) translateY(-10px); }
          to { opacity: 1; transform: scale(1) translateY(0); }
        }
      `}</style>
    </div>
  )
}
