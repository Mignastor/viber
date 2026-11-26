import { useEffect, useState } from 'react'
import { Hammer, Loader2, Square } from 'lucide-react'
import type { AgentKind } from '@shared/api'
import { useModel, useStore } from '../store'
import { designCheck } from '@shared/designCheck'

// Build from the spec: planned boxes become agent tasks, providers before consumers, parallel
// waves in worktrees. Each box's autonomy decides whether you approve its plan.

const STATE_LABEL: Record<string, string> = { waiting: 'waiting', running: 'building', built: 'built', verified: 'verified ✓', failed: 'failed', review: 'needs review' }
const JOURNEY_LABEL: Record<string, string> = { waiting: 'waiting', writing: 'writing test', running: 'running test', pass: 'passes ✓', fail: 'fails ✗', skipped: 'skipped' }

export function BuildPanel() {
  const model = useModel()
  const build = useStore((s) => s.build)
  const defaultAgent = useStore((s) => s.agent)
  const [agent, setAgent] = useState<AgentKind>(defaultAgent === 'external' ? 'claude-code' : defaultAgent)
  const [parallel, setParallel] = useState(2)
  const [plan, setPlan] = useState<string[][]>([])
  const [error, setError] = useState<string | null>(null)
  const { setActiveSession, select } = useStore.getState()
  const label = (id: string): string => model.nodes.find((n) => n.id === id)?.label ?? id
  const planned = model.nodes.filter((n) => n.kind === 'box' && (n.spec?.status === 'planned' || n.spec?.status === 'building'))
  const plannedKey = planned.map((n) => n.id).join(',')

  useEffect(() => {
    window.viber.invoke<string[][]>('build:plan').then(setPlan).catch(() => setPlan([]))
    const off = window.viber.on('build:error', (e: string) => setError(e))
    return off
  }, [plannedKey])


  const gaps = designCheck(model).filter((i) => !i.ok)
  const start = async (): Promise<void> => {
    setError(null)
    if (gaps.length && !window.confirm(`The design has ${gaps.length} gap${gaps.length > 1 ? 's' : ''}:\n\n${gaps.map((g) => `- ${g.title}${g.detail ? `: ${g.detail}` : ''}`).join('\n')}\n\nAgents build what the design says, so gaps become guesses. Build anyway?`)) return
    await window.viber.invoke('build:start', { agent, maxParallel: parallel })
  }
  const waves = build?.running || build?.waves.length ? build.waves : plan
  // Journeys through the boxes being built get their end-to-end test written and run afterwards.
  const journeyRows = build?.journeys && Object.keys(build.journeys).length
    ? Object.values(build.journeys)
    : (model.journeys ?? []).filter((j) => j.steps.some((s) => waves.some((w) => w.includes(s.box)))).map((j) => ({ id: j.id, name: j.name, state: 'waiting' as const, note: undefined, sessionId: undefined }))

  return (
    <div className="build-panel">
      <section>
        <h3>
          <Hammer size={13} /> Build from the spec
        </h3>
        <p className="muted small">
          Planned components become agent tasks generated from their spec, contracts and journeys. Providers are built before
          consumers; a wave runs in parallel worktrees. “Ask me” boxes wait for your plan approval. Then each journey through them
          becomes an end-to-end test on the real code: a box is verified only when its own tests and its journeys pass.
        </p>
        {planned.length === 0 && !build?.running && <p className="small">No planned components. Add one on the map (+ Component) or ask the architect.</p>}
        {waves.map((w, i) => (
          <div key={i} className="wave">
            <span className="wave-n">Wave {i + 1}</span>
            {w.map((id) => {
              const st = build?.boxes[id]
              return (
                <div key={id} className={`wave-box st-${st?.state ?? 'waiting'}`} onClick={() => (st?.sessionId ? void setActiveSession(st.sessionId) : select({ kind: 'node', id }))}>
                  {st?.state === 'running' && <Loader2 size={11} className="spin" />}
                  <span className="list-label">{label(id)}</span>
                  <span className="tree-meta">{STATE_LABEL[st?.state ?? 'waiting']}</span>
                  {st?.note && <span className="muted small block">{st.note}</span>}
                </div>
              )
            })}
          </div>
        ))}
        {journeyRows.length > 0 && (
          <div className="wave">
            <span className="wave-n">Journeys</span>
            {journeyRows.map((j) => (
              <div
                key={j.id}
                className={`wave-box st-${j.state === 'pass' ? 'verified' : j.state === 'fail' ? 'failed' : j.state === 'writing' || j.state === 'running' ? 'running' : 'waiting'}`}
                onClick={() => j.sessionId && void setActiveSession(j.sessionId)}
              >
                {(j.state === 'writing' || j.state === 'running') && <Loader2 size={11} className="spin" />}
                <span className="list-label">{j.name}</span>
                <span className="tree-meta">{JOURNEY_LABEL[j.state]}</span>
                {j.note && <span className="muted small block">{j.note}</span>}
              </div>
            ))}
          </div>
        )}
        {error && <p className="bad small">{error}</p>}
        {build?.running ? (
          <button className="btn" onClick={() => void window.viber.invoke('build:stop')}>
            <Square size={12} /> Stop build
          </button>
        ) : (
          <div className="build-controls">
            <select value={agent} onChange={(e) => setAgent(e.target.value as AgentKind)} aria-label="Agent">
              <option value="claude-code">Claude Code</option>
              <option value="codex">Codex</option>
              <option value="gemini">Gemini</option>
              <option value="builtin">Viber agent</option>
            </select>
            <label className="check small">
              parallel
              <select value={parallel} onChange={(e) => setParallel(Number(e.target.value))} aria-label="Parallel agents">
                {[1, 2, 3, 4].map((n) => (
                  <option key={n}>{n}</option>
                ))}
              </select>
            </label>
            <button className="btn primary" disabled={!waves.length} onClick={start}>
              <Hammer size={13} /> Build {planned.length} component{planned.length === 1 ? '' : 's'}
            </button>
          </div>
        )}
      </section>
    </div>
  )
}
