import Section from './Section'
import React, { useEffect, useState } from 'react'
import { useTranslation } from '../../i18n'
import { useToast } from '../shared/Toast'
import { Trash2, Copy, Terminal, Plus, Check } from 'lucide-react'
import { authApi } from '../../api/client'
import { useAddonStore } from '../../store/addonStore'
import PhotoProvidersSection from './PhotoProvidersSection'


interface McpToken {
  id: number
  name: string
  token_prefix: string
  created_at: string
  last_used_at: string | null
}

export default function IntegrationsTab(): React.ReactElement {
  const { t, locale } = useTranslation()
  const toast = useToast()
  const { isEnabled: addonEnabled, loadAddons } = useAddonStore()
  const mcpEnabled = addonEnabled('mcp')

  useEffect(() => {
    loadAddons()
  }, [loadAddons])

  // MCP state
  const [mcpTokens, setMcpTokens] = useState<McpToken[]>([])
  const [mcpModalOpen, setMcpModalOpen] = useState(false)
  const [mcpNewName, setMcpNewName] = useState('')
  const [mcpCreatedToken, setMcpCreatedToken] = useState<string | null>(null)
  const [mcpCreating, setMcpCreating] = useState(false)
  const [mcpDeleteId, setMcpDeleteId] = useState<number | null>(null)
  const [copiedKey, setCopiedKey] = useState<string | null>(null)

  const mcpEndpoint = `${window.location.origin}/mcp`
  const mcpJsonConfig = `{
  "mcpServers": {
    "trek": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "${mcpEndpoint}",
        "--header",
        "Authorization: Bearer <your_token>"
      ]
    }
  }
}`

  useEffect(() => {
    if (mcpEnabled) {
      authApi.mcpTokens.list().then(d => setMcpTokens(d.tokens || [])).catch(() => {})
    }
  }, [mcpEnabled])

  const handleCreateMcpToken = async () => {
    if (!mcpNewName.trim()) return
    setMcpCreating(true)
    try {
      const d = await authApi.mcpTokens.create(mcpNewName.trim())
      setMcpCreatedToken(d.token.raw_token)
      setMcpNewName('')
      setMcpTokens(prev => [{ id: d.token.id, name: d.token.name, token_prefix: d.token.token_prefix, created_at: d.token.created_at, last_used_at: null }, ...prev])
    } catch {
      toast.error(t('settings.mcp.toast.createError'))
    } finally {
      setMcpCreating(false)
    }
  }

  const handleDeleteMcpToken = async (id: number) => {
    try {
      await authApi.mcpTokens.delete(id)
      setMcpTokens(prev => prev.filter(tk => tk.id !== id))
      setMcpDeleteId(null)
      toast.success(t('settings.mcp.toast.deleted'))
    } catch {
      toast.error(t('settings.mcp.toast.deleteError'))
    }
  }

  const handleCopy = (text: string, key: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopiedKey(key)
      setTimeout(() => setCopiedKey(null), 2000)
    })
  }

  return (
    <>
      <PhotoProvidersSection />
      {mcpEnabled && (
        <Section title={t('settings.mcp.title')} icon={Terminal}>
          {/* Endpoint URL */}
          <div>
            <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>{t('settings.mcp.endpoint')}</label>
            <div className="flex items-center gap-2">
              <code className="flex-1 px-3 py-2 rounded-lg text-sm font-mono border" style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border-primary)', color: 'var(--text-primary)' }}>
                {mcpEndpoint}
              </code>
              <button onClick={() => handleCopy(mcpEndpoint, 'endpoint')}
                className="p-2 rounded-lg border transition-colors hover:bg-slate-100 dark:hover:bg-slate-700"
                style={{ borderColor: 'var(--border-primary)' }} title={t('settings.mcp.copy')}>
                {copiedKey === 'endpoint' ? <Check className="w-4 h-4 text-green-500" /> : <Copy className="w-4 h-4" style={{ color: 'var(--text-secondary)' }} />}
              </button>
            </div>
          </div>

          {/* JSON config box */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="block text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>{t('settings.mcp.clientConfig')}</label>
              <button onClick={() => handleCopy(mcpJsonConfig, 'json')}
                className="flex items-center gap-1.5 px-2.5 py-1 rounded text-xs border transition-colors hover:bg-slate-100 dark:hover:bg-slate-700"
                style={{ borderColor: 'var(--border-primary)', color: 'var(--text-secondary)' }}>
                {copiedKey === 'json' ? <Check className="w-3 h-3 text-green-500" /> : <Copy className="w-3 h-3" />}
                {copiedKey === 'json' ? t('settings.mcp.copied') : t('settings.mcp.copy')}
              </button>
            </div>
            <pre className="p-3 rounded-lg text-xs font-mono overflow-x-auto border" style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border-primary)', color: 'var(--text-primary)' }}>
              {mcpJsonConfig}
            </pre>
            <p className="mt-1.5 text-xs" style={{ color: 'var(--text-tertiary)' }}>{t('settings.mcp.clientConfigHint')}</p>
          </div>

          {/* Token list */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>{t('settings.mcp.apiTokens')}</label>
              <button onClick={() => { setMcpModalOpen(true); setMcpCreatedToken(null); setMcpNewName('') }}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors"
                style={{ background: 'var(--accent-primary, #4f46e5)', color: '#fff' }}>
                <Plus className="w-3.5 h-3.5" /> {t('settings.mcp.createToken')}
              </button>
            </div>

            {mcpTokens.length === 0 ? (
              <p className="text-sm py-3 text-center rounded-lg border" style={{ color: 'var(--text-tertiary)', borderColor: 'var(--border-primary)' }}>
                {t('settings.mcp.noTokens')}
              </p>
            ) : (
              <div className="rounded-lg border overflow-hidden" style={{ borderColor: 'var(--border-primary)' }}>
                {mcpTokens.map((token, i) => (
                  <div key={token.id} className="flex items-center gap-3 px-4 py-3"
                    style={{ borderBottom: i < mcpTokens.length - 1 ? '1px solid var(--border-primary)' : undefined }}>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate" style={{ color: 'var(--text-primary)' }}>{token.name}</p>
                      <p className="text-xs font-mono mt-0.5" style={{ color: 'var(--text-tertiary)' }}>
                        {token.token_prefix}...
                        <span className="ml-3 font-sans">{t('settings.mcp.tokenCreatedAt')} {new Date(token.created_at).toLocaleDateString(locale)}</span>
                        {token.last_used_at && (
                          <span className="ml-2">· {t('settings.mcp.tokenUsedAt')} {new Date(token.last_used_at).toLocaleDateString(locale)}</span>
                        )}
                      </p>
                    </div>
                    <button onClick={() => setMcpDeleteId(token.id)}
                      className="p-1.5 rounded-lg transition-colors hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-900/20"
                      style={{ color: 'var(--text-tertiary)' }} title={t('settings.mcp.deleteTokenTitle')}>
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </Section>
      )}

      {/* Create MCP Token modal */}
      {mcpModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.5)' }}
          onClick={e => { if (e.target === e.currentTarget && !mcpCreatedToken) setMcpModalOpen(false) }}>
          <div className="rounded-xl shadow-xl w-full max-w-md p-6 space-y-4" style={{ background: 'var(--bg-card)' }}>
            {!mcpCreatedToken ? (
              <>
                <h3 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>{t('settings.mcp.modal.createTitle')}</h3>
                <div>
                  <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>{t('settings.mcp.modal.tokenName')}</label>
                  <input type="text" value={mcpNewName} onChange={e => setMcpNewName(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && handleCreateMcpToken()}
                    placeholder={t('settings.mcp.modal.tokenNamePlaceholder')}
                    className="w-full px-3 py-2.5 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300"
                    style={{ borderColor: 'var(--border-primary)', background: 'var(--bg-secondary)', color: 'var(--text-primary)' }}
                    autoFocus />
                </div>
                <div className="flex gap-2 justify-end pt-1">
                  <button onClick={() => setMcpModalOpen(false)}
                    className="px-4 py-2 rounded-lg text-sm border" style={{ borderColor: 'var(--border-primary)', color: 'var(--text-secondary)' }}>
                    {t('common.cancel')}
                  </button>
                  <button onClick={handleCreateMcpToken} disabled={!mcpNewName.trim() || mcpCreating}
                    className="px-4 py-2 rounded-lg text-sm font-medium text-white disabled:opacity-50"
                    style={{ background: 'var(--accent-primary, #4f46e5)' }}>
                    {mcpCreating ? t('settings.mcp.modal.creating') : t('settings.mcp.modal.create')}
                  </button>
                </div>
              </>
            ) : (
              <>
                <h3 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>{t('settings.mcp.modal.createdTitle')}</h3>
                <div className="flex items-start gap-2 p-3 rounded-lg border border-amber-200" style={{ background: 'rgba(251,191,36,0.1)' }}>
                  <span className="text-amber-500 mt-0.5">⚠</span>
                  <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>{t('settings.mcp.modal.createdWarning')}</p>
                </div>
                <div className="relative">
                  <pre className="p-3 pr-10 rounded-lg text-xs font-mono break-all border whitespace-pre-wrap" style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border-primary)', color: 'var(--text-primary)' }}>
                    {mcpCreatedToken}
                  </pre>
                  <button onClick={() => handleCopy(mcpCreatedToken, 'new-token')}
                    className="absolute top-2 right-2 p-1.5 rounded transition-colors hover:bg-slate-200 dark:hover:bg-slate-600"
                    style={{ color: 'var(--text-secondary)' }} title={t('settings.mcp.copy')}>
                    {copiedKey === 'new-token' ? <Check className="w-4 h-4 text-green-500" /> : <Copy className="w-4 h-4" />}
                  </button>
                </div>
                <div className="flex justify-end">
                  <button onClick={() => { setMcpModalOpen(false); setMcpCreatedToken(null) }}
                    className="px-4 py-2 rounded-lg text-sm font-medium text-white"
                    style={{ background: 'var(--accent-primary, #4f46e5)' }}>
                    {t('settings.mcp.modal.done')}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Delete MCP Token confirm */}
      {mcpDeleteId !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.5)' }}
          onClick={e => { if (e.target === e.currentTarget) setMcpDeleteId(null) }}>
          <div className="rounded-xl shadow-xl w-full max-w-sm p-6 space-y-4" style={{ background: 'var(--bg-card)' }}>
            <h3 className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>{t('settings.mcp.deleteTokenTitle')}</h3>
            <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>{t('settings.mcp.deleteTokenMessage')}</p>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setMcpDeleteId(null)}
                className="px-4 py-2 rounded-lg text-sm border" style={{ borderColor: 'var(--border-primary)', color: 'var(--text-secondary)' }}>
                {t('common.cancel')}
              </button>
              <button onClick={() => handleDeleteMcpToken(mcpDeleteId)}
                className="px-4 py-2 rounded-lg text-sm font-medium text-white bg-red-600 hover:bg-red-700">
                {t('settings.mcp.deleteTokenTitle')}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
