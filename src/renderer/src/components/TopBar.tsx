import { Bug, Coins, Crosshair, GitBranch, GitPullRequest, History, Home, Play, Plug, Presentation, Search, Settings, TerminalSquare, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { explainPath, openHistory } from './Modes'
import { useModel, useSim, useStore } from '../store'
import { ZOOM_LABELS, type ZoomLevel } from '@shared/model'
import { fmtK } from './common'
import { actorColor } from './colors'
import { ThemeToggle } from './ThemeToggle'

export function TopBar() {
  const sim = useSim()
  const model = useModel()
  const mode = useStore((s) => s.mode)
  const zoom = useStore((s) => s.zoom)
  const snapshot = useStore((s) => s.snapshot)
  const opened = useStore((s) => s.opened)
  const actorFocus = useStore((s) => s.actorFocus)
  const { setZoom, setModal, setActorFocus, leaveToWelcome } = useStore.getState()
  const sessions = useStore((s) => s.sessions)
  const activeId = useStore((s) => s.activeSession)
  const activeSession = sessions.find((x) => x.id === activeId)
  // Savings are only meaningful when we see the agent's real token usage (not for external agents).
  const spendKnown = mode === 'demo' || (activeSession && activeSession.agent !== 'external' && !activeSession.ambient)
  const ratio = spendKnown && sim.tokensUsed > 0 ? sim.tokensNaive / sim.tokensUsed : 0
  const bottom = useStore((s) => s.bottom)
  const history = useStore((s) => s.history)
  const explain = useStore((s) => s.explain)
  const [branches, setBranches] = useState<{ current: string; all: string[] } | null>(null)
  const [prMsg, setPrMsg] = useState<string | null>(null)
  const root = snapshot?.root
  const branch = snapshot?.git?.branch
  useEffect(() => {
    if (mode === 'workspace' && root && branch) window.viber.invoke<{ current: string; all: string[] }>('git:branches').then(setBranches).catch(() => {})
  }, [mode, root, branch])
  const startExplain = (): void => {
    const actor = actorFocus ?? actors[0]?.id
    if (!actor) return
    useStore.setState({ explain: { actor, path: explainPath(model, actor), i: 0 }, playing: true, history: null })
  }
  const createPr = async (): Promise<void> => {
    if (!window.confirm(`Push branch "${branch}" to origin and open a pull request page?`)) return
    const r = await window.viber.invoke<{ ok: boolean; error?: string }>('git:createPr')
    setPrMsg(r.ok ? null : (r.error ?? 'Failed'))
  }
  const actors = model.nodes.filter((n) => n.kind === 'actor')
  const name = mode === 'demo' ? 'verdant (demo)' : (snapshot?.name ?? opened?.name ?? '')

  return (
    <header className="topbar">
      <button
        className="brand"
        title="Back to start"
        onClick={() => {
          if (mode === 'workspace') void window.viber.invoke('app:close')
          leaveToWelcome()
        }}
      >
        <span className="logo">◆</span> Viber <Home size={12} className="muted" />
      </button>
      <div className="project">
        <span>{name}</span>
        {snapshot?.draft && <span className="draft-pill">draft</span>}
        {branches && branches.all.length > 1 ? (
          <span className="branch-select muted">
            <GitBranch size={12} />
            <select
              value={branches.current}
              onChange={(e) => void window.viber.invoke('git:checkout', e.target.value).then(() => window.viber.invoke<{ current: string; all: string[] }>('git:branches').then(setBranches))}
              aria-label="Branch"
            >
              {branches.all.map((b) => (
                <option key={b}>{b}</option>
              ))}
            </select>
          </span>
        ) : mode !== 'demo' && !branch && snapshot ? (
          <button
            className="btn small"
            title="Agents need git for checkpoints, undo and parallel worktrees"
            onClick={() =>
              void window.viber.invoke<{ ok: boolean; error?: string }>('ws:gitInit').then((r) => {
                if (!r.ok) alert(r.error)
              })
            }
          >
            <GitBranch size={12} /> Set up git
          </button>
        ) : (
          <span className="muted">
            <GitBranch size={12} /> {branch ?? 'main'}
          </span>
        )}
        {snapshot?.git?.dirty ? <span className="dirty small">{snapshot.git.dirty} changed</span> : null}
        {snapshot?.git?.remote && branch !== 'main' && branch !== 'master' && (
          <button className="icon-btn" title={prMsg ?? 'Push and open a pull request'} onClick={createPr}>
            <GitPullRequest size={13} />
          </button>
        )}
      </div>

      <div className="seg zoom-seg" role="group" aria-label="Zoom level">
        {([1, 2, 3] as ZoomLevel[]).map((z) => (
          <button key={z} className={zoom === z ? 'on' : ''} onClick={() => setZoom(z)}>
            {ZOOM_LABELS[z]}
          </button>
        ))}
      </div>

      {actors.length > 0 && (
        <div className={`focus-select ${actorFocus ? 'on' : ''}`} title="Show what one actor faces and reaches">
          <Crosshair size={13} />
          <select value={actorFocus ?? ''} onChange={(e) => setActorFocus(e.target.value || null)} aria-label="Focus on an actor">
            <option value="">All actors</option>
            {actors.map((a) => (
              <option key={a.id} value={a.id}>
                Facing: {a.label}
              </option>
            ))}
          </select>
          {actorFocus && (
            <>
              <i className="actor-dot" style={{ background: actorColor(model, actorFocus) }} />
              <button className="icon-btn tiny" onClick={() => setActorFocus(null)} aria-label="Clear focus">
                <X size={12} />
              </button>
            </>
          )}
        </div>
      )}

      <span className="spacer" />

      {(mode === 'demo' || sim.tokensUsed > 0) && (
        <div className="token-meter" title="Tokens this task has used, against an estimate for an agent exploring on its own">
          <Coins size={14} />
          <span>
            <strong>{fmtK(sim.tokensUsed)}</strong> {spendKnown ? 'tokens' : 'context'}
          </span>
          {sim.tokensNaive > 0 && spendKnown && <span className="muted">· est. without Viber {fmtK(sim.tokensNaive)}</span>}
          {ratio > 1 && <span className="ratio">{ratio.toFixed(1)}× less</span>}
          <div className="meter-bar">
            <div style={{ width: `${sim.tokensNaive ? Math.min(100, (100 * sim.tokensUsed) / sim.tokensNaive) : 0}%` }} />
          </div>
        </div>
      )}

      {mode === 'workspace' && (
        <div className="tool-group">
          <button className={`icon-btn ${history ? 'on' : ''}`} title="History heatmap" onClick={() => (history ? useStore.setState({ history: null }) : void openHistory())}>
            <History size={15} />
          </button>
          <button className={`icon-btn ${explain ? 'on' : ''}`} title="Explain: walk through what an actor reaches" disabled={!actors.length} onClick={() => (explain ? useStore.setState({ explain: null }) : startExplain())}>
            <Presentation size={15} />
          </button>
          <button className={`icon-btn ${bottom === 'terminal' ? 'on' : ''}`} title="Terminal" onClick={() => useStore.setState({ bottom: bottom === 'terminal' ? null : 'terminal' })}>
            <TerminalSquare size={15} />
          </button>
          <button className={`icon-btn ${bottom === 'run' ? 'on' : ''}`} title="Run the app or tests" onClick={() => useStore.setState({ bottom: bottom === 'run' ? null : 'run' })}>
            <Play size={15} />
          </button>
          <button className="icon-btn" title="Connect agents (MCP)" onClick={() => setModal({ kind: 'agents' })}>
            <Plug size={15} />
          </button>
        </div>
      )}
      {mode === 'workspace' && (
        <button className="btn small" onClick={() => setModal({ kind: 'locate' })} title="Bug → box (Ctrl+Shift+B)">
          <Bug size={13} />
          <span className="hide-narrow">Locate bug</span>
        </button>
      )}
      <button className="btn small" onClick={() => setModal({ kind: 'palette' })} title="Search and commands (Ctrl+K)">
        <Search size={13} /> <kbd>Ctrl K</kbd>
      </button>
      <ThemeToggle />
      <button className="icon-btn" onClick={() => setModal({ kind: 'settings' })} title="Settings">
        <Settings size={15} />
      </button>
    </header>
  )
}
