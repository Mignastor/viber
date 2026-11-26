import { askArchitect } from '../architectChat'
import { useEffect, useMemo } from 'react'
import { ChevronLeft, ChevronRight, History, Pause, Play, X } from 'lucide-react'
import { useModel, useStore, type HistoryState } from '../store'

// Two ways of *reading* the map over time:
//  - History: git commits mapped to boxes, shown as heat for a sliding window of commits.
//  - Explain: an animated walk from an actor through the boxes it reaches, with narration.

export async function openHistory(): Promise<void> {
  const h = await window.viber.invoke<Omit<HistoryState, 'range'>>('git:history', 300)
  useStore.setState({ history: { ...h, range: [0, Math.min(30, h.commits.length)] }, explain: null })
}

export function HistoryBar() {
  const history = useStore((s) => s.history)
  const model = useModel()
  if (!history) return null
  const { commits, range } = history
  const size = range[1] - range[0]
  const setRange = (from: number, n = size): void => {
    const f = Math.max(0, Math.min(commits.length - 1, from))
    useStore.setState({ history: { ...history, range: [f, Math.min(commits.length, f + Math.max(1, n))] } })
  }
  const newest = commits[range[0]]
  const oldest = commits[range[1] - 1]
  const touched = new Set(commits.slice(range[0], range[1]).flatMap((c) => c.boxes))
  const label = (id: string): string => model.nodes.find((n) => n.id === id)?.label ?? id
  const fmt = (t: number): string => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })

  return (
    <div className="mode-bar">
      <History size={14} />
      {commits.length === 0 ? (
        <span className="muted">No git history.</span>
      ) : (
        <>
          <span className="small">
            <strong>{size}</strong> commits · {oldest ? fmt(oldest.time) : ''} → {newest ? fmt(newest.time) : ''} · {touched.size} boxes touched
          </span>
          <input
            type="range"
            min={0}
            max={Math.max(0, commits.length - size)}
            value={commits.length - size - range[0]}
            onChange={(e) => setRange(commits.length - size - Number(e.target.value))}
            aria-label="Move the window through history"
          />
          <select value={size} onChange={(e) => setRange(range[0], Number(e.target.value))} aria-label="Window size">
            {[...new Set([1, 5, 10, 30, 100, 300].filter((n) => n <= Math.max(1, commits.length)).concat(size))].sort((a, b) => a - b).map((n) => (
              <option key={n} value={n}>
                {n} commit{n > 1 ? 's' : ''}
              </option>
            ))}
          </select>
          {size <= 5 && newest && (
            <span className="small mono muted ellipsis" title={newest.subject}>
              {newest.sha.slice(0, 7)} {newest.author}: {newest.subject} ({newest.boxes.map(label).slice(0, 3).join(', ')})
            </span>
          )}
        </>
      )}
      <span className="spacer" />
      <button className="icon-btn" onClick={() => useStore.setState({ history: null })} aria-label="Close history">
        <X size={13} />
      </button>
    </div>
  )
}

/** Heat per node id: share of commits in the window that touched it (0..1). */
export function useHeat(): Record<string, number> {
  const history = useStore((s) => s.history)
  return useMemo(() => {
    if (!history) return {}
    const counts: Record<string, number> = {}
    for (const c of history.commits.slice(history.range[0], history.range[1])) for (const b of c.boxes) counts[b] = (counts[b] ?? 0) + 1
    const max = Math.max(1, ...Object.values(counts))
    return Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, v / max]))
  }, [history])
}

/** Breadth-first walk from an actor through the dependencies it reaches. */
export function explainPath(model: ReturnType<typeof useModel>, actor: string): string[] {
  const kinds = new Map(model.nodes.map((n) => [n.id, n.kind]))
  const path: string[] = [actor]
  const queue = model.edges.filter((e) => e.source === actor).map((e) => e.target)
  while (queue.length && path.length < 14) {
    const cur = queue.shift()!
    if (path.includes(cur) || kinds.get(cur) === 'actor') continue
    path.push(cur)
    for (const e of model.edges) if (e.source === cur && !path.includes(e.target)) queue.push(e.target)
  }
  return path
}

export function ExplainBar() {
  const explain = useStore((s) => s.explain)
  const playing = useStore((s) => s.playing)
  const model = useModel()
  const { setHighlight } = useStore.getState()

  useEffect(() => {
    if (!explain) return
    const id = explain.path[explain.i]
    setHighlight([id])
    useStore.setState({ selection: { kind: 'node', id } })
  }, [explain, setHighlight])

  useEffect(() => {
    if (!explain || !playing) return
    if (explain.i >= explain.path.length - 1) return void useStore.setState({ playing: false })
    const t = setTimeout(() => useStore.setState({ explain: { ...explain, i: explain.i + 1 } }), 2600)
    return () => clearTimeout(t)
  }, [explain, playing])

  if (!explain) return null
  const id = explain.path[explain.i]
  const node = model.nodes.find((n) => n.id === id)
  const prev = explain.path[explain.i - 1]
  const isJourney = !!explain.actions
  // The contract crossed by this step, in either direction (a step can travel against the arrow).
  const via = prev
    ? isJourney
      ? model.edges.find((e) => (e.source === prev && e.target === id) || (e.source === id && e.target === prev))
      : model.edges.find((e) => e.target === id && explain.path.slice(0, explain.i).includes(e.source))
    : undefined
  const action = explain.actions?.[explain.i]
  const label = (x: string): string => model.nodes.find((n) => n.id === x)?.label ?? x
  const go = (i: number): void => useStore.setState({ explain: { ...explain, i: Math.max(0, Math.min(explain.path.length - 1, i)) }, playing: false })

  return (
    <div className="explain-card">
      <div className="explain-head">
        <span className="muted small">
          {explain.title ? (explain.dry ? explain.title : `Journey · ${explain.title}`) : `Explain · ${label(explain.actor)}`} · step {explain.i + 1}/{explain.path.length}
        </span>
        <span className="spacer" />
        <button className="icon-btn tiny" onClick={() => go(explain.i - 1)} aria-label="Previous">
          <ChevronLeft size={12} />
        </button>
        <button className="icon-btn tiny" onClick={() => useStore.setState({ playing: !playing })} aria-label={playing ? 'Pause' : 'Play'}>
          {playing ? <Pause size={12} /> : <Play size={12} />}
        </button>
        <button className="icon-btn tiny" onClick={() => go(explain.i + 1)} aria-label="Next">
          <ChevronRight size={12} />
        </button>
        <button className="icon-btn tiny" onClick={() => (useStore.setState({ explain: null, playing: false }), setHighlight([]))} aria-label="Close">
          <X size={12} />
        </button>
      </div>
      <strong>{node?.label}</strong>
      {action && <p className="journey-action">{action}</p>}
      {via && (
        <p className="small muted">
          {isJourney ? (via.source === prev ? 'from' : 'answering') : 'reached from'} {label(prev ?? via.source)} via{' '}
          <span className="mono">{via.contract.slice(0, 2).join(', ') || via.label}</span>
        </p>
      )}
      {isJourney && prev && !via && prev !== id && (
        <p className="small journey-gap">
          No contract between {label(prev)} and {node?.label}: this journey assumes one. Draw it with “Contract”.
        </p>
      )}
      {!action && <p className="small">{node?.purpose}</p>}
      {explain.dry?.[explain.i] && <DryStep step={explain.dry[explain.i]!} />}
      {explain.dry && explain.i === explain.path.length - 1 && <DryEnd explain={explain} />}
    </div>
  )
}

function DryStep({ step }: { step: { message?: string; payload?: string; effect?: string; problem?: string } }) {
  return (
    <div className="dry-step">
      {step.message && (
        <p className="small">
          <span className="muted">Crosses</span> <span className="mono">{step.message}</span>
        </p>
      )}
      {step.payload && <pre className="dry-payload">{step.payload}</pre>}
      {step.effect && (
        <p className="small">
          <span className="muted">Then</span> {step.effect}
        </p>
      )}
      {step.problem && <p className="small journey-gap">{step.problem}</p>}
    </div>
  )
}

/** End of a dry run: the gaps found, and ways forward. */
function DryEnd({ explain }: { explain: NonNullable<ReturnType<typeof useStore.getState>['explain']> }) {
  const gaps = explain.gaps ?? []
  return (
    <div className="dry-end">
      {gaps.length ? (
        <>
          <p className="small journey-gap">
            {gaps.length} gap{gaps.length > 1 ? 's' : ''} in the design for this scenario.
          </p>
          <button
            className="btn small"
            onClick={() =>
              void askArchitect(`A dry run of "${explain.title?.replace(/^Dry run · /, '')}" found gaps in the design. Fix them (add or change actors, components, contracts and journeys as needed):\n${gaps.map((g) => `- ${g}`).join('\n')}`)
            }
          >
            Ask the architect to fix them
          </button>
        </>
      ) : (
        <p className="small ok">The scenario plays through the design with no gaps.</p>
      )}
      {explain.scenario && (
        <button
          className="btn small"
          onClick={() => {
            const sc = explain.scenario!
            const id = sc.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'scenario'
            void window.viber.invoke('ws:apply', { op: 'upsertJourney', journey: { id, actor: sc.actor, name: sc.name, steps: sc.steps } })
          }}
        >
          Save as a journey
        </button>
      )}
    </div>
  )
}
