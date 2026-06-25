import React from 'react'
import { AlertTriangle } from 'lucide-react'
import { useTranslation } from '../../i18n'

// [460-fork] App-level error boundary.
//
// A render-time exception in any page used to unmount the entire React tree and
// leave a blank white screen with nothing but a console error — observed when
// PlacesSidebar was handed an `undefined` days prop and called `days.forEach`.
// This catches such errors and shows a recoverable fallback (reload / back to
// dashboard) instead. No telemetry — the stack is logged to the console only,
// in keeping with CLAUDE.md's "no analytics/external calls" rule.

interface ErrorBoundaryProps {
  children: React.ReactNode
  // When this value changes (we pass the route path), a previously-caught error
  // is cleared so navigating away from a broken screen recovers without a hard
  // reload — e.g. the browser back button just works.
  resetKey?: string
}

interface ErrorBoundaryState {
  error: Error | null
}

const fontStyle = {
  fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', system-ui, sans-serif",
}

function ErrorFallback({ error }: { error: Error }): React.ReactElement {
  const { t } = useTranslation()
  return (
    <div
      role="alert"
      style={{
        minHeight: '100vh', display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center',
        padding: '24px calc(24px + env(safe-area-inset-right)) 24px calc(24px + env(safe-area-inset-left))',
        textAlign: 'center', background: 'var(--bg-primary)', ...fontStyle,
      }}
    >
      <div style={{ color: 'var(--text-muted)', marginBottom: 20 }}>
        <AlertTriangle size={44} strokeWidth={1.75} aria-hidden />
      </div>
      <h1 style={{ fontSize: 20, fontWeight: 700, color: 'var(--text-primary)', letterSpacing: '-0.3px', margin: '0 0 8px' }}>
        {t('errorBoundary.title')}
      </h1>
      <p style={{ fontSize: 14, lineHeight: 1.5, color: 'var(--text-muted)', maxWidth: 380, margin: '0 0 24px' }}>
        {t('errorBoundary.message')}
      </p>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', justifyContent: 'center' }}>
        <button
          onClick={() => window.location.reload()}
          style={{
            minHeight: 44, padding: '0 22px', borderRadius: 22, border: 'none', cursor: 'pointer',
            fontSize: 14, fontWeight: 600, fontFamily: 'inherit',
            background: 'var(--accent)', color: 'var(--accent-text)',
          }}
        >
          {t('errorBoundary.reload')}
        </button>
        <button
          onClick={() => window.location.assign('/dashboard')}
          style={{
            minHeight: 44, padding: '0 22px', borderRadius: 22, cursor: 'pointer',
            fontSize: 14, fontWeight: 600, fontFamily: 'inherit',
            background: 'transparent', color: 'var(--text-primary)', border: '1px solid var(--border-primary)',
          }}
        >
          {t('errorBoundary.back')}
        </button>
      </div>
      {error.message && (
        <details style={{ marginTop: 28, maxWidth: 480, width: '100%' }}>
          <summary style={{ fontSize: 12, color: 'var(--text-faint)', cursor: 'pointer', letterSpacing: '0.3px' }}>
            {t('errorBoundary.details')}
          </summary>
          <pre style={{
            marginTop: 10, padding: 12, textAlign: 'left', overflowX: 'auto',
            fontSize: 12, lineHeight: 1.45, color: 'var(--text-muted)',
            background: 'var(--bg-elevated)', border: '1px solid var(--border-faint)', borderRadius: 8,
            whiteSpace: 'pre-wrap', wordBreak: 'break-word',
          }}>
            {error.message}
          </pre>
        </details>
      )}
    </div>
  )
}

export default class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error('[460] Uncaught render error:', error, info.componentStack)
  }

  componentDidUpdate(prevProps: ErrorBoundaryProps): void {
    if (this.state.error && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ error: null })
    }
  }

  render(): React.ReactNode {
    if (this.state.error) {
      return <ErrorFallback error={this.state.error} />
    }
    return this.props.children
  }
}
