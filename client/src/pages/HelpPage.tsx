import { useNavigate } from 'react-router-dom'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { ArrowLeft } from 'lucide-react'
import guideMd from '../content/user-guide.md?raw' // [460-fork] synced from docs/ours-user-guide.md
import { useTranslation } from '../i18n'

// [460-fork] In-app User Guide. Renders the canonical guide markdown (bundled at
// build time, so it works offline) with the app's react-markdown + remark-gfm.
export default function HelpPage(): JSX.Element {
  const navigate = useNavigate()
  const { t } = useTranslation()
  const fontStyle = { fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', system-ui, sans-serif" }
  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg-primary)', ...fontStyle }}>
      <div style={{
        position: 'sticky', top: 0, zIndex: 10,
        display: 'flex', alignItems: 'center', gap: 12,
        padding: 'calc(env(safe-area-inset-top) + 10px) 16px 10px',
        background: 'var(--bg-elevated)', backdropFilter: 'blur(16px)', WebkitBackdropFilter: 'blur(16px)',
        borderBottom: '1px solid var(--border-faint)',
      }}>
        <button
          onClick={() => navigate(-1)}
          aria-label={t('common.back')}
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center', width: 36, height: 36,
            borderRadius: 18, border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--text-primary)',
          }}
        >
          <ArrowLeft size={20} />
        </button>
        <span style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-primary)' }}>{t('help.title')}</span>
      </div>

      <div className="guide-md" style={{
        maxWidth: 820, margin: '0 auto',
        padding: '20px 20px calc(48px + env(safe-area-inset-bottom))',
        color: 'var(--text-primary)', lineHeight: 1.6, fontSize: 15,
      }}>
        <style>{`
          .guide-md h1 { font-size: 26px; font-weight: 800; letter-spacing: -0.4px; margin: 8px 0 12px; }
          .guide-md h2 { font-size: 20px; font-weight: 700; margin: 28px 0 10px; padding-bottom: 4px; border-bottom: 1px solid var(--border-faint); }
          .guide-md h3 { font-size: 16px; font-weight: 700; margin: 20px 0 8px; }
          .guide-md p { margin: 10px 0; }
          .guide-md ul, .guide-md ol { margin: 10px 0; padding-left: 22px; }
          .guide-md li { margin: 5px 0; }
          .guide-md a { color: var(--accent); text-decoration: underline; word-break: break-word; }
          .guide-md strong { font-weight: 700; }
          .guide-md em { color: var(--text-muted); }
          .guide-md hr { border: none; border-top: 1px solid var(--border-faint); margin: 26px 0; }
          .guide-md blockquote { margin: 12px 0; padding: 10px 14px; border-left: 3px solid var(--accent);
            background: var(--bg-elevated); border-radius: 0 8px 8px 0; color: var(--text-secondary); }
          .guide-md blockquote p { margin: 4px 0; }
          .guide-md code { background: var(--bg-tertiary); padding: 1px 5px; border-radius: 4px; font-size: 13px; }
          .guide-md table { width: 100%; border-collapse: collapse; margin: 12px 0; font-size: 14px; display: block; overflow-x: auto; }
          .guide-md th, .guide-md td { border: 1px solid var(--border-primary); padding: 7px 10px; text-align: left; vertical-align: top; }
          .guide-md th { background: var(--bg-tertiary); font-weight: 700; }
        `}</style>
        <Markdown remarkPlugins={[remarkGfm]}>{guideMd}</Markdown>
      </div>
    </div>
  )
}
