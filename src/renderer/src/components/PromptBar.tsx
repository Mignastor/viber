import { useEffect, useState } from 'react'
import { Check, Code2, GitBranch, ListChecks, Loader2, Send, Sparkles, Square, X } from 'lucide-react'
import type { AgentKind } from '@shared/api'
import { useModel, useSim, useStore } from '../store'
import { AGENT_NAME } from '../sim/scenario'
import { fmtK } from './common'
import { askArchitect } from '../architectChat'

// The prompt is scoped by what is selected on the map: the selection *is* the context.

const AGENTS: { id: AgentKind; label: string; hint: string }[] = [
  { id: 'claude-code', label: 'Claude Code', hint: 'Runs the Claude Code CLI headless (your Claude plan), connected to Viber over MCP' },
  { id: 'codex', label: 'Codex', hint: 'Runs the OpenAI Codex CLI headless (your ChatGPT plan), connected to Viber over MCP' },
  { id: 'gemini', label: 'Gemini', hint: 'Runs the Gemini CLI headless (your Google account), connected to Viber over MCP' },
  { id: 'builtin', label: 'Viber agent', hint: 'Built-in loop: Claude API or a local model (Ollama), set in Settings' },
  { id: 'external', label: 'My own agent', hint: 'Use any agent yourself (Cursor, a terminal…); Viber watches and maps its work' }
]

const PHASE_TEXT: Record<string, string> = {
  context: 'Building context pack…',
  intent: 'The agent announced its intent',
  plan: 'The agent is proposing a plan…',
  executing: 'The agent is working inside the fence',
  testing: 'Running impact-selected tests…'
}

export function PromptBar() {
  const sim = useSim()
  const mode = useStore((s) => s.mode)
  const step = useStore((s) => s.step)
  const scope = useStore((s) => s.scope)
  const promptText = useStore((s) => s.promptText)
  const agent = useStore((s) => s.agent)
  const isolate = useStore((s) => s.isolate)
  const sessions = useStore((s) => s.sessions)
  const activeSession = useStore((s) => s.activeSession)
  const [feedback, setFeedback] = useState('')
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { setPromptText, run, toggleScope, approvePlan, rejectPlan, setTab, setActiveSession } = useStore.getState()
  const label = (id: string): string => sim.nodes.find((n) => n.id === id)?.label ?? id
  const live = mode === 'workspace'
  const active = sessions.find((s) => s.id === activeSession)
  const model = useModel()
  const designed = model.nodes.some((n) => n.kind === 'box' && !n.proposed)
  const promptMode = useStore((s) => s.promptMode)
  const leftTab = useStore((s) => s.leftTab)
  // The obvious mode follows what you are doing; the switch is always there to override it.
  useEffect(() => {
    if (leftTab === 'design') useStore.setState({ promptMode: 'design' })
    else if (leftTab === 'session' && designed) useStore.setState({ promptMode: 'code' })
  }, [leftTab])
  useEffect(() => {
    if (scope.length && designed && useStore.getState().leftTab !== 'design') useStore.setState({ promptMode: 'code' })
  }, [scope.length])
  const idle = live ? !active || active.ambient || ['done', 'stopped', 'error'].includes(active.status) : step === 0

  const start = async (): Promise<void> => {
    if (!live) return run()
    setStarting(true)
    setError(null)
    try {
      const id = await window.viber.invoke<string>('session:start', { prompt: promptText, scope, agent, isolate })
      await setActiveSession(id)
      setPromptText('')
    } catch (e) {
      setError(String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    } finally {
      setStarting(false)
    }
  }

  // Only while the agent is actually waiting: an ended session can't take a decision any more.
  if (sim.phase === 'awaitApproval' && (!live || active?.status === 'waiting')) {
    return (
      <div className="prompt-bar approval">
        <div className="prompt-status">
          <ListChecks size={16} />
          <div>
            <strong>Plan ready.</strong> Ghost boxes and amber edges on the map are what the agent intends to change.
            <input className="edit-input feedback" value={feedback} placeholder="Feedback if you reject (optional)" onChange={(e) => setFeedback(e.target.value)} />
          </div>
        </div>
        <div className="prompt-actions">
          <button className="btn" onClick={() => (rejectPlan(feedback), setFeedback(''))}>
            <X size={14} /> Reject
          </button>
          <button className="btn primary" onClick={approvePlan}>
            <Check size={14} /> Approve plan
          </button>
        </div>
      </div>
    )
  }

  if (!idle) {
    return (
      <div className="prompt-bar compact">
        <div className="prompt-status">
          <Loader2 size={16} className="spin" />
          <div>
            <strong>{PHASE_TEXT[sim.phase] ?? 'Working…'}</strong>
            <span className="muted"> · “{sim.prompt}”</span>
          </div>
        </div>
        {live && active && active.agent === 'external' ? (
          <button className="btn small" onClick={() => void window.viber.invoke('session:finish', active.id)}>
            <Check size={12} /> Finish
          </button>
        ) : (
          live &&
          active && (
            <button className="btn small" onClick={() => void window.viber.invoke('session:stop', active.id)}>
              <Square size={12} /> Stop
            </button>
          )
        )}
      </div>
    )
  }

  if (!live && sim.phase === 'review') {
    return (
      <div className="prompt-bar compact">
        <div className="prompt-status">
          <Check size={16} className="ok" />
          <div>{sim.doneSummary}</div>
        </div>
        <button className="btn primary" onClick={() => setTab('review')}>
          Review by box
        </button>
      </div>
    )
  }

  // Design mode (always, until there is a design): the text goes to the architect, not to a coding agent.
  if (live && (!designed || promptMode === 'design')) return <DesignBar designed={designed} />

  // Rough preview of the context pack size: overview + per-box summary/signatures.
  const estimate = 1400 + scope.length * 1700
  return (
    <div className="prompt-bar">
      {live && sim.phase === 'review' && sim.touched.size > 0 && (
        <div className="prompt-done">
          <Check size={13} className="ok" /> {sim.doneSummary?.split('\n')[0]}{' '}
          <button className="linklike" onClick={() => setTab('review')}>
            Review {sim.touched.size} box{sim.touched.size > 1 ? 'es' : ''}
          </button>
        </div>
      )}
      <div className="prompt-scope">
        {live && <ModeSwitch designed={designed} />}
        <span className="prompt-scope-label">Scope</span>
        {scope.length === 0 && <span className="muted">click boxes on the map (shift-click to add)</span>}
        {scope.map((id) => (
          <span key={id} className="chip chip-scope">
            {label(id)}
            <button onClick={() => toggleScope(id)} aria-label={`Remove ${label(id)}`}>
              <X size={11} />
            </button>
          </span>
        ))}
        <span className="prompt-estimate">context pack ≈ {fmtK(estimate)} tokens</span>
      </div>
      <div className="prompt-row">
        <textarea
          value={promptText}
          onChange={(e) => setPromptText(e.target.value)}
          rows={2}
          placeholder="Describe the change…"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && promptText.trim()) void start()
          }}
        />
        <button className="btn primary" onClick={start} disabled={!promptText.trim() || starting}>
          {starting ? <Loader2 size={14} className="spin" /> : <Send size={14} />} Run
        </button>
      </div>
      {live ? (
        <div className="prompt-options">
          <div className="seg small">
            {AGENTS.map((a) => (
              <button key={a.id} className={agent === a.id ? 'on' : ''} title={a.hint} onClick={() => useStore.setState({ agent: a.id })}>
                {a.label}
              </button>
            ))}
          </div>
          <label className="check" title="Run in its own git worktree and branch, so several agents can work in parallel">
            <input type="checkbox" checked={isolate} onChange={(e) => useStore.setState({ isolate: e.target.checked })} />
            <GitBranch size={12} /> isolate in a worktree
          </label>
          {error && <span className="bad small">{error}</span>}
        </div>
      ) : (
        <div className="prompt-hint">Demo: plays a scripted session with {AGENT_NAME}, whatever you type.</div>
      )}
    </div>
  )
}

/** Design (the architect changes the design) or Code (an agent changes the code). */
function ModeSwitch({ designed }: { designed: boolean }) {
  const mode = useStore((s) => s.promptMode)
  return (
    <div className="seg small mode-switch">
      <button className={mode === 'design' || !designed ? 'on' : ''} title="Change the design: components, contracts, actors, journeys (the architect)" onClick={() => useStore.setState({ promptMode: 'design' })}>
        <Sparkles size={11} /> Design
      </button>
      <button
        className={mode === 'code' && designed ? 'on' : ''}
        disabled={!designed}
        title={designed ? 'Change the code inside the selected boxes (a coding agent)' : 'Design first: there is nothing to code yet'}
        onClick={() => useStore.setState({ promptMode: 'code' })}
      >
        <Code2 size={11} /> Code
      </button>
    </div>
  )
}

function DesignBar({ designed }: { designed: boolean }) {
  const text = useStore((s) => s.promptText)
  const busy = useStore((s) => s.archBusy)
  const { setPromptText } = useStore.getState()
  const send = (): void => {
    if (!text.trim() || busy) return
    void askArchitect(text)
    setPromptText('')
  }
  return (
    <div className="prompt-bar">
      <div className="prompt-scope">
        <ModeSwitch designed={designed} />
        <span className="muted">
          {designed ? 'Change the design with the architect. Proposals appear on the map; accept or reject them in the Design tab.' : 'Design first: describe your idea. The architect proposes who uses it, the components, their contracts and journeys. Code comes after.'}
        </span>
      </div>
      <div className="prompt-row">
        <textarea
          value={text}
          onChange={(e) => setPromptText(e.target.value)}
          rows={designed ? 2 : 3}
          placeholder={designed ? 'e.g. add a lobby where players pick their characters · who saves the game state? · split the narrator from the rules' : 'Your idea: who uses it, what it does, anything it must or must not do…'}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send()
          }}
        />
        <button className="btn primary" onClick={send} disabled={!text.trim() || busy}>
          {busy ? <Loader2 size={14} className="spin" /> : <Sparkles size={14} />} {designed ? 'Ask the architect' : 'Design it'}
        </button>
      </div>
      {busy && (
        <div className="prompt-hint">
          <Loader2 size={11} className="spin" /> The architect is working. Follow it in the Design tab.
        </div>
      )}
    </div>
  )
}
