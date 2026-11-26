import { useEffect, useRef, type ReactNode } from 'react'
import {
  Bot,
  Check,
  CircleCheck,
  CircleX,
  FilePlus,
  FileCode,
  FlaskConical,
  ListChecks,
  Megaphone,
  PackagePlus,
  Pause,
  Play,
  RotateCcw,
  Shield,
  SkipForward,
  Sparkles,
  TriangleAlert,
  Undo2,
  User,
  Wrench
} from 'lucide-react'
import { SessionSwitcher } from './SessionSwitcher'
import { useEvents, useSim, useStore } from '../store'
import { AGENT_NAME, type SimEvent } from '../sim/scenario'
import type { SimState } from '../sim/reducer'
import { Delta, fmtK } from './common'

export function SessionPanel({ embedded }: { embedded?: boolean } = {}) {
  const sim = useSim()
  const step = useStore((s) => s.step)
  const playing = useStore((s) => s.playing)
  const speed = useStore((s) => s.speed)
  const mode = useStore((s) => s.mode)
  const { togglePlay, stepForward, reset, setSpeed, seek } = useStore.getState()
  const events = useEvents()
  const applied = events.slice(0, step)
  const feed = useRef<HTMLDivElement>(null)

  // Follow the session: keep the current event in view.
  useEffect(() => {
    const el = feed.current
    if (!el) return
    if (playing) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
    else el.querySelector('.feed-card.current')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [step, sim, playing])

  return (
    <aside className={`session ${embedded ? 'embedded' : ''}`}>
      <div className="panel-head">
        <span className="panel-title">{embedded ? (events.length ? `${events.length} events` : 'No session yet') : 'Session'}</span>
        <div className="transport">
          <button className="icon-btn" onClick={togglePlay} title={playing ? 'Pause' : 'Play'} disabled={step >= events.length}>
            {playing ? <Pause size={14} /> : <Play size={14} />}
          </button>
          <button className="icon-btn" onClick={stepForward} title="Step" disabled={step >= events.length || sim.phase === 'awaitApproval'}>
            <SkipForward size={14} />
          </button>
          <button className="icon-btn" onClick={reset} title="Reset">
            <RotateCcw size={14} />
          </button>
          <div className="speed">
            {([1, 2, 4] as const).map((s) => (
              <button key={s} className={speed === s ? 'on' : ''} onClick={() => setSpeed(s)}>
                {s}×
              </button>
            ))}
          </div>
        </div>
      </div>

      {mode === 'workspace' && <SessionSwitcher />}
      <div className="timeline">
        <input
          type="range"
          min={0}
          max={events.length}
          value={step}
          onChange={(e) => seek(Number(e.target.value))}
          aria-label="Session timeline"
        />
        <span className="timeline-count">
          {step}/{events.length}
        </span>
      </div>

      <div className="feed" ref={feed}>
        {step === 0 && mode === 'workspace' && (
          <div className="feed-empty">
            <Sparkles size={18} />
            <p>
              Select boxes on the map, describe a change and press <strong>Run</strong>.
            </p>
            <p className="muted">
              The agent works in your repo. Every file it touches lights up its box, edits outside the plan are flagged,
              and you review the result box by box.
            </p>
          </div>
        )}
        {step === 0 && mode === 'demo' && (
          <div className="feed-empty">
            <Sparkles size={18} />
            <p>
              Pick boxes on the map, describe a change and press <strong>Run</strong>.
            </p>
            <p className="muted">
              Viber builds a context pack from the selection, the agent announces its intent and proposes a plan as a diagram
              diff, then works inside that fence while the map lights up.
            </p>
          </div>
        )}
        {applied.map((ev, i) => (
          <FeedItem key={ev.id} ev={ev} sim={sim} current={i === step - 1} onSeek={() => seek(i + 1)} />
        ))}
      </div>
    </aside>
  )
}

function Card({
  icon,
  title,
  tone,
  current,
  onSeek,
  children
}: {
  icon: ReactNode
  title: ReactNode
  tone?: string
  current: boolean
  onSeek: () => void
  children?: ReactNode
}) {
  return (
    <div className={`feed-card ${tone ?? ''} ${current ? 'current' : ''}`} onClick={onSeek}>
      <div className="feed-card-head">
        <span className="feed-icon">{icon}</span>
        <span className="feed-title">{title}</span>
      </div>
      {children && <div className="feed-body">{children}</div>}
    </div>
  )
}

function FeedItem({ ev, sim, current, onSeek }: { ev: SimEvent; sim: SimState; current: boolean; onSeek: () => void }) {
  const { approvePlan, rejectPlan, resolveWarning, resolveCandidate, openCode } = useStore.getState()
  // A plan card is live only while its session waits; later answers are refused by the main process.
  const live = useStore((s) => s.mode === 'workspace')
  const status = useStore((s) => s.sessions.find((x) => x.id === s.activeSession)?.status)
  const events = useEvents()
  const later = events.slice(events.findIndex((e) => e.id === ev.id) + 1)
  const planState: 'rejected' | 'expired' | null =
    ev.t !== 'approval' || !live ? null
    : later.some((e) => e.t === 'message' && e.role === 'user' && /^Plan rejected/.test(e.text)) ? 'rejected'
    : status && ['done', 'error', 'stopped'].includes(status) ? 'expired'
    : null
  const mode = useStore((s) => s.mode)
  const label = (id: string): string => sim.nodes.find((n) => n.id === id)?.label ?? id
  const chips = (ids: string[], cls = ''): ReactNode => (
    <div className="chips">
      {ids.map((id) => (
        <span key={id} className={`chip ${cls}`}>
          {label(id)}
        </span>
      ))}
    </div>
  )
  const stop = (fn: () => void) => (e: React.MouseEvent) => {
    e.stopPropagation()
    fn()
  }
  const p = { current, onSeek }

  switch (ev.t) {
    case 'task':
      return (
        <Card icon={<User size={14} />} title="You" tone="you" {...p}>
          <p className="quote">{ev.prompt}</p>
          {chips(ev.scope, 'chip-scope')}
        </Card>
      )
    case 'context': {
      const total = ev.items.reduce((a, i) => a + i.tokens, 0)
      return (
        <Card icon={<PackagePlus size={14} />} title={`Context pack · ${fmtK(total)} tokens`} {...p}>
          <ul className="ctx-list">
            {ev.items.map((it) => (
              <li key={it.label}>
                <span>
                  {it.label}
                  <small>{it.detail}</small>
                </span>
                <span className="mono">{fmtK(it.tokens)}</span>
              </li>
            ))}
          </ul>
          <p className="muted small">
            Exploring without Viber: ≈ {fmtK(ev.naive)} tokens ({ev.naiveNote})
          </p>
        </Card>
      )
    }
    case 'intent':
      return (
        <Card icon={<Megaphone size={14} />} title={`${ev.agent} · intent (MCP)`} tone="intent" {...p}>
          <p>{ev.summary}</p>
          {chips(ev.nodes, 'chip-intent')}
        </Card>
      )
    case 'plan':
      return (
        <Card icon={<ListChecks size={14} />} title="Plan · diagram diff" tone="plan" {...p}>
          <ol className="plan-steps">
            {ev.steps.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ol>
          <p className="muted small">
            +{ev.addNodes.length} box · +{ev.addEdges.length} edges · {Object.keys(ev.edgeChanges).length} contracts change
          </p>
          <div className="fence-line">
            <Shield size={12} /> Fence:
          </div>
          {chips(ev.fence, 'chip-fence')}
        </Card>
      )
    case 'approval':
      return sim.planApproved ? (
        <Card icon={<Check size={14} />} title="Plan approved" tone="ok" {...p} />
      ) : planState === 'rejected' ? (
        <Card icon={<CircleX size={14} />} title="Plan rejected" tone="intent" {...p}>
          <p className="muted small">The agent will revise it and propose again.</p>
        </Card>
      ) : planState === 'expired' ? (
        <Card icon={<CircleX size={14} />} title="Plan no longer waiting" tone="intent" {...p}>
          <p className="muted small">The agent stopped before you decided. Start the task again from the prompt bar.</p>
        </Card>
      ) : (
        <Card icon={<ListChecks size={14} />} title="Waiting for your approval" tone="intent" {...p}>
          <div className="card-actions">
            <button className="btn small" onClick={stop(() => rejectPlan())}>
              Reject
            </button>
            <button className="btn small primary" onClick={stop(approvePlan)}>
              Approve plan
            </button>
          </div>
        </Card>
      )
    case 'edit': {
      const f = sim.files[ev.file]
      const warning = sim.warnings.find((w) => w.eventId === ev.id)
      const cand = sim.candidates.find((c) => c.eventId === ev.id)
      const owner = f?.nodeId ?? warning?.nodeId
      return (
        <>
          <Card
            icon={f?.created ? <FilePlus size={14} /> : <FileCode size={14} />}
            title={<span className="mono">{ev.file}</span>}
            {...p}
          >
            <div className="edit-line">
              {f ? <Delta added={f.added} removed={f.removed} /> : <span className="muted small">reverted</span>}
              {owner && (
                <button className="chip chip-link" onClick={stop(() => openCode(owner, ev.file))}>
                  → {label(owner)}
                </button>
              )}
            </div>
            <p className="muted small">{ev.note}</p>
          </Card>
          {warning && (
            <div className={`feed-alert ${warning.resolution ? 'resolved' : ''}`}>
              <div className="feed-card-head">
                <TriangleAlert size={14} />
                <span className="feed-title">Outside the fence</span>
              </div>
              <p className="small">
                {label(warning.nodeId)} is not part of the approved plan.
                {warning.resolution === 'revert' && ' Reverted.'}
                {warning.resolution === 'allow' && ' Allowed and added to the fence.'}
              </p>
              {!warning.resolution && (
                <div className="card-actions">
                  <button className="btn small" onClick={stop(() => resolveWarning(ev.id, 'allow'))}>
                    Allow
                  </button>
                  <button className="btn small danger" onClick={stop(() => resolveWarning(ev.id, 'revert'))}>
                    <Undo2 size={12} /> Revert
                  </button>
                </div>
              )}
            </div>
          )}
          {cand && (
            <div className={`feed-alert candidate ${cand.resolution ? 'resolved' : ''}`}>
              <div className="feed-card-head">
                <Sparkles size={14} />
                <span className="feed-title">Unmapped file → new box candidate</span>
              </div>
              <p className="small">
                {cand.resolution === 'attach'
                  ? `Attached to ${label(cand.attachTo)}.`
                  : cand.resolution === 'create'
                    ? `Created box “${label(cand.nodeId)}”.`
                    : cand.reason}
              </p>
              {!cand.resolution && (
                <div className="card-actions">
                  <button className="btn small" onClick={stop(() => resolveCandidate(ev.id, 'attach'))}>
                    Attach to {label(cand.attachTo)}
                  </button>
                  <button className="btn small primary" onClick={stop(() => resolveCandidate(ev.id, 'create'))}>
                    Create box
                  </button>
                </div>
              )}
            </div>
          )}
        </>
      )
    }
    case 'tests': {
      const passed = Object.values(ev.results).reduce((a, r) => a + r.passed, 0)
      const failed = Object.values(ev.results).reduce((a, r) => a + r.failed, 0)
      return (
        <Card
          icon={<FlaskConical size={14} />}
          title={`Tests · ${passed} passed${failed ? ` · ${failed} failed` : ''}`}
          tone={failed ? 'bad' : 'ok'}
          {...p}
        >
          <p className="small">
            Ran {ev.selected} of {ev.total} tests, picked from the symbol graph (impact analysis).
          </p>
          {ev.failures.map((f) => (
            <p key={f} className="failure">
              <CircleX size={12} /> {f}
            </p>
          ))}
          {!failed && (
            <p className="ok small">
              <CircleCheck size={12} /> All affected tests green
            </p>
          )}
        </Card>
      )
    }
    case 'done':
      return (
        <Card icon={<Bot size={14} />} title={mode === 'demo' ? `${AGENT_NAME} · done` : 'Session finished'} tone="ok" {...p}>
          <p className="pre">{ev.summary}</p>
        </Card>
      )
    case 'message':
      return (
        <Card icon={ev.role === 'agent' ? <Bot size={14} /> : ev.role === 'user' ? <User size={14} /> : <Sparkles size={14} />} title={ev.role === 'agent' ? 'Agent' : ev.role === 'user' ? 'You' : 'Viber'} tone={ev.role === 'user' ? 'you' : ''} {...p}>
          <p className="pre clamp">{ev.text}</p>
          {ev.tokens > 0 && <p className="muted small">{fmtK(ev.tokens)} tokens</p>}
        </Card>
      )
    case 'tool':
      return (
        <div className={`feed-tool ${current ? 'current' : ''}`} onClick={onSeek}>
          <Wrench size={11} /> <span className="mono">{ev.name}</span> <span className="muted mono">{ev.detail}</span>
        </div>
      )
    case 'error':
      return (
        <Card icon={<TriangleAlert size={14} />} title="Error" tone="bad" {...p}>
          <p className="pre clamp">{ev.text.replace(/^NO_AGENT: /, '')}</p>
          {/NO_AGENT|not signed in/i.test(ev.text) && (
            <button className="btn small" onClick={() => useStore.getState().setModal({ kind: 'agents' })}>
              Connect agents
            </button>
          )}
        </Card>
      )
    case 'contracts': {
      const n = Object.keys(ev.changes).length
      return (
        <Card icon={<FileCode size={14} />} title={`${n} contract${n === 1 ? '' : 's'} changed`} tone="plan" {...p}>
          {Object.entries(ev.changes)
            .slice(0, 4)
            .map(([id, c]) => {
              const [a, b] = id.split('->')
              return (
                <div key={id} className="small">
                  <span className="muted">
                    {label(a)} → {label(b)}
                  </span>
                  <ul className="contract">
                    {c.removed.slice(0, 3).map((x) => (
                      <li key={'-' + x} className="del">
                        {x}
                      </li>
                    ))}
                    {c.added.slice(0, 3).map((x) => (
                      <li key={'+' + x} className="add">
                        {x}
                      </li>
                    ))}
                  </ul>
                </div>
              )
            })}
        </Card>
      )
    }
    case 'runtime':
      return (
        <Card icon={<TriangleAlert size={14} />} title={`Runtime ${ev.level}`} tone={ev.level === 'error' ? 'bad' : ''} {...p}>
          <p className="pre clamp small">{ev.text}</p>
          {chips(ev.boxes, 'chip-intent')}
        </Card>
      )
  }
}
