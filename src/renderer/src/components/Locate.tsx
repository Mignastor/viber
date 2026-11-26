import { useState } from 'react'
import { Bug, Crosshair, Search } from 'lucide-react'
import type { LocateResult } from '@shared/api'
import { useModel, useStore } from '../store'
import { Dialog } from './Modals'

// Bug → box: paste a stack trace, an error message, a failing test or a log line and Viber
// points at the boxes and symbols involved, then scopes the prompt to them.

export function LocateDialog() {
  const model = useModel()
  const { setModal, setScope, setPromptText, openCode, setHighlight } = useStore.getState()
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<LocateResult | null>(null)
  const label = (id: string): string => model.nodes.find((n) => n.id === id)?.label ?? id

  const find = async (): Promise<void> => {
    if (!text.trim()) return
    setBusy(true)
    try {
      const r = await window.viber.invoke<LocateResult>('ws:locate', text)
      setResult(r)
      setHighlight([...new Set(r.hits.map((h) => h.nodeId))])
    } finally {
      setBusy(false)
    }
  }

  const scopeToHits = (): void => {
    if (!result) return
    const boxes = [...new Set(result.hits.slice(0, 6).map((h) => h.nodeId))].slice(0, 3)
    setScope(boxes)
    const first = text.split('\n').map((l) => l.trim()).find(Boolean) ?? ''
    const top = result.hits[0]
    setPromptText(
      `Fix this bug: ${first.slice(0, 160)}\n` +
        (top ? `Most likely location: ${top.file}${top.line ? ':' + top.line : ''}${top.symbol ? ` (${top.symbol})` : ''}.` : '')
    )
    setModal(null)
  }

  return (
    <Dialog title="Bug → box" onClose={() => setModal(null)} wide>
      <div className="form">
        <p className="muted small">Paste a stack trace, an error message, a failing test or a request log line.</p>
        <textarea
          className="mono"
          rows={8}
          autoFocus
          value={text}
          placeholder={'TypeError: Cannot read properties of undefined (reading \'token\')\n    at refresh (src/auth/login.ts:42:17)\n    at …'}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && (e.ctrlKey || e.metaKey) && find()}
        />
      </div>
      {result && (
        <div className="locate-results">
          <p className="locate-summary">
            <Bug size={14} /> {result.summary}
          </p>
          <ul className="file-list">
            {result.hits.slice(0, 12).map((h, i) => (
              <li key={i} onClick={() => openCode(h.nodeId, h.file)}>
                <span>
                  <strong>{label(h.nodeId)}</strong>
                  <span className="mono muted">
                    {' '}
                    {h.file}
                    {h.line ? ':' + h.line : ''}
                    {h.symbol ? ` · ${h.symbol}` : ''}
                  </span>
                  <small className="muted block">{h.reason}</small>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="modal-foot">
        <button className="btn" onClick={() => setModal(null)}>
          Close
        </button>
        {result && result.hits.length > 0 && (
          <button className="btn" onClick={scopeToHits}>
            <Crosshair size={13} /> Scope the prompt to these boxes
          </button>
        )}
        <button className="btn primary" disabled={!text.trim() || busy} onClick={find}>
          <Search size={13} /> {busy ? 'Searching…' : 'Locate'}
        </button>
      </div>
    </Dialog>
  )
}
