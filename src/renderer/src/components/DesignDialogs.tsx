import { askArchitect } from '../architectChat'
import { useState } from 'react'
import { ArrowRight, Package, Plus, X } from 'lucide-react'
import type { ArchEdge, JourneyStep } from '@shared/model'
import { useModel, useStore } from '../store'
import { Dialog } from './Modals'
import { apply } from './ModelPanel'

// Design mode: humans sketch components, contracts and journeys; agents build them.

const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

export function NewBoxDialog({ parent: initialParent }: { parent?: string }) {
  const model = useModel()
  const { setModal } = useStore.getState()
  const [label, setLabel] = useState('')
  const [parent, setParent] = useState(initialParent ?? '')
  const [responsibility, setResponsibility] = useState('')
  const [folder, setFolder] = useState('')
  const boxes = model.nodes.filter((n) => n.kind === 'box')
  const save = async (): Promise<void> => {
    if (!label.trim()) return
    const id = parent ? `${parent}/${slug(label)}` : slug(label)
    await apply({
      op: 'addBox',
      id,
      label: label.trim(),
      parent: parent || undefined,
      paths: folder.trim() ? [folder.trim().replace(/\/$/, '')] : [],
      spec: { status: 'planned', autonomy: 'ask', responsibility: responsibility.trim() || undefined }
    })
    useStore.setState({ selection: { kind: 'node', id } })
    setModal(null)
  }
  return (
    <Dialog title="New component" onClose={() => setModal(null)}>
      <div className="form">
        <p className="muted small">A box is a component with one responsibility that talks to others only through its contract. It starts as "planned"; agents build it from its spec.</p>
        <label>
          Name
          <input autoFocus value={label} placeholder="e.g. Billing, Notifications, Irrigation scheduler" onChange={(e) => setLabel(e.target.value)} />
        </label>
        <label>
          Responsibility
          <textarea rows={2} value={responsibility} placeholder="The one thing it is responsible for" onChange={(e) => setResponsibility(e.target.value)} />
        </label>
        <label>
          Inside
          <select value={parent} onChange={(e) => setParent(e.target.value)}>
            <option value="">(top level: its own deployable)</option>
            {boxes.map((b) => (
              <option key={b.id} value={b.id}>
                {b.label} ({b.id})
              </option>
            ))}
          </select>
        </label>
        <label>
          Folder <span className="muted small">(optional; where its code should live)</span>
          <input className="mono" value={folder} placeholder="e.g. backend/billing" onChange={(e) => setFolder(e.target.value)} />
        </label>
      </div>
      <div className="modal-foot">
        <button className="btn" onClick={() => setModal(null)}>
          Cancel
        </button>
        <button className="btn primary" disabled={!label.trim()} onClick={save}>
          Add component
        </button>
      </div>
    </Dialog>
  )
}

export function EdgeDialog({ from, to }: { from: string; to: string }) {
  const model = useModel()
  const { setModal } = useStore.getState()
  const target = model.nodes.find((n) => n.id === to)
  const source = model.nodes.find((n) => n.id === from)
  const offered = target?.spec?.contract ?? []
  const [kind, setKind] = useState<ArchEdge['kind']>(offered[0]?.kind === 'http' ? 'http' : offered[0]?.kind === 'event' || offered[0]?.kind === 'queue' ? 'event' : 'call')
  const [uses, setUses] = useState<string[]>([])
  const [extra, setExtra] = useState('')
  const save = async (): Promise<void> => {
    const all = [...uses, ...extra.split(',').map((s) => s.trim()).filter(Boolean)]
    await apply({ op: 'upsertEdge', edge: { id: `${from}->${to}`, from, to, kind, uses: all } })
    setModal(null)
  }
  return (
    <Dialog title="New contract" onClose={() => setModal(null)}>
      <div className="form">
        <div className="edge-title">
          <strong>{source?.label}</strong> <ArrowRight size={14} /> <strong>{target?.label}</strong>
        </div>
        <label>
          How they talk
          <select value={kind} onChange={(e) => setKind(e.target.value as ArchEdge['kind'])}>
            <option value="http">HTTP</option>
            <option value="call">Function calls</option>
            <option value="event">Events / queue</option>
            <option value="sql">Database</option>
            <option value="external">External API</option>
          </select>
        </label>
        <div className="form-field">
          <span>Uses from {target?.label}'s contract</span>
          {offered.length === 0 && <span className="muted small">{target?.label} has no contract yet. Add items in its spec, or list them below.</span>}
          {offered.map((c) => (
            <label key={c.name} className="check">
              <input type="checkbox" checked={uses.includes(c.name)} onChange={(e) => setUses(e.target.checked ? [...uses, c.name] : uses.filter((u) => u !== c.name))} />
              <span className="mono">{c.name}</span>
            </label>
          ))}
          <input className="mono" value={extra} placeholder="other items, comma-separated" onChange={(e) => setExtra(e.target.value)} />
        </div>
      </div>
      <div className="modal-foot">
        <button className="btn" onClick={() => setModal(null)}>
          Cancel
        </button>
        <button className="btn primary" onClick={save}>
          Add contract
        </button>
      </div>
    </Dialog>
  )
}

export function JourneyDialog({ id }: { id?: string }) {
  const model = useModel()
  const { setModal } = useStore.getState()
  const existing = (model.journeys ?? []).find((j) => j.id === id)
  const actors = model.nodes.filter((n) => n.kind === 'actor')
  const boxes = model.nodes.filter((n) => n.kind === 'box')
  const [name, setName] = useState(existing?.name ?? '')
  const [actor, setActor] = useState(existing?.actor ?? actors[0]?.id ?? '')
  const [steps, setSteps] = useState<JourneyStep[]>(existing?.steps ?? [{ box: '', action: '' }])
  // New journeys start as a description the architect turns into steps; editing shows the steps.
  const [how, setHow] = useState<'describe' | 'steps'>(existing ? 'steps' : 'describe')
  const [story, setStory] = useState('')
  const clean = steps.filter((s) => s.box && s.action.trim())
  const missing = [
    !name.trim() && 'a name',
    !actor && 'an actor (add one first)',
    !clean.length && 'at least one step with a box and what happens',
    steps.some((s) => (s.box && !s.action.trim()) || (!s.box && s.action.trim())) && 'a box and an action on every step'
  ].filter(Boolean) as string[]
  const save = async (): Promise<void> => {
    if (missing.length) return
    await apply({ op: 'upsertJourney', journey: { id: existing?.id ?? slug(name), actor, name: name.trim(), steps: clean } })
    setModal(null)
  }
  const describe = (): void => {
    if (!story.trim()) return
    const who = actors.find((a) => a.id === actor)?.label ?? 'the main actor'
    void askArchitect(
      `Add a journey${name.trim() ? ` named "${name.trim()}"` : ''} for ${who} (${actor || 'pick the right actor'}): ${story.trim()}
Use the existing components, step by step, including replies. If a step needs a component or a contract that does not exist, add it to the proposal.`
    )
    setModal(null)
  }
  return (
    <Dialog title={existing ? 'Edit journey' : 'New journey'} onClose={() => setModal(null)} wide>
      <div className="form">
        <p className="muted small">An actor's path through the system. Each journey becomes an end-to-end acceptance test, and its boxes get it in their build task.</p>
        <div className="row-gap">
          <label className="grow">
            Journey
            <input autoFocus value={name} placeholder="e.g. Gardener logs a watering" onChange={(e) => setName(e.target.value)} />
          </label>
          <label>
            Actor
            <select value={actor} onChange={(e) => setActor(e.target.value)}>
              {actors.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        {!existing && (
          <div className="seg small">
            <button className={how === 'describe' ? 'on' : ''} onClick={() => setHow('describe')}>
              Describe it
            </button>
            <button className={how === 'steps' ? 'on' : ''} onClick={() => setHow('steps')}>
              Pick the steps myself
            </button>
          </div>
        )}
        {how === 'describe' ? (
          <label className="form-field">
            What happens, in your words
            <textarea rows={4} value={story} placeholder="e.g. A player opens the app on their phone, joins the table with the code, picks their character and sees the current scene." onChange={(e) => setStory(e.target.value)} />
            <span className="muted small">The architect turns it into steps through the components (and adds missing contracts). You accept or reject it in the Design tab.</span>
          </label>
        ) : (
        <div className="form-field">
          <span>Steps</span>
          {steps.map((s, i) => (
            <div key={i} className="journey-step">
              <span className="step-n">{i + 1}</span>
              <select value={s.box} onChange={(e) => setSteps(steps.map((x, j) => (j === i ? { ...x, box: e.target.value } : x)))}>
                <option value="">Box…</option>
                {boxes.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.label}
                  </option>
                ))}
              </select>
              <input value={s.action} placeholder="what happens here" onChange={(e) => setSteps(steps.map((x, j) => (j === i ? { ...x, action: e.target.value } : x)))} />
              <button className="icon-btn tiny" onClick={() => setSteps(steps.filter((_, j) => j !== i))} aria-label="Remove step">
                <X size={11} />
              </button>
            </div>
          ))}
          <button className="btn small ghost" onClick={() => setSteps([...steps, { box: '', action: '' }])}>
            <Plus size={12} /> Step
          </button>
        </div>
        )}
      </div>
      <div className="modal-foot">
        {existing && (
          <button className="btn danger" onClick={() => (void apply({ op: 'removeJourney', id: existing.id }), setModal(null))}>
            Delete
          </button>
        )}
        <span className="spacer" />
        <button className="btn" onClick={() => setModal(null)}>
          Cancel
        </button>
        {how === 'describe' ? (
          <button className="btn primary" onClick={describe} disabled={!story.trim()}>
            Ask the architect
          </button>
        ) : (
          <>
            {missing.length > 0 && <span className="muted small">Needs {missing.join(', ')}.</span>}
            <button className="btn primary" onClick={save} disabled={missing.length > 0}>
              Save journey
            </button>
          </>
        )}
      </div>
    </Dialog>
  )
}

/** Canvas toolbar for design mode. */
export function DesignToolbar() {
  const tool = useStore((s) => s.designTool)
  const from = useStore((s) => s.connectFrom)
  const mode = useStore((s) => s.mode)
  const model = useModel()
  if (mode !== 'workspace') return null
  const set = (t: 'box' | 'connect' | null): void => useStore.setState({ designTool: tool === t ? null : t, connectFrom: null })
  return (
    <div className="design-toolbar">
      <button className={`btn small ${tool === 'box' ? 'primary' : ''}`} onClick={() => useStore.getState().setModal({ kind: 'newBox', parent: selectedContainer() })} title="Add a planned component">
        <Plus size={12} /> Component
      </button>
      <button className={`btn small ${tool === 'connect' ? 'primary' : ''}`} onClick={() => set('connect')} title="Draw a contract: click the consumer, then the provider">
        <ArrowRight size={12} /> Contract
      </button>
      <button className="btn small" title="Add a component from a .box template" onClick={() => void importBox()}>
        <Package size={12} /> Template
      </button>
      {tool === 'connect' && (
        <span className="small">{from ? `From ${model.nodes.find((n) => n.id === from)?.label}: now click the provider` : 'Click the box that depends…'}</span>
      )}
    </div>
  )
}

function selectedContainer(): string | undefined {
  const st = useStore.getState()
  const sel = st.selection
  if (sel?.kind !== 'node') return undefined
  const n = (st.preview?.model ?? st.snapshot?.model)?.nodes.find((x) => x.id === sel.id)
  return n?.kind === 'box' ? n.id : undefined
}

async function importBox(): Promise<void> {
  const r = await window.viber.invoke<{ id?: string; files?: number; requires?: { kind: string; uses: string[]; note?: string }[]; error?: string } | null>('box:import', selectedContainer())
  if (!r) return
  if (r.error) return alert(r.error)
  useStore.getState().select({ kind: 'node', id: r.id! })
  if (r.requires?.length) alert(`Imported. It needs: ${r.requires.map((q) => q.uses.join(', ') || q.kind).join('; ')}. Draw those contracts with Contract.`)
}
