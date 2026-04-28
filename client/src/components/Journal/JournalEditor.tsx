// [460-fork] Milestone 6 slice 1 — journal markdown editor for the day-detail panel.
//
// Toggle between Write (textarea) and Preview (react-markdown). The store
// owns the canonical content via journalSlice; this component is a thin
// view + debounced-save shell. Saves are queueable through the M5 mutation
// queue, so offline edits land in IndexedDB and replay on reconnect.
import { useEffect, useRef, useState } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Pencil, Eye, BookOpen, Loader2, Mic, MicOff } from 'lucide-react'
import { useTripStore } from '../../store/tripStore'

// [460-fork] Milestone 6 slice 1 — speech-to-text via the browser's
// SpeechRecognition API. Chrome/Edge/Safari support it natively (Firefox
// doesn't, so the mic button is hidden when the API is missing). On
// Capacitor (M1) we'll swap to @capacitor-community/speech-recognition
// behind the same UI; the rest of the journal save path is unchanged.
type SR = {
  start: () => void
  stop: () => void
  abort: () => void
  continuous: boolean
  interimResults: boolean
  lang: string
  onresult: ((e: SREvent) => void) | null
  onerror: ((e: { error: string }) => void) | null
  onend: (() => void) | null
}
type SREvent = {
  resultIndex: number
  results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>
}
function getSpeechRecognitionCtor(): { new (): SR } | null {
  if (typeof window === 'undefined') return null
  const w = window as unknown as { SpeechRecognition?: { new (): SR }; webkitSpeechRecognition?: { new (): SR } }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

interface JournalEditorProps {
  tripId: number | string
  dayId: number
}

const SAVE_DEBOUNCE_MS = 800

export default function JournalEditor({ tripId, dayId }: JournalEditorProps) {
  const journal = useTripStore(s => s.dayJournals[String(dayId)] ?? null)
  const loadJournal = useTripStore(s => s.loadJournal)
  const updateJournal = useTripStore(s => s.updateJournal)

  const [mode, setMode] = useState<'write' | 'preview'>('write')
  const [draft, setDraft] = useState<string>(journal?.content_markdown ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const lastSavedRef = useRef<string>(journal?.content_markdown ?? '')
  const debounceRef = useRef<number | null>(null)
  // Mirror `draft` so the unmount cleanup reads the LATEST value, not the
  // value captured at first render. Without this, closing the day-detail
  // panel right after typing would save the stale (empty) initial draft.
  const draftRef = useRef<string>(draft)
  useEffect(() => { draftRef.current = draft }, [draft])

  // Speech-to-text. Held in a ref so the recognition instance survives
  // re-renders; `listening` mirrors its state for the UI.
  const recognitionRef = useRef<SR | null>(null)
  const [listening, setListening] = useState(false)
  const speechSupported = getSpeechRecognitionCtor() !== null

  // Pull the journal from the server on mount. Slice's optimistic state
  // means subsequent broadcasts (or our own writes) keep this in sync.
  useEffect(() => {
    void loadJournal(tripId, dayId)
  }, [tripId, dayId, loadJournal])

  // Re-sync the local draft when the canonical store value changes from
  // outside (e.g. WS broadcast from another tab). Skip if the change is
  // just our own optimistic write echoing back.
  useEffect(() => {
    const canonical = journal?.content_markdown ?? ''
    if (canonical !== lastSavedRef.current && canonical !== draft) {
      setDraft(canonical)
      lastSavedRef.current = canonical
    }
  }, [journal?.content_markdown]) // eslint-disable-line react-hooks/exhaustive-deps

  const flush = async (value: string) => {
    if (value === lastSavedRef.current) return
    setSaving(true)
    setError(null)
    try {
      await updateJournal(tripId, dayId, value)
      lastSavedRef.current = value
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not save journal')
    } finally {
      setSaving(false)
    }
  }

  const onChange = (value: string) => {
    setDraft(value)
    if (debounceRef.current !== null) window.clearTimeout(debounceRef.current)
    debounceRef.current = window.setTimeout(() => {
      // Clear the pending marker BEFORE awaiting flush — otherwise the
      // unmount cleanup below would see a non-null debounceRef and double-
      // flush stale content over what we just saved.
      debounceRef.current = null
      void flush(value)
    }, SAVE_DEBOUNCE_MS)
  }

  // Flush on unmount only if a debounce is genuinely pending. Reads the
  // latest draft via draftRef — closing the panel mid-typing must not
  // overwrite the server with the stale closure value from first render.
  useEffect(() => () => {
    if (debounceRef.current !== null) {
      window.clearTimeout(debounceRef.current)
      debounceRef.current = null
      void flush(draftRef.current)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const switchMode = (next: 'write' | 'preview') => {
    if (next === 'preview' && draft !== lastSavedRef.current) {
      void flush(draft)
    }
    setMode(next)
  }

  const startListening = () => {
    const Ctor = getSpeechRecognitionCtor()
    if (!Ctor) return
    if (recognitionRef.current) {
      try { recognitionRef.current.abort() } catch { /* ignore */ }
    }
    const rec = new Ctor()
    rec.continuous = true
    rec.interimResults = true
    rec.lang = navigator.language || 'en-US'

    // Anchor at the end of the current draft. Final transcripts append
    // permanently; interim transcripts render as a live tail and get
    // replaced as recognition firms up the words.
    let baseAtStart = draftRef.current
    let finalSoFar = ''

    rec.onresult = (e) => {
      let interim = ''
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i]
        const txt = r[0].transcript
        if (r.isFinal) finalSoFar += txt
        else interim += txt
      }
      // Reconstruct: base + (separator if needed) + finalSoFar + interim.
      const sep = baseAtStart.length > 0 && !baseAtStart.endsWith(' ') && !baseAtStart.endsWith('\n') ? ' ' : ''
      const combined = baseAtStart + sep + finalSoFar + interim
      setDraft(combined)
      // Keep the debounced save behaviour: any change while listening counts
      // as a typed change.
      if (debounceRef.current !== null) window.clearTimeout(debounceRef.current)
      debounceRef.current = window.setTimeout(() => {
        debounceRef.current = null
        void flush(combined)
      }, SAVE_DEBOUNCE_MS)
    }
    rec.onerror = (e) => {
      // 'no-speech' / 'aborted' are routine; surface anything else.
      if (e.error !== 'no-speech' && e.error !== 'aborted') setError(`Speech: ${e.error}`)
    }
    rec.onend = () => {
      // Promote whatever interim was last shown by re-anchoring to the
      // current draft, so a subsequent start picks up where we left off.
      baseAtStart = draftRef.current
      finalSoFar = ''
      setListening(false)
    }
    recognitionRef.current = rec
    try {
      rec.start()
      setListening(true)
      setError(null)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not start speech')
    }
  }

  const stopListening = () => {
    try { recognitionRef.current?.stop() } catch { /* ignore */ }
    setListening(false)
  }

  // Make sure the recognizer is shut down if the component unmounts mid-
  // session — otherwise it keeps the mic pinned in the browser's tab UI.
  useEffect(() => () => {
    try { recognitionRef.current?.abort() } catch { /* ignore */ }
  }, [])

  return (
    <section style={{ marginTop: 16 }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <BookOpen size={15} strokeWidth={1.8} style={{ color: 'var(--text-secondary)' }} />
        <h3 style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', margin: 0 }}>Journal</h3>
        <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>
          {saving ? <Loader2 size={11} style={{ display: 'inline', verticalAlign: 'middle' }} className="animate-spin" /> : null}
          {!saving && journal?.updated_at ? `saved` : null}
        </span>
        <div style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          {speechSupported && mode === 'write' && (
            <button
              type="button"
              onClick={listening ? stopListening : startListening}
              aria-pressed={listening}
              title={listening ? 'Stop dictation' : 'Dictate (speech-to-text)'}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 4,
                padding: '4px 10px', fontSize: 11, fontWeight: 500,
                background: listening ? 'rgba(239, 68, 68, 0.12)' : 'transparent',
                color: listening ? '#b91c1c' : 'var(--text-muted)',
                border: '1px solid var(--border-primary)', borderRadius: 8,
                cursor: 'pointer', fontFamily: 'inherit',
              }}
            >
              {listening ? <MicOff size={11} /> : <Mic size={11} />}
              {listening ? 'Listening…' : 'Dictate'}
            </button>
          )}
          <div style={{ display: 'inline-flex', borderRadius: 8, border: '1px solid var(--border-primary)', overflow: 'hidden' }}>
            <button
              type="button"
              onClick={() => switchMode('write')}
              aria-pressed={mode === 'write'}
              style={modeBtnStyle(mode === 'write')}
            >
              <Pencil size={11} /> Write
            </button>
            <button
              type="button"
              onClick={() => switchMode('preview')}
              aria-pressed={mode === 'preview'}
              style={modeBtnStyle(mode === 'preview')}
            >
              <Eye size={11} /> Preview
            </button>
          </div>
        </div>
      </header>

      {mode === 'write' ? (
        <textarea
          value={draft}
          onChange={e => onChange(e.target.value)}
          placeholder="What happened today? Markdown welcome — # headings, **bold**, *italics*, lists, [links](https://...)."
          rows={10}
          style={{
            width: '100%', boxSizing: 'border-box',
            padding: 10, borderRadius: 8,
            border: '1px solid var(--border-primary)',
            background: 'var(--bg-input)', color: 'var(--text-primary)',
            fontSize: 13, lineHeight: 1.5, fontFamily: 'inherit', resize: 'vertical',
          }}
        />
      ) : (
        <div
          className="collab-note-md-full"
          style={{
            padding: 12, borderRadius: 8, minHeight: 120,
            border: '1px solid var(--border-faint)',
            background: 'var(--bg-card)', color: 'var(--text-primary)',
            fontSize: 13, lineHeight: 1.5,
          }}
        >
          {draft.trim().length === 0
            ? <span style={{ color: 'var(--text-faint)' }}>Nothing written yet.</span>
            : <Markdown remarkPlugins={[remarkGfm]}>{draft}</Markdown>}
        </div>
      )}

      {error && <div style={{ marginTop: 6, fontSize: 11, color: '#b91c1c' }}>{error}</div>}
    </section>
  )
}

function modeBtnStyle(active: boolean): React.CSSProperties {
  return {
    display: 'inline-flex', alignItems: 'center', gap: 4,
    padding: '4px 10px', fontSize: 11, fontWeight: 500,
    background: active ? 'var(--bg-tertiary)' : 'transparent',
    color: active ? 'var(--text-primary)' : 'var(--text-muted)',
    border: 'none', cursor: 'pointer', fontFamily: 'inherit',
  }
}
