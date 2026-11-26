import { useMemo, useState } from 'react'
import { DiffEditor, Editor } from '@monaco-editor/react'
import {
  ArrowRight,
  Check,
  Code,
  CornerLeftUp,
  Crosshair,
  FlaskConical,
  GitCommitHorizontal,
  Maximize2,
  Minimize2,
  Pencil,
  Plus,
  Shield,
  ShieldAlert,
  Trash2, Package,
  Undo2,
  X
} from 'lucide-react'
import { useModel, useSim, useStore } from '../store'
import { actorReach, buildView, descendants } from '../graph/view'
import { ancestors, inFence, type SimState } from '../sim/reducer'
import { languageOf } from '../model/code'
import type { ArchEdge, ArchModel, ArchNode } from '@shared/model'
import { basename, Delta, KindIcon, STATE_LABEL } from './common'
import { actorColor } from './colors'
import { apply, Editable } from './ModelPanel'
import { useFileText } from '../files'
import { useTheme } from '../theme'
import { SpecEditor } from './SpecEditor'

export function Inspector() {
  const tab = useStore((s) => s.tab)
  const setTab = useStore((s) => s.setTab)
  const selection = useStore((s) => s.selection)
  const sim = useSim()
  const [wide, setWide] = useState(false)
  const reviewCount = sim.touched.size

  return (
    // Code is hidden by default; when you ask for it, give it room.
    <aside className={`inspector ${wide || tab === 'code' ? 'wide' : ''}`}>
      <div className="panel-head tabs">
        <button className={tab === 'details' ? 'on' : ''} onClick={() => setTab('details')}>
          Details
        </button>
        <button className={tab === 'code' ? 'on' : ''} onClick={() => setTab('code')} disabled={selection?.kind !== 'node'}>
          <Code size={13} /> Code
        </button>
        <button className={tab === 'review' ? 'on' : ''} onClick={() => setTab('review')} disabled={reviewCount === 0}>
          Review {reviewCount > 0 && <span className="count">{reviewCount}</span>}
        </button>
        <span className="spacer" />
        <button className="icon-btn" title={wide ? 'Narrow' : 'Widen'} onClick={() => setWide(!wide)}>
          {wide ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
        </button>
      </div>
      <div className="inspector-body">
        {tab === 'details' && selection?.kind === 'node' && <NodeDetails id={selection.id} sim={sim} />}
        {tab === 'details' && selection?.kind === 'edge' && <EdgeDetails id={selection.id} sim={sim} />}
        {tab === 'details' && !selection && <Overview sim={sim} />}
        {tab === 'code' && selection?.kind === 'node' && <CodeView id={selection.id} sim={sim} />}
        {tab === 'review' && <Review sim={sim} />}
      </div>
    </aside>
  )
}

// ── helpers ──────────────────────────────────────────────────────────

function membersOf(sim: SimState, id: string): string[] {
  return [id, ...descendants(sim.nodes, id)]
}

function filesOf(sim: SimState, id: string): string[] {
  const members = membersOf(sim, id)
  const out = new Set<string>()
  for (const m of members) sim.nodes.find((n) => n.id === m)?.files.forEach((f) => out.add(f))
  for (const f of Object.values(sim.files)) if (f.nodeId && members.includes(f.nodeId)) out.add(f.path)
  return [...out]
}

function ContractLines({ edge, sim }: { edge: ArchEdge; sim: SimState }) {
  const ch = sim.edgeChanges[edge.id]
  const removed = new Set(ch?.removed ?? [])
  const added = ch?.added ?? []
  return (
    <ul className="contract">
      {edge.contract
        .filter((c) => !added.includes(c))
        .map((c) => (
          <li key={c} className={removed.has(c) ? 'del' : ''}>
            {c}
          </li>
        ))}
      {added.map((c) => (
        <li key={c} className="add">
          {c}
        </li>
      ))}
      {edge.contract.length === 0 && added.length === 0 && <li className="muted">imports (no named symbols)</li>}
    </ul>
  )
}

const nodeLabel = (sim: SimState, id: string): string => sim.nodes.find((n) => n.id === id)?.label ?? id

// ── Overview (nothing selected) ──────────────────────────────────────

function Overview({ sim }: { sim: SimState }) {
  const mode = useStore((s) => s.mode)
  const snapshot = useStore((s) => s.snapshot)
  const model = useModel()
  const boxes = sim.nodes.filter((n) => n.kind === 'box').length
  const actors = sim.nodes.filter((n) => n.kind === 'actor')
  const services = sim.nodes.filter((n) => n.kind === 'external' || n.kind === 'datastore').length
  const { setActorFocus, setModal } = useStore.getState()
  return (
    <div className="details">
      <h2>{mode === 'demo' ? 'verdant' : snapshot?.name}</h2>
      <p className="muted">
        {mode === 'demo' ? 'Sample project · ' : ''}
        {boxes} boxes · {actors.length} actors · {services} services · {sim.edges.length} edges
      </p>
      {actors.length > 0 && (
        <>
          <h3>Who uses it</h3>
          {actors.map((a) => {
            const r = actorReach(sim, a.id)
            return (
              <div key={a.id} className="actor-row" onClick={() => setActorFocus(a.id)}>
                <i className="actor-dot" style={{ background: actorColor(model, a.id) }} />
                <strong>{a.label}</strong>
                <span className="muted small">
                  faces {sim.edges.filter((e) => e.source === a.id).length} · reaches {r.reach.size}
                </span>
                <Crosshair size={12} className="muted" />
              </div>
            )
          })}
        </>
      )}
      {mode === 'workspace' && (model.violations?.length ?? 0) > 0 && (
        <p className="violation-line">
          <ShieldAlert size={13} /> {model.violations!.length} guardrail violation{model.violations!.length > 1 ? 's' : ''} (red edges)
        </p>
      )}
      <h3>Using the map</h3>
      <ul className="tips">
        <li>Click a box, edge or actor to inspect it. Shift-click to add boxes to the prompt scope.</li>
        <li>Double-click a box with a stack icon to zoom into it.</li>
        <li>
          The <Code size={11} /> button on a box opens its code. Code stays hidden until you ask for it.
        </li>
        <li>Coloured dots on a box show which actors it faces. Pick an actor in the top bar to trace what they reach.</li>
        {mode === 'workspace' && (
          <li>
            <button className="linklike" onClick={() => setModal({ kind: 'locate' })}>
              Locate a bug
            </button>{' '}
            from a stack trace, or press Ctrl+K to search the map.
          </li>
        )}
      </ul>
    </div>
  )
}

// ── Node ─────────────────────────────────────────────────────────────

function NodeDetails({ id, sim }: { id: string; sim: SimState }) {
  const zoom = useStore((s) => s.zoom)
  const reviews = useStore((s) => s.reviews)
  const scope = useStore((s) => s.scope)
  const mode = useStore((s) => s.mode)
  const draft = useStore((s) => s.snapshot?.draft)
  const model = useModel()
  const { openCode, toggleScope, select, setZoom, setActorFocus, setModal } = useStore.getState()
  const node = sim.nodes.find((n) => n.id === id)
  const view = useMemo(() => buildView(sim, zoom, reviews).nodes.find((v) => v.id === id), [sim, zoom, reviews, id])
  if (!node) return <p className="muted pad">This box no longer exists at this point in the session.</p>
  const editable = mode === 'workspace'

  if (node.kind === 'actor') return <ActorDetails node={node} sim={sim} model={model} />

  const members = membersOf(sim, id)
  const children = sim.nodes.filter((n) => n.parent === id)
  const path = ancestors(sim.nodes, id).reverse().map((a) => nodeLabel(sim, a))
  const incoming = sim.edges.filter((e) => members.includes(e.target) && !members.includes(e.source))
  const outgoing = sim.edges.filter((e) => members.includes(e.source) && !members.includes(e.target))
  const changedFiles = Object.values(sim.files).filter((f) => f.nodeId && members.includes(f.nodeId))
  const symbols = members.flatMap((m) => sim.nodes.find((n) => n.id === m)?.symbols ?? [])
  const files = filesOf(sim, id)
  const fenced = sim.fence.length > 0 && inFence(sim, id)
  const facing = sim.nodes.filter((a) => a.kind === 'actor' && sim.edges.some((e) => e.source === a.id && [id, ...ancestors(sim.nodes, id)].includes(e.target)))
  const routes = node.routes ?? []

  return (
    <div className="details">
      {path.length > 0 && <div className="crumbs">{path.join(' / ')}</div>}
      <div className="details-title">
        <KindIcon node={node} container={children.length > 0} size={18} />
        <h2>{editable ? <Editable value={node.label} onSave={(label) => apply({ op: 'rename', id, label })} /> : node.label}</h2>
        {view && view.state !== 'idle' && <span className={`state-tag tag-${view.state}`}>{STATE_LABEL[view.state]}</span>}
        {node.proposed && <span className="state-tag tag-proposed">proposed</span>}
      </div>
      <p className="muted small">
        {kindText(node)}
        {node.tech && ` · ${node.tech}`}
        {node.stats && node.kind === 'box' && ` · ${node.stats.files} files · ${node.stats.lines.toLocaleString()} lines`}
        {fenced && (
          <span className="fence-badge">
            <Shield size={11} /> in fence
          </span>
        )}
      </p>
      {editable ? (
        <Editable value={node.purpose} multiline placeholder="Describe what this box is for" onSave={(purpose) => apply({ op: 'setPurpose', id, purpose })} className="purpose" />
      ) : (
        <p>{node.purpose}</p>
      )}
      {node.evidence && <p className="muted small">Detected from: {node.evidence.join(' · ')}</p>}

      {node.proposed && (
        <div className="proposal-actions">
          <button className="btn small primary" onClick={() => apply({ op: 'accept', id })}>
            <Check size={12} /> Accept
          </button>
          <button className="btn small" onClick={() => apply({ op: 'remove', id })}>
            <X size={12} /> Dismiss
          </button>
        </div>
      )}

      <div className="btn-row">
        {files.length > 0 && (
          <button className="btn small" onClick={() => openCode(id)}>
            <Code size={13} /> Show code
          </button>
        )}
        <button className="btn small" onClick={() => toggleScope(id)}>
          {scope.includes(id) ? <X size={13} /> : <Plus size={13} />} {scope.includes(id) ? 'Remove from scope' : 'Add to scope'}
        </button>
        {editable && node.kind === 'box' && node.parent && !draft && (
          <button className="btn small" title={`Merge into ${nodeLabel(sim, node.parent)}`} onClick={() => apply({ op: 'mergeInto', id, target: node.parent! })}>
            <CornerLeftUp size={13} />
          </button>
        )}
        {node.kind === 'box' && mode === 'workspace' && (
          <button className="btn small" title="Export as a reusable .box template (shift-click to include the code)" onClick={(e) => void exportBox(id, e.shiftKey)}>
            <Package size={13} />
          </button>
        )}
        {editable && !node.proposed && (
          <button className="btn small" title="Remove from the model" onClick={() => (apply({ op: 'remove', id }), select(null))}>
            <Trash2 size={13} />
          </button>
        )}
      </div>

      {facing.length > 0 && (
        <>
          <h3>Front-facing to</h3>
          <div className="chips">
            {facing.map((a) => (
              <button key={a.id} className="chip chip-link" onClick={() => setActorFocus(a.id)}>
                <i className="actor-dot" style={{ background: actorColor(model, a.id) }} />
                {a.label}
              </button>
            ))}
          </div>
        </>
      )}
      {editable && node.kind === 'box' && (
        <button className="linklike small" onClick={() => (useStore.setState({ actorDraft: null }), setModal({ kind: 'actor', preset: { reaches: [id] } }), useStore.setState({ scope: [id] }))}>
          + declare an actor that uses this box
        </button>
      )}

      {children.length > 0 && (
        <>
          <h3>Contains</h3>
          <div className="chips">
            {children.map((c) => (
              <button
                key={c.id}
                className={`chip chip-link ${sim.ghostNodes.has(c.id) ? 'chip-ghost' : ''}`}
                onClick={() => {
                  const depth = ancestors(sim.nodes, c.id).length + 1
                  if (depth > zoom) setZoom(Math.min(3, depth) as 2 | 3, id)
                  select({ kind: 'node', id: c.id })
                }}
              >
                {c.label}
              </button>
            ))}
          </div>
        </>
      )}

      {editable && node.kind === 'box' && <SpecEditor node={node} />}
      {editable && node.kind === 'box' && <RulesEditor node={node} />}

      {changedFiles.length > 0 && (
        <>
          <h3>This session</h3>
          <ul className="file-list">
            {changedFiles.map((f) => (
              <li key={f.path} onClick={() => openCode(id, f.path)}>
                <span className="mono">{f.path}</span>
                <Delta added={f.added} removed={f.removed} />
              </li>
            ))}
          </ul>
        </>
      )}

      {view?.tests && (
        <p className={`tests-line ${view.tests.failed ? 'bad' : 'ok'}`}>
          <FlaskConical size={13} /> {view.tests.passed} passed{view.tests.failed ? ` · ${view.tests.failed} failing` : ''}
        </p>
      )}
      {node.tests && node.tests.length > 0 && !view?.tests && (
        <p className="muted small">
          <FlaskConical size={12} /> {node.tests.length} test file{node.tests.length > 1 ? 's' : ''} cover this box
        </p>
      )}

      {routes.length > 0 && (
        <>
          <h3>Routes</h3>
          <ul className="contract">
            {routes.slice(0, 40).map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </>
      )}

      {symbols.length > 0 && (
        <>
          <h3>Public symbols</h3>
          <ul className="symbols">
            {symbols.slice(0, 60).map((s) => (
              <li key={s.file + s.name + s.line} onClick={() => openCode(id, s.file)}>
                <code>{s.signature}</code>
              </li>
            ))}
          </ul>
        </>
      )}

      {(incoming.length > 0 || outgoing.length > 0) && <h3>Connections</h3>}
      {[...incoming.map((e) => ({ e, dir: 'in' as const })), ...outgoing.map((e) => ({ e, dir: 'out' as const }))].slice(0, 40).map(({ e, dir }) => (
        <div key={e.id} className={`conn ${sim.edgeChanges[e.id] ? 'changed' : ''}`}>
          <div className="conn-head">
            {dir === 'in' ? (
              <>
                <span className="conn-peer">{nodeLabel(sim, e.source)}</span> <ArrowRight size={12} /> <span className="muted">this</span>
              </>
            ) : (
              <>
                <span className="muted">this</span> <ArrowRight size={12} /> <span className="conn-peer">{nodeLabel(sim, e.target)}</span>
              </>
            )}
            <span className="conn-kind">{e.kind}</span>
          </div>
          <ContractLines edge={e} sim={sim} />
        </div>
      ))}
    </div>
  )
}

function RulesEditor({ node }: { node: ArchNode }) {
  const [draft, setDraft] = useState('')
  const rules = node.rules ?? []
  const save = (next: string[]): void => void apply({ op: 'setRules', id: node.id, rules: next })
  return (
    <>
      <h3>Rules & memory</h3>
      <p className="muted small">Invariants and conventions for this box. Sent to agents only when this box is in scope.</p>
      <ul className="rules">
        {rules.map((r, i) => (
          <li key={i}>
            <Editable value={r} onSave={(v) => save(rules.map((x, j) => (j === i ? v : x)).filter(Boolean))} />
            <button className="icon-btn tiny" onClick={() => save(rules.filter((_, j) => j !== i))} aria-label="Remove rule">
              <X size={11} />
            </button>
          </li>
        ))}
      </ul>
      <div className="row-gap">
        <input
          className="edit-input"
          value={draft}
          placeholder="e.g. Tokens are always stored hashed"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && draft.trim()) {
              save([...rules, draft.trim()])
              setDraft('')
            }
          }}
        />
        <button
          className="btn small"
          disabled={!draft.trim()}
          onClick={() => {
            save([...rules, draft.trim()])
            setDraft('')
          }}
        >
          <Plus size={12} />
        </button>
      </div>
    </>
  )
}

function ActorDetails({ node, sim, model }: { node: ArchNode; sim: SimState; model: ArchModel }) {
  const mode = useStore((s) => s.mode)
  const { setActorFocus, setModal, select } = useStore.getState()
  const { reach } = actorReach(sim, node.id)
  const front = sim.edges.filter((e) => e.source === node.id)
  const editable = mode === 'workspace'
  return (
    <div className="details">
      <div className="details-title">
        <i className="actor-dot big" style={{ background: actorColor(model, node.id) }} />
        <h2>{editable ? <Editable value={node.label} onSave={(label) => apply({ op: 'rename', id: node.id, label })} /> : node.label}</h2>
        {node.proposed && <span className="state-tag tag-proposed">proposed</span>}
      </div>
      <p className="muted small">Actor · {node.actorType}</p>
      {editable ? (
        <Editable value={node.purpose} multiline placeholder="Who they are and what they do" onSave={(purpose) => apply({ op: 'setPurpose', id: node.id, purpose })} className="purpose" />
      ) : (
        <p>{node.purpose}</p>
      )}
      {node.evidence && <p className="muted small">Detected from: {node.evidence.join(' · ')}</p>}
      <div className="btn-row">
        <button className="btn small" onClick={() => setActorFocus(node.id)}>
          <Crosshair size={13} /> Show on map
        </button>
        {editable && (
          <button className="btn small" onClick={() => (useStore.setState({ actorDraft: null }), setModal({ kind: 'actor', actorId: node.id }))}>
            <Pencil size={13} /> Edit
          </button>
        )}
        {editable && node.proposed && (
          <button className="btn small primary" onClick={() => apply({ op: 'accept', id: node.id })}>
            <Check size={13} /> Accept
          </button>
        )}
        {editable && (
          <button className="btn small" onClick={() => (apply({ op: 'remove', id: node.id }), select(null))} title={node.proposed ? 'Dismiss' : 'Remove'}>
            <Trash2 size={13} />
          </button>
        )}
      </div>
      <h3>Front-facing boxes ({front.length})</h3>
      {front.map((e) => (
        <div key={e.id} className="conn" onClick={() => select({ kind: 'node', id: e.target })}>
          <div className="conn-head">
            <span className="conn-peer">{nodeLabel(sim, e.target)}</span>
          </div>
          {e.contract.length > 0 && e.contract[0] !== 'uses' && <ContractLines edge={e} sim={sim} />}
        </div>
      ))}
      {front.length === 0 && <p className="muted small">Not connected yet. Edit the actor to choose the boxes or routes they use.</p>}
      {node.routes && node.routes.length > 0 && (
        <>
          <h3>Route patterns</h3>
          <ul className="contract">
            {node.routes.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </>
      )}
      <p className="muted small">Reaches {reach.size} box{reach.size === 1 ? '' : 'es'} in total, directly or through dependencies.</p>
    </div>
  )
}

function kindText(n: ArchNode): string {
  if (n.kind === 'actor') return `Actor (${n.actorType})`
  if (n.kind === 'external') return 'External system'
  if (n.kind === 'datastore') return 'Data store'
  return 'Box'
}

// ── Edge ─────────────────────────────────────────────────────────────

function EdgeDetails({ id, sim }: { id: string; sim: SimState }) {
  const zoom = useStore((s) => s.zoom)
  const reviews = useStore((s) => s.reviews)
  const model = useModel()
  const ev = useMemo(() => buildView(sim, zoom, reviews).edges.find((e) => e.id === id), [sim, zoom, reviews, id])
  if (!ev) return <p className="muted pad">This edge isn't visible at this zoom level.</p>
  const violations = (model.violations ?? []).filter((v) => ev.members.some((m) => m.id === v.edge))
  return (
    <div className="details">
      <div className="details-title">
        <h2>
          {nodeLabel(sim, ev.source)} <ArrowRight size={16} /> {nodeLabel(sim, ev.target)}
        </h2>
      </div>
      <p className="muted small">
        {ev.members.length === 1 ? 'Edge' : `${ev.members.length} links folded at this zoom level`} · contracts crossing this boundary
      </p>
      {violations.map((v) => {
        const g = model.guardrails?.find((x) => x.id === v.guardrail)
        return (
          <p key={v.edge + v.guardrail} className="violation-line">
            <ShieldAlert size={13} /> Breaks guardrail “{nodeLabel(sim, g?.from ?? '')} ↛ {nodeLabel(sim, g?.to ?? '')}”{g?.reason ? `: ${g.reason}` : ''}
          </p>
        )
      })}
      {ev.members.map((e) => (
        <div key={e.id} className={`conn ${sim.edgeChanges[e.id] ? 'changed' : ''}`}>
          <div className="conn-head">
            <span className="conn-peer">{nodeLabel(sim, e.source)}</span> <ArrowRight size={12} />
            <span className="conn-peer">{nodeLabel(sim, e.target)}</span>
            <span className="conn-kind">
              {e.kind}
              {e.weight && e.weight > 1 ? ` ×${e.weight}` : ''}
            </span>
            {sim.ghostEdges.has(e.id) && <span className="state-tag tag-ghost">planned</span>}
          </div>
          <ContractLines edge={e} sim={sim} />
        </div>
      ))}
    </div>
  )
}

// ── Code ─────────────────────────────────────────────────────────────

const EDITOR_OPTIONS = {
  readOnly: true,
  minimap: { enabled: false },
  fontSize: 12.5,
  fontFamily: "'JetBrains Mono', 'Cascadia Code', Consolas, monospace",
  scrollBeyondLastLine: false,
  lineNumbersMinChars: 3,
  renderOverviewRuler: false,
  automaticLayout: true
}

function CodeView({ id, sim }: { id: string; sim: SimState }) {
  const theme = useTheme()
  const codeFile = useStore((s) => s.codeFile)
  const [showDiff, setShowDiff] = useState(true)
  const files = filesOf(sim, id)
  const changed = files.filter((f) => sim.files[f])
  const file = codeFile && files.includes(codeFile) ? codeFile : codeFile && !files.length ? codeFile : (changed[0] ?? files[0] ?? codeFile)
  const node = sim.nodes.find((n) => n.id === id)
  const change = file ? sim.files[file] : undefined
  const current = useFileText(file ?? null, change?.version ?? 'base')
  const base = useFileText(change && showDiff ? file! : null, 'base')

  if (!file) return <p className="muted pad">{node?.label ?? 'This box'} has no source files.</p>
  const lang = languageOf(file)
  const symbols = sim.nodes.find((n) => n.id === id)?.symbols.filter((s) => s.file === file) ?? []

  return (
    <div className="code-view">
      <div className="file-tabs">
        {files.slice(0, 40).map((f) => (
          <button key={f} className={f === file ? 'on' : ''} onClick={() => useStore.setState({ codeFile: f })} title={f}>
            {basename(f)}
            {sim.files[f] && <i className="dot" />}
          </button>
        ))}
        {files.length > 40 && <span className="muted small">+{files.length - 40}</span>}
      </div>
      <div className="code-meta">
        <span className="mono muted">{file}</span>
        {change && <Delta added={change.added} removed={change.removed} />}
        <span className="spacer" />
        {change && (
          <div className="seg">
            <button className={showDiff ? 'on' : ''} onClick={() => setShowDiff(true)}>
              Diff
            </button>
            <button className={!showDiff ? 'on' : ''} onClick={() => setShowDiff(false)}>
              Final
            </button>
          </div>
        )}
      </div>
      {symbols.length > 0 && (
        <div className="symbol-strip">
          {symbols.slice(0, 12).map((s) => (
            <span key={s.name + s.line} className="chip" title={s.signature}>
              {s.name}
            </span>
          ))}
        </div>
      )}
      <div className="editor">
        {current === null ? null : change && showDiff ? (
          <DiffEditor
            key={file + change.version}
            original={base ?? ''}
            modified={current}
            language={lang}
            theme={theme === 'light' ? 'viber-light' : 'viber-dark'}
            options={{ ...EDITOR_OPTIONS, renderSideBySide: false, renderIndicators: true }}
          />
        ) : (
          <Editor key={file} value={current} language={lang} theme={theme === 'light' ? 'viber-light' : 'viber-dark'} options={EDITOR_OPTIONS} />
        )}
      </div>
    </div>
  )
}

// ── Review ───────────────────────────────────────────────────────────

function Review({ sim }: { sim: SimState }) {
  const reviews = useStore((s) => s.reviews)
  const committed = useStore((s) => s.committed)
  const mode = useStore((s) => s.mode)
  const model = useModel()
  const baseIds = new Set(model.nodes.map((n) => n.id))
  const { setReview, openCode, commit, select } = useStore.getState()
  const [message, setMessage] = useState('')
  const [result, setResult] = useState<string | null>(null)
  const ids = [...sim.touched]
  const approved = ids.filter((i) => reviews[i] === 'approved')
  const rejected = ids.filter((i) => reviews[i] === 'rejected')
  const filesFor = (nodeIds: string[]): string[] => Object.values(sim.files).filter((f) => f.nodeId && nodeIds.includes(f.nodeId)).map((f) => f.path)
  const defaultMessage = `${sim.prompt ?? 'Update'}\n\nBoxes: ${approved.map((i) => nodeLabel(sim, i)).join(', ')}`

  const doCommit = async (): Promise<void> => {
    if (mode === 'demo') return commit()
    // Rejected boxes are reverted to the session checkpoint; approved ones are committed.
    if (rejected.length) await window.viber.invoke('session:revert', filesFor(rejected))
    const r = await window.viber.invoke<{ ok: boolean; sha?: string; error?: string }>('git:commit', filesFor(approved), message || defaultMessage)
    setResult(r.ok ? `Committed ${approved.length} box${approved.length > 1 ? 'es' : ''} as ${r.sha?.slice(0, 8)}` : `Commit failed: ${r.error}`)
    if (r.ok) commit()
  }

  if (committed) {
    const contracts = Object.keys(sim.edgeChanges).length
    return (
      <div className="details">
        <div className="commit-done">
          <GitCommitHorizontal size={18} />
          <div>
            <strong>{result ?? `Committed ${approved.length} boxes to main (simulated)`}</strong>
            <pre className="commit-msg">
              {message ||
                `feat(auth): rotating refresh tokens (30 days)\n\nBoxes: ${approved.map((i) => nodeLabel(sim, i)).join(', ')}\nContracts changed: ${contracts}\nTests: ${sim.testRun?.selected ?? 0}/${sim.testRun?.total ?? 0} selected, all passing`}
            </pre>
            {rejected.length > 0 && <p className="muted small">Reverted: {rejected.map((i) => nodeLabel(sim, i)).join(', ')}</p>}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="details review">
      {sim.phase !== 'review' && <p className="muted small">The session is still running. You can start reviewing what has landed so far.</p>}
      <p className="muted small">Review by meaning first: contracts and tests per box. The line diff is one click away.</p>
      {ids.map((id) => {
        const node = sim.nodes.find((n) => n.id === id)
        if (!node) return null
        const files = Object.values(sim.files).filter((f) => f.nodeId === id)
        const edges = sim.edges.filter((e) => (e.source === id || e.target === id) && sim.edgeChanges[e.id])
        const t = sim.tests[id]
        const r = reviews[id]
        const outside = sim.warnings.some((w) => w.nodeId === id)
        const isNew = !baseIds.has(id)
        return (
          <div key={id} className={`review-card ${r ?? ''}`}>
            <div className="review-head" onClick={() => select({ kind: 'node', id })}>
              <KindIcon node={node} />
              <strong>{node.label}</strong>
              {isNew && <span className="state-tag tag-ghost">new</span>}
              {outside && <span className="state-tag tag-warning">was outside fence</span>}
              <span className="spacer" />
              {t && (
                <span className={`tests ${t.failed ? 'bad' : 'ok'}`}>
                  <FlaskConical size={11} /> {t.passed}/{t.passed + t.failed}
                </span>
              )}
            </div>
            {edges.map((e) => (
              <div key={e.id} className="review-contract">
                <span className="muted small">
                  {nodeLabel(sim, e.source)} → {nodeLabel(sim, e.target)}
                </span>
                <ContractLines edge={e} sim={sim} />
              </div>
            ))}
            <ul className="file-list">
              {files.map((f) => (
                <li key={f.path} onClick={() => openCode(id, f.path)}>
                  <span className="mono">{basename(f.path)}</span>
                  <Delta added={f.added} removed={f.removed} />
                </li>
              ))}
            </ul>
            <div className="card-actions">
              {mode === 'workspace' && (
                <button className="btn small" title="Revert this box's files to the session checkpoint now" onClick={() => void window.viber.invoke('session:revert', files.map((f) => f.path))}>
                  <Undo2 size={12} /> Revert now
                </button>
              )}
              <button className={`btn small ${r === 'rejected' ? 'danger on' : ''}`} onClick={() => setReview([id], r === 'rejected' ? null : 'rejected')}>
                <X size={12} /> Reject
              </button>
              <button className={`btn small ${r === 'approved' ? 'primary' : ''}`} onClick={() => setReview([id], r === 'approved' ? null : 'approved')}>
                <Check size={12} /> Approve
              </button>
            </div>
          </div>
        )
      })}
      {mode === 'workspace' && approved.length > 0 && (
        <textarea className="edit-input commit-input" rows={3} placeholder={defaultMessage} value={message} onChange={(e) => setMessage(e.target.value)} />
      )}
      <div className="review-foot">
        <button className="btn small" onClick={() => setReview(ids.filter((i) => !reviews[i]), 'approved')}>
          Approve remaining
        </button>
        <button className="btn primary" disabled={approved.length === 0 || (mode === 'demo' && sim.phase !== 'review')} onClick={doCommit}>
          <GitCommitHorizontal size={14} /> Commit {approved.length} approved
        </button>
      </div>
    </div>
  )
}

async function exportBox(id: string, withCode: boolean): Promise<void> {
  const r = await window.viber.invoke<{ path?: string; error?: string } | null>('box:export', id, withCode)
  if (r?.error) alert(r.error)
}
