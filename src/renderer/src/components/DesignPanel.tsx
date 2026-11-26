import { useEffect, useRef, useState } from 'react'
import { StyleFields } from './SpecEditor'
import { designCheck, gapsAsRequest } from '@shared/designCheck'
import { askArchitect, decideProposal } from '../architectChat'
import { Check, CircleAlert, FileDiff, FlaskConical, ListChecks, Ruler, Loader2, MessageCircleQuestion, Play, Plus, Route, Sparkles, TestTube2, X } from 'lucide-react'
import type { DefsOp } from '@shared/api'
import type { Acp, DriftItem, Journey, JourneyTestResult, Question } from '@shared/model'
import { useModel, useStore } from '../store'

// Design: talk to the architect (it proposes diagram diffs you accept or reject), define actor
// journeys, answer agents' questions, and watch for drift between the design and the code.

/** Play a journey: the actor, then each step's box, with its action narrated. */
export interface DryRunResult {
  name: string
  actor: string
  steps: { box: string; action: string; message?: string; payload?: string; effect?: string; problem?: string }[]
  gaps: string[]
}

/** Walk a dry run on the map, one step at a time (paused, so each step can be read). */
export function startDryRun(r: DryRunResult, unsaved?: DryRunResult): void {
  useStore.setState({
    explain: {
      actor: r.actor,
      path: [r.actor, ...r.steps.map((s) => s.box)],
      i: 0,
      title: `Dry run · ${r.name}`,
      actions: ['starts', ...r.steps.map((s) => s.action)],
      dry: [null, ...r.steps.map(({ message, payload, effect, problem }) => ({ message, payload, effect, problem }))],
      gaps: r.gaps,
      scenario: unsaved ? { actor: r.actor, name: r.name, steps: r.steps.map((s) => ({ box: s.box, action: s.action })) } : undefined
    },
    playing: false,
    history: null,
    actorFocus: null
  })
}

interface ProgressInfo {
  task: 'architect' | 'dry-run'
  via: string
  startedAt: number
  prose: string
  writingDiagram: boolean
  counts: { boxes: number; contracts: number; actors: number; journeys: number; steps: number }
  chars: number
  note: string
}

/** Live view of a design request: who is answering, for how long, and what it has written so far. */
function DesignProgress({ fallback }: { fallback: string }) {
  const [p, setP] = useState<ProgressInfo | null>(null)
  const [, tick] = useState(0)
  useEffect(() => window.viber.on('design:progress', (x: ProgressInfo | null) => setP(x)), [])
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [])
  if (!p)
    return (
      <p className="muted small">
        <Loader2 size={12} className="spin" /> {fallback}
      </p>
    )
  const secs = Math.round((Date.now() - p.startedAt) / 1000)
  const time = secs >= 60 ? `${Math.floor(secs / 60)} min ${secs % 60}s` : `${secs}s`
  const c = p.counts
  const parts =
    p.task === 'dry-run'
      ? [c.steps && `${c.steps} step${c.steps > 1 ? 's' : ''}`]
      : [c.boxes && `${c.boxes} component${c.boxes > 1 ? 's' : ''}`, c.contracts && `${c.contracts} contract${c.contracts > 1 ? 's' : ''}`, c.actors && `${c.actors} actor${c.actors > 1 ? 's' : ''}`, c.journeys && `${c.journeys} journe${c.journeys > 1 ? 'ys' : 'y'}`]
  const so = parts.filter(Boolean).join(', ')
  const status = !p.chars ? (p.note === 'thinking' ? 'thinking it through' : p.note ? 'reasoning' : 'reading the design') : p.writingDiagram ? `drawing the diagram${so ? `: ${so} so far` : ''}` : 'writing its answer'
  return (
    <div className="design-progress">
      <p className="small">
        <Loader2 size={12} className="spin" /> <strong>{p.via}</strong> is {status} <span className="muted">· {time}</span>
      </p>
      {p.note && p.note !== 'thinking' && !p.chars && <p className="muted small progress-text">{p.note}</p>}
      {p.prose.trim() && <p className="small progress-text">{p.prose.trim()}</p>}
    </div>
  )
}

/** The design check, with a one-click request to the architect for the gaps. */
function DesignCheck() {
  const model = useModel()
  if (!model.nodes.some((n) => n.kind === 'box' && !n.proposed)) return null
  const items = designCheck(model)
  const bad = items.filter((i) => !i.ok)
  return (
    <section>
      <h3>
        <ListChecks size={13} /> Design check {bad.length ? `(${bad.length} to fix)` : '· ready to build'}
      </h3>
      {items.map((i) => (
        <div key={i.id} className={`check-row-item ${i.ok ? 'is-ok' : 'is-bad'}`} onClick={() => i.ids?.length && useStore.getState().setHighlight(i.ids)}>
          {i.ok ? <Check size={12} /> : <CircleAlert size={12} />}
          <span>
            {i.title}
            {i.detail && <span className="muted small"> {i.detail}</span>}
          </span>
        </div>
      ))}
      {bad.length > 0 && (
        <button className="btn small" onClick={() => void askArchitect(gapsAsRequest(items))}>
          <Sparkles size={12} /> Ask the architect to fix these
        </button>
      )}
    </section>
  )
}

export function playJourney(j: Journey): void {
  useStore.setState({
    explain: { actor: j.actor, path: [j.actor, ...j.steps.map((s) => s.box)], i: 0, title: j.name, actions: ['starts the journey', ...j.steps.map((s) => s.action)] },
    playing: true,
    history: null,
    actorFocus: null
  })
}


function describeOp(o: DefsOp): string {
  switch (o.op) {
    case 'addBox':
      return `+ component ${o.label}${o.parent ? ` in ${o.parent}` : ''}`
    case 'setSpec':
      return `✎ spec of ${o.id}: ${Object.keys(o.spec).join(', ')}`
    case 'upsertEdge':
      return `+ contract ${o.edge.from} → ${o.edge.to}${o.edge.uses.length ? ` (${o.edge.uses.slice(0, 2).join(', ')})` : ''}`
    case 'upsertActor':
      return `+ actor ${o.actor.label}`
    case 'upsertJourney':
      return `+ journey ${o.journey.name}`
    case 'rename':
      return `✎ rename ${o.id} → ${o.label}`
    case 'remove':
      return `− remove ${o.id}`
    case 'setRules':
      return `✎ rules of ${o.id}`
    case 'upsertGuardrail':
      return `+ guardrail ${o.guardrail.from} ↛ ${o.guardrail.to}`
    default:
      return o.op
  }
}

export function DesignPanel() {
  const turns = useStore((s) => s.archTurns)
  const busy = useStore((s) => s.archBusy)
  const error = useStore((s) => s.archError)
  const preview = useStore((s) => s.preview)
  const questions = useStore((s) => s.questions)
  const model = useModel()
  const snapshotModel = useStore((s) => s.snapshot?.model)
  const { setModal, select } = useStore.getState()
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' })
  }, [turns, busy])

  const decide = (i: number, accept: boolean): void => void decideProposal(i, accept)

  const [scenario, setScenario] = useState('')
  const [dry, setDry] = useState<string | null>(null)
  const [dryError, setDryError] = useState<string | null>(null)
  const runDry = async (input: { journeyId?: string; scenario?: string }): Promise<void> => {
    setDry(input.journeyId ?? 'scenario')
    setDryError(null)
    try {
      const r = await window.viber.invoke<DryRunResult>('design:dryRun', input)
      startDryRun(r, input.journeyId ? undefined : r)
    } catch (e) {
      setDryError(String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    } finally {
      setDry(null)
    }
  }

  const open = questions.filter((q) => !q.answer)
  const acps = useStore((s) => s.acps)
  const pendingAcps = acps.filter((a) => a.status === 'pending')
  const recentAcps = acps.filter((a) => a.status !== 'pending').slice(-3).reverse()
  const drift = (snapshotModel?.drift ?? []) as DriftItem[]
  const journeys = model.journeys ?? []
  const journeyResults = useStore((s) => s.journeyResults)
  const label = (id: string): string => model.nodes.find((n) => n.id === id)?.label ?? id
  // Accept what the code does today as the design (one click instead of one item at a time).
  const adopt = (r: DriftRow): void => {
    if (r.kind === 'undeclared-route') {
      const contract = model.nodes.find((n) => n.id === r.source)?.spec?.contract ?? []
      const routes = r.items.map((d) => d.detail.match(/ serves (.+), which is not/)?.[1]).filter((x): x is string => !!x)
      void window.viber.invoke('ws:apply', { op: 'setSpec', id: r.source, spec: { contract: [...contract, ...routes.map((name) => ({ kind: 'http' as const, name }))] } })
    } else {
      const ops = r.items.filter((d) => d.target).map((d) => ({ op: 'upsertEdge' as const, edge: { id: `${d.source}->${d.target}`, from: d.source, to: d.target!, kind: 'call' as const, uses: [] } }))
      void window.viber.invoke('ws:apply', { op: 'batch', ops })
    }
  }

  return (
    <div className="design-panel">
      {(pendingAcps.length > 0 || recentAcps.length > 0) && (
        <section>
          <h3>
            <FileDiff size={13} /> Contract changes {pendingAcps.length ? `(${pendingAcps.length} waiting)` : ''}
          </h3>
          {pendingAcps.map((a) => (
            <AcpCard key={a.id} acp={a} label={label} />
          ))}
          {recentAcps.map((a) => (
            <AcpCard key={a.id} acp={a} label={label} />
          ))}
        </section>
      )}

      {open.length > 0 && (
        <section>
          <h3>
            <MessageCircleQuestion size={13} /> Questions for you ({open.length})
          </h3>
          {open.map((q) => (
            <QuestionCard key={q.id} q={q} label={label} />
          ))}
        </section>
      )}

      <section className="architect">
        <h3>
          <Sparkles size={13} /> Architect
        </h3>
        <div className="chat" ref={listRef}>
          {turns.length === 0 && (
            <p className="muted small">
              Describe what to build or change in the bar at the bottom, in <strong>Design</strong> mode: “Add billing: invoices per
              harvest, paid with Stripe, emailed to the customer”. The architect proposes components, contracts, actors and journeys as
              a diagram diff; you accept or reject it here.
            </p>
          )}
          {turns.map((t, i) => (
            <div key={i} className={`chat-turn ${t.role}`}>
              <p className="pre">{t.text}</p>
              {t.ops && t.ops.length > 0 && (
                <div className={`diff-card ${t.status ?? ''}`}>
                  <ul>
                    {t.ops.map((o, j) => (
                      <li key={j} className="mono small">
                        {describeOp(o)}
                      </li>
                    ))}
                  </ul>
                  {t.status === 'previewing' && preview && (
                    <div className="card-actions">
                      <span className="muted small">Previewing on the map (dashed = new)</span>
                      <button className="btn small" onClick={() => decide(i, false)}>
                        <X size={12} /> Reject
                      </button>
                      <button className="btn small primary" onClick={() => decide(i, true)}>
                        <Check size={12} /> Accept
                      </button>
                    </div>
                  )}
                  {t.status === 'accepted' && <p className="ok small">Accepted and saved to the model.</p>}
                  {t.status === 'rejected' && <p className="muted small">Not applied.</p>}
                </div>
              )}
            </div>
          ))}
          {busy && <DesignProgress fallback="Thinking about the architecture…" />}
          {error && (
            <div className="bad small">
              <p>{error.replace(/^NO_AGENT: /, '')}</p>
              {/NO_AGENT|not signed in|sign in|api key|authenticat/i.test(error) && (
                <button className="btn small" onClick={() => useStore.getState().setModal({ kind: 'agents' })}>
                  Connect agents
                </button>
              )}
            </div>
          )}
        </div>
        <p className="muted small chat-hint">Talk to the architect from the bar at the bottom (Design).</p>
      </section>

      <section>
        <h3>
          <Route size={13} /> Journeys
        </h3>
        {journeys.map((j) => (
          <div key={j.id} className="list-row" onClick={() => setModal({ kind: 'journey', id: j.id })}>
            <button
              className="icon-btn tiny play-journey"
              title="Play this journey on the map"
              onClick={(e) => {
                e.stopPropagation()
                playJourney(j)
              }}
            >
              <Play size={11} />
            </button>
            <button
              className="icon-btn tiny"
              title="Dry run: what crosses each contract, and what the design is missing"
              disabled={!!dry}
              onClick={(e) => {
                e.stopPropagation()
                void runDry({ journeyId: j.id })
              }}
            >
              {dry === j.id ? <Loader2 size={11} className="spin" /> : <FlaskConical size={11} />}
            </button>
            <span className="list-label">
              {label(j.actor)}: {j.name}
            </span>
            <JourneyTestBadge result={journeyResults[j.id]} />
          </div>
        ))}
        {journeys.length > 0 && <JourneyTests journeys={journeys} results={journeyResults} />}
        {model.nodes.some((n) => n.kind === 'box' && !n.proposed) && (
          <div className="row-gap scenario-row">
            <input className="edit-input" value={scenario} placeholder="Try a scenario, e.g. a player casts Fireball at two goblins" onChange={(e) => setScenario(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && scenario.trim() && void runDry({ scenario: scenario.trim() })} />
            <button className="btn small" disabled={!scenario.trim() || !!dry} onClick={() => void runDry({ scenario: scenario.trim() })} title="Dry-run it through the design">
              {dry === 'scenario' ? <Loader2 size={12} className="spin" /> : <FlaskConical size={12} />} Dry run
            </button>
          </div>
        )}
        {dry && <DesignProgress fallback="Running the scenario through the design…" />}
        {dryError && <p className="bad small">{dryError.replace(/^NO_AGENT: /, '')}</p>}
        {journeys.length === 0 && (
          <p className="muted small">
            Paths actors take through the boxes, step by step. They check the design before anything is built, and once their boxes are built
            each one becomes an end-to-end test on the real code.
          </p>
        )}
        <button className="btn small ghost" onClick={() => setModal({ kind: 'journey' })}>
          <Plus size={12} /> Add journey
        </button>
      </section>

      <DesignCheck />

      <section>
        <h3>
          <Ruler size={13} /> Code style
        </h3>
        <p className="muted small">Checked on every box (a box can override it in its spec). Agents get these rules in their context.</p>
        <StyleFields style={model.style ?? {}} onChange={(style) => void window.viber.invoke('ws:apply', { op: 'setStyle', style })} />
      </section>

      <section>
        <h3>
          <CircleAlert size={13} /> Drift ({drift.length})
        </h3>
        {drift.length === 0 && <p className="muted small">The code matches the design (designed contracts, routes, dependencies).</p>}
        {driftRows(drift).slice(0, 30).map((r, i) =>
          r.group ? (
            <div key={i} className={`drift-row drift-${r.kind}`} onClick={() => select({ kind: 'node', id: r.source })}>
              <span className="drift-kind">{r.kind.replace(/-/g, ' ')}</span>
              <span className="small">
                {r.kind === 'undeclared-route'
                  ? `${label(r.source)} serves ${r.items.length} routes that are not in its contract.`
                  : r.kind === 'style'
                    ? `${label(r.source)}: ${r.items.length} functions break the code style (${r.items[0].detail}…)`
                    : `${label(r.source)} depends on ${r.items.length} boxes that are not in the design.`}
              </span>
              {r.kind !== 'style' && (
                <button className="link-btn small" onClick={(e) => (e.stopPropagation(), adopt(r))}>
                  {r.kind === 'undeclared-route' ? 'Add them to the contract' : 'Add them to the design'}
                </button>
              )}
            </div>
          ) : (
            <div key={i} className={`drift-row drift-${r.kind}`} onClick={() => select({ kind: 'node', id: r.source })}>
              <span className="drift-kind">{r.kind.replace(/-/g, ' ')}</span>
              <span className="small">{r.items[0].detail}</span>
            </div>
          )
        )}
      </section>
    </div>
  )
}

interface DriftRow {
  kind: DriftItem['kind']
  source: string
  items: DriftItem[]
  group: boolean
}

const DRIFT_ORDER: DriftItem['kind'][] = ['contract-mismatch', 'undeclared-effect', 'missing-route', 'missing-dependency', 'out-of-scope', 'undeclared-event', 'undeclared-dependency', 'undeclared-route', 'style']

/** Most important first; many undeclared routes or dependencies of one box fold into one row. */
function driftRows(drift: DriftItem[]): DriftRow[] {
  const rows: DriftRow[] = []
  for (const d of drift) {
    const foldable = d.kind === 'undeclared-route' || d.kind === 'undeclared-dependency' || d.kind === 'style'
    const row = foldable ? rows.find((r) => r.kind === d.kind && r.source === d.source) : undefined
    if (row) (row.items.push(d), (row.group = true))
    else rows.push({ kind: d.kind, source: d.source, items: [d], group: false })
  }
  return rows.sort((a, b) => DRIFT_ORDER.indexOf(a.kind) - DRIFT_ORDER.indexOf(b.kind))
}

function AcpCard({ acp, label }: { acp: Acp; label: (id: string) => string }) {
  const [feedback, setFeedback] = useState('')
  const [started, setStarted] = useState<number | null>(null)
  const { select } = useStore.getState()
  const pending = acp.status === 'pending'
  return (
    <div className={`acp-card ${acp.status}`}>
      <div className="acp-head" onClick={() => select({ kind: 'node', id: acp.box })}>
        <strong>{label(acp.box)}</strong>
        {acp.consumer && <span className="muted small">requested for {label(acp.consumer)}</span>}
        <span className={`acp-status ${acp.status}`}>{acp.status}</span>
      </div>
      <ul className="contract">
        {acp.remove.map((r) => (
          <li key={'-' + r} className="del">
            {r}
          </li>
        ))}
        {acp.add.map((a) => (
          <li key={'+' + a} className="add">
            {a}
          </li>
        ))}
      </ul>
      <p className="small">{acp.reason}</p>
      {acp.consumers && acp.consumers.length > 0 && <p className="muted small">Also used by: {acp.consumers.map(label).join(', ')}</p>}
      {pending ? (
        <>
          <input className="edit-input" value={feedback} placeholder="Feedback if you reject (optional)" onChange={(e) => setFeedback(e.target.value)} />
          <div className="card-actions">
            <button className="btn small" onClick={() => void window.viber.invoke('acp:decide', acp.id, false, feedback)}>
              <X size={12} /> Reject
            </button>
            <button className="btn small primary" onClick={() => void window.viber.invoke('acp:decide', acp.id, true)}>
              <Check size={12} /> Approve change
            </button>
          </div>
        </>
      ) : (
        acp.status === 'approved' &&
        (acp.consumers?.length ?? 0) > (acp.followUps?.length ?? 0) && (
          <div className="card-actions">
            <button className="btn small" onClick={() => void window.viber.invoke<string[]>('acp:followUps', acp.id).then((s) => setStarted(s.length))}>
              Update {acp.consumers!.length} consumer{acp.consumers!.length > 1 ? 's' : ''}
            </button>
            {started !== null && <span className="muted small">{started} task(s) started</span>}
          </div>
        )
      )}
      {acp.feedback && <p className="muted small">Feedback: {acp.feedback}</p>}
    </div>
  )
}

function QuestionCard({ q, label }: { q: Question; label: (id: string) => string }) {
  const [answer, setAnswer] = useState('')
  const [asRule, setAsRule] = useState(true)
  const send = (a: string): void => void window.viber.invoke('questions:answer', q.id, a, asRule && !!q.anchor)
  return (
    <div className="question-card">
      {q.anchor && <span className="chip">{label(q.anchor)}</span>}
      <p>{q.text}</p>
      {q.options && q.options.length > 0 && (
        <div className="chips">
          {q.options.map((o) => (
            <button key={o} className="chip chip-link" onClick={() => send(o)}>
              {o}
            </button>
          ))}
        </div>
      )}
      <div className="row-gap">
        <input className="edit-input" value={answer} placeholder="Your answer" onChange={(e) => setAnswer(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && answer.trim() && send(answer.trim())} />
        <button className="btn small primary" disabled={!answer.trim()} onClick={() => send(answer.trim())}>
          Answer
        </button>
        <button className="icon-btn tiny" title="Dismiss" onClick={() => void window.viber.invoke('questions:dismiss', q.id)}>
          <X size={11} />
        </button>
      </div>
      {q.anchor && (
        <label className="check small">
          <input type="checkbox" checked={asRule} onChange={(e) => setAsRule(e.target.checked)} /> Keep the answer as a rule on {label(q.anchor)}
        </label>
      )}
    </div>
  )
}

const BADGE: Record<JourneyTestResult['status'], { text: string; cls: string; title: string }> = {
  pass: { text: '✓ test passes', cls: 'ok', title: 'Its end-to-end test passed on the last run.' },
  fail: { text: '✗ test fails', cls: 'bad', title: 'Its end-to-end test failed on the last run.' },
  missing: { text: 'no test', cls: '', title: 'No end-to-end test yet. One is written once all its boxes are built.' },
  notrun: { text: 'not run', cls: '', title: 'It has a test that has not run yet.' },
  blocked: { text: 'not run', cls: 'bad', title: 'Viber could not run its test.' },
  writing: { text: 'writing test…', cls: '', title: 'An agent is writing its end-to-end test.' }
}

/** Where a journey's end-to-end test stands. */
function JourneyTestBadge({ result }: { result?: JourneyTestResult }) {
  const b = BADGE[result?.status ?? 'missing']
  return (
    <span className={`tree-meta ${b.cls}`} title={[b.title, result?.file, result?.failures?.[0]].filter(Boolean).join('\n')}>
      {b.text}
    </span>
  )
}

/** Journeys as tests of the real code: write the missing ones, run them, see what broke. */
function JourneyTests({ journeys, results }: { journeys: Journey[]; results: Record<string, JourneyTestResult> }) {
  const model = useModel()
  const agent = useStore((s) => s.agent)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const built = (j: Journey): boolean =>
    j.steps.length > 0 &&
    j.steps.every((s) => {
      const n = model.nodes.find((x) => x.id === s.box)
      return !!n && (n.spec?.status ? n.spec.status === 'built' || n.spec.status === 'verified' : n.files.length > 0)
    })
  const status = (j: Journey): JourneyTestResult['status'] => results[j.id]?.status ?? 'missing'
  const withTest = journeys.filter((j) => !['missing', 'writing'].includes(status(j)))
  const toWrite = journeys.filter((j) => status(j) === 'missing' && built(j))
  const failing = journeys.filter((j) => ['fail', 'blocked'].includes(status(j)))
  const strip = (e: unknown): string => String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
  const run = async (): Promise<void> => {
    setBusy('run')
    setError(null)
    try {
      await window.viber.invoke('journeys:run')
    } catch (e) {
      setError(strip(e))
    } finally {
      setBusy(null)
    }
  }
  const write = async (j: Journey): Promise<void> => {
    setBusy(j.id)
    setError(null)
    try {
      const id = await window.viber.invoke<string>('journeys:write', j.id, agent === 'external' ? 'claude-code' : agent)
      void useStore.getState().setActiveSession(id)
    } catch (e) {
      setError(strip(e))
    } finally {
      setBusy(null)
    }
  }
  if (!withTest.length && !toWrite.length) return null
  return (
    <div className="journey-tests">
      {failing.map((j) => (
        <div key={j.id} className="journey-failure small">
          <span className="bad">{j.name}</span>
          {(results[j.id]?.failures ?? []).slice(0, 3).map((l, i) => (
            <code key={i} className="block">
              {l}
            </code>
          ))}
        </div>
      ))}
      {toWrite.map((j) => (
        <button key={j.id} className="btn small" disabled={!!busy} onClick={() => void write(j)} title="An agent writes one test that plays this journey through the real code of its boxes">
          {busy === j.id ? <Loader2 size={12} className="spin" /> : <TestTube2 size={12} />} Write the test for “{j.name}”
        </button>
      ))}
      {withTest.length > 0 && (
        <button className="btn small" disabled={!!busy} onClick={() => void run()}>
          {busy === 'run' ? <Loader2 size={12} className="spin" /> : <Play size={12} />} Run journey tests ({withTest.length})
        </button>
      )}
      {error && <p className="bad small">{error}</p>}
    </div>
  )
}
