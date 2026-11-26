import { useState } from 'react'
import { Check, ChevronDown, Coins, GitBranch, GitMerge, Square, Trash2 } from 'lucide-react'
import { useStore } from '../store'
import { fmtK } from './common'

// Sessions: the always-on "changes on disk" watcher, plus one per agent run. Isolated sessions
// run in their own git worktree; merge or discard them when done.

export function SessionSwitcher() {
  const sessions = useStore((s) => s.sessions)
  const activeId = useStore((s) => s.activeSession)
  const { setActiveSession } = useStore.getState()
  const [open, setOpen] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const active = sessions.find((s) => s.id === activeId) ?? sessions[0]
  if (!active) return null
  const tokens = active.tokens.input + active.tokens.output + active.tokens.cacheRead
  const running = sessions.filter((s) => !s.ambient && (s.status === 'running' || s.status === 'waiting')).length

  return (
    <div className="session-switcher">
      <button className="session-current" onClick={() => setOpen(!open)}>
        <i className="session-dot" style={{ background: active.color }} />
        <span className="session-title">{active.title}</span>
        <span className={`session-status st-${active.status}`}>{active.status}</span>
        {running > 0 && !open && <span className="count">{running}</span>}
        <ChevronDown size={12} />
      </button>
      {open && (
        <div className="session-menu">
          {[...sessions].reverse().map((s) => (
            <div
              key={s.id}
              className={`session-row ${s.id === activeId ? 'on' : ''}`}
              onClick={() => {
                void setActiveSession(s.id)
                setOpen(false)
              }}
            >
              <i className="session-dot" style={{ background: s.color }} />
              <span className="session-title">{s.title}</span>
              {s.worktree && <GitBranch size={11} className="muted" />}
              <span className={`session-status st-${s.status}`}>{s.status}</span>
            </div>
          ))}
        </div>
      )}
      <div className="session-meta">
        <span className="muted small">
          {active.agent === 'claude-code' ? 'Claude Code' : active.agent === 'codex' ? 'Codex' : active.agent === 'gemini' ? 'Gemini' : active.agent === 'builtin' ? 'Viber agent' : active.ambient ? 'any editor or agent' : 'your agent'}
          {active.model ? ` · ${active.model}` : ''}
        </span>
        {tokens > 0 && (
          <span className="muted small">
            <Coins size={11} /> {fmtK(tokens)}
            {active.tokens.cacheRead ? ` (${fmtK(active.tokens.cacheRead)} cached)` : ''}
            {active.tokens.costUsd ? ` · $${active.tokens.costUsd.toFixed(2)}` : ''}
          </span>
        )}
        {(active.status === 'running' || active.status === 'waiting') && !active.ambient && active.agent !== 'external' && (
          <button className="icon-btn tiny" title="Stop" onClick={() => void window.viber.invoke('session:stop', active.id)}>
            <Square size={11} />
          </button>
        )}
        {active.status === 'running' && active.agent === 'external' && !active.ambient && (
          <button className="btn small" title="Your agent is done: run impacted tests and move to review" onClick={() => void window.viber.invoke('session:finish', active.id)}>
            <Check size={11} /> Finish
          </button>
        )}
      </div>
      {active.worktree && ['done', 'stopped', 'error'].includes(active.status) && (
        <div className="worktree-actions">
          <span className="muted small">
            <GitBranch size={11} /> {active.worktree.branch}
          </span>
          <button
            className="btn small"
            onClick={async () => {
              const r = await window.viber.invoke<{ ok: boolean; error?: string }>('session:mergeWorktree', active.id)
              setMsg(r.ok ? 'Merged into your current branch.' : `Merge failed: ${r.error}`)
            }}
          >
            <GitMerge size={12} /> Merge
          </button>
          <button className="btn small" onClick={() => void window.viber.invoke('session:discardWorktree', active.id).then(() => setMsg('Worktree discarded.'))}>
            <Trash2 size={12} /> Discard
          </button>
        </div>
      )}
      {msg && <p className="small muted">{msg}</p>}
    </div>
  )
}
