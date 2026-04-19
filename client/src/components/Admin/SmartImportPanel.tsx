import { useEffect, useState } from 'react'
import { adminApi } from '../../api/client'
import { useToast } from '../shared/Toast'
import { useTranslation } from '../../i18n'
import { Check, Upload } from 'lucide-react'
import { getApiErrorMessage } from '../../types'

type Provider = 'disabled' | 'ollama' | 'anthropic' | 'openai'

interface ImportSettings {
  provider: Provider
  ollama_url: string
  ollama_model: string
  anthropic_model: string
  openai_model: string
  anthropic_key_set: boolean
  openai_key_set: boolean
  ocr_enabled: boolean
}

const PROVIDER_OPTIONS: Array<{ value: Provider; label: string; hint: string }> = [
  { value: 'disabled', label: 'Disabled', hint: 'Smart Import is off.' },
  { value: 'ollama', label: 'Ollama (local)', hint: 'Runs on your machine. Privacy-preserving. Free. Requires Ollama installed.' },
  { value: 'anthropic', label: 'Anthropic API', hint: 'Cloud API. Fast and accurate. Booking data leaves your server.' },
  { value: 'openai', label: 'OpenAI API', hint: 'Cloud API. Fast and accurate. Booking data leaves your server.' },
]

const emptySettings: ImportSettings = {
  provider: 'disabled',
  ollama_url: 'http://localhost:11434',
  ollama_model: 'llama3.1:8b',
  anthropic_model: 'claude-sonnet-4-5',
  openai_model: 'gpt-4o-mini',
  anthropic_key_set: false,
  openai_key_set: false,
  ocr_enabled: false,
}

export default function SmartImportPanel() {
  const { t } = useTranslation()
  const toast = useToast()
  const [settings, setSettings] = useState<ImportSettings>(emptySettings)
  const [anthropicKey, setAnthropicKey] = useState('')
  const [openaiKey, setOpenaiKey] = useState('')
  const [dirty, setDirty] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  const load = async () => {
    setLoading(true)
    try {
      const data = (await adminApi.getImportSettings()) as ImportSettings
      setSettings(data)
      setAnthropicKey('')
      setOpenaiKey('')
      setDirty(false)
    } catch (err: unknown) {
      toast.error(getApiErrorMessage(err, 'Failed to load import settings'))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const update = <K extends keyof ImportSettings>(key: K, value: ImportSettings[K]) => {
    setSettings(prev => ({ ...prev, [key]: value }))
    setDirty(true)
  }

  const save = async () => {
    setSaving(true)
    try {
      const payload: Record<string, unknown> = {
        provider: settings.provider,
        ollama_url: settings.ollama_url,
        ollama_model: settings.ollama_model,
        anthropic_model: settings.anthropic_model,
        openai_model: settings.openai_model,
        ocr_enabled: settings.ocr_enabled,
      }
      if (anthropicKey.length > 0) payload.anthropic_key = anthropicKey
      if (openaiKey.length > 0) payload.openai_key = openaiKey
      const data = (await adminApi.updateImportSettings(payload)) as ImportSettings
      setSettings(data)
      setAnthropicKey('')
      setOpenaiKey('')
      setDirty(false)
      toast.success('Import settings saved')
    } catch (err: unknown) {
      toast.error(getApiErrorMessage(err, 'Failed to save import settings'))
    } finally {
      setSaving(false)
    }
  }

  const clearKey = async (which: 'anthropic' | 'openai') => {
    setSaving(true)
    try {
      const data = (await adminApi.updateImportSettings({ [`${which}_key`]: null })) as ImportSettings
      setSettings(data)
      toast.success('API key cleared')
    } catch (err: unknown) {
      toast.error(getApiErrorMessage(err, 'Failed to clear key'))
    } finally {
      setSaving(false)
    }
  }

  const activeProvider = PROVIDER_OPTIONS.find(p => p.value === settings.provider)

  return (
    <div className="flex flex-col gap-6">
      <div className="bg-white rounded-2xl border border-gray-200 p-6">
        <div className="flex items-center gap-3 mb-6">
          <Upload className="w-5 h-5 text-gray-400" />
          <div>
            <h2 className="font-semibold" style={{ color: 'var(--text-primary)' }}>Smart Import</h2>
            <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
              Extract reservation details from booking PDFs and emails using a local or cloud LLM.
            </p>
          </div>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-12 text-gray-400">
            <div className="w-6 h-6 border-2 border-gray-300 border-t-slate-700 rounded-full animate-spin mr-2" />
            {t('common.loading')}
          </div>
        ) : (
          <div className="flex flex-col gap-5">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Provider</label>
              <div className="flex flex-wrap gap-2">
                {PROVIDER_OPTIONS.map(opt => (
                  <button
                    key={opt.value}
                    onClick={() => update('provider', opt.value)}
                    className={`px-4 py-2 rounded-lg text-sm font-medium border transition-colors ${
                      settings.provider === opt.value
                        ? 'bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 border-slate-700'
                        : 'bg-white text-gray-600 border-gray-200 hover:border-gray-300'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
              {activeProvider && (
                <p className="text-xs text-gray-500 mt-2">{activeProvider.hint}</p>
              )}
            </div>

            {settings.provider === 'ollama' && (
              <div className="flex flex-col gap-3 p-4 rounded-lg border border-gray-100 bg-gray-50">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Ollama base URL</label>
                  <input
                    type="text"
                    value={settings.ollama_url}
                    onChange={e => update('ollama_url', e.target.value)}
                    placeholder="http://localhost:11434"
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white"
                  />
                  <p className="text-xs text-gray-400 mt-1">
                    Where Ollama is listening. Default is localhost. Change if running on a LAN host.
                  </p>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Model</label>
                  <input
                    type="text"
                    value={settings.ollama_model}
                    onChange={e => update('ollama_model', e.target.value)}
                    placeholder="llama3.1:8b"
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white"
                  />
                  <p className="text-xs text-gray-400 mt-1">
                    Pull the model first with <code>ollama pull {settings.ollama_model}</code>.
                  </p>
                </div>
              </div>
            )}

            {settings.provider === 'anthropic' && (
              <div className="flex flex-col gap-3 p-4 rounded-lg border border-gray-100 bg-gray-50">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Anthropic API key</label>
                  <div className="flex gap-2">
                    <input
                      type="password"
                      value={anthropicKey}
                      onChange={e => { setAnthropicKey(e.target.value); setDirty(true) }}
                      placeholder={settings.anthropic_key_set ? '•••••••• (set — leave blank to keep)' : 'sk-ant-...'}
                      className="flex-1 px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white"
                    />
                    {settings.anthropic_key_set && (
                      <button
                        onClick={() => clearKey('anthropic')}
                        disabled={saving}
                        className="px-3 py-2 text-xs text-red-600 border border-red-200 rounded-lg hover:bg-red-50 disabled:opacity-60"
                      >
                        Clear
                      </button>
                    )}
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Model</label>
                  <input
                    type="text"
                    value={settings.anthropic_model}
                    onChange={e => update('anthropic_model', e.target.value)}
                    placeholder="claude-sonnet-4-5"
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white"
                  />
                </div>
                <p className="text-xs text-amber-700 bg-amber-50 border border-amber-100 rounded-lg p-3">
                  Adapter not yet implemented (Milestone 2, slice 5). Key is stored encrypted; selecting this provider before the adapter ships will return an error on extract.
                </p>
              </div>
            )}

            {settings.provider === 'openai' && (
              <div className="flex flex-col gap-3 p-4 rounded-lg border border-gray-100 bg-gray-50">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">OpenAI API key</label>
                  <div className="flex gap-2">
                    <input
                      type="password"
                      value={openaiKey}
                      onChange={e => { setOpenaiKey(e.target.value); setDirty(true) }}
                      placeholder={settings.openai_key_set ? '•••••••• (set — leave blank to keep)' : 'sk-...'}
                      className="flex-1 px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white"
                    />
                    {settings.openai_key_set && (
                      <button
                        onClick={() => clearKey('openai')}
                        disabled={saving}
                        className="px-3 py-2 text-xs text-red-600 border border-red-200 rounded-lg hover:bg-red-50 disabled:opacity-60"
                      >
                        Clear
                      </button>
                    )}
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Model</label>
                  <input
                    type="text"
                    value={settings.openai_model}
                    onChange={e => update('openai_model', e.target.value)}
                    placeholder="gpt-4o-mini"
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white"
                  />
                </div>
                <p className="text-xs text-amber-700 bg-amber-50 border border-amber-100 rounded-lg p-3">
                  Adapter not yet implemented (Milestone 2, slice 5). Key is stored encrypted; selecting this provider before the adapter ships will return an error on extract.
                </p>
              </div>
            )}

            <label className="flex items-center justify-between gap-4 cursor-pointer pt-2 border-t border-gray-100">
              <div className="min-w-0">
                <span className="text-sm font-medium text-gray-900">OCR fallback</span>
                <p className="text-xs text-gray-500 mt-0.5">Run Tesseract on image-only PDFs. Slower. Disabled by default.</p>
              </div>
              <button
                onClick={() => update('ocr_enabled', !settings.ocr_enabled)}
                className="relative shrink-0 inline-flex h-6 w-11 items-center rounded-full transition-colors"
                style={{ background: settings.ocr_enabled ? 'var(--text-primary)' : 'var(--border-primary)' }}
              >
                <span className="absolute left-0.5 h-5 w-5 rounded-full bg-white transition-transform duration-200"
                  style={{ transform: settings.ocr_enabled ? 'translateX(20px)' : 'translateX(0)' }} />
              </button>
            </label>

            <div className="flex justify-end pt-2 border-t border-gray-100">
              <button
                onClick={save}
                disabled={saving || !dirty}
                className="flex items-center gap-2 bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 px-5 py-2 rounded-lg hover:bg-slate-900 text-sm font-medium disabled:opacity-50 transition-colors"
              >
                {saving
                  ? <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  : <Check className="w-4 h-4" />
                }
                {saving ? t('common.saving') : t('common.save')}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
