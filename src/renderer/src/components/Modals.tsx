import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Crosshair, MousePointerClick, X } from 'lucide-react'
import { ACTOR_TYPES, type ActorType } from '@shared/model'
import type { ActorInput } from '@shared/api'
import { useModel, useStore } from '../store'
import { apply } from './ModelPanel'
import { LocateDialog } from './Locate'
import { Palette } from './Palette'
import { AgentsDialog, SettingsDialog } from './Settings'
import { EdgeDialog, JourneyDialog, NewBoxDialog } from './DesignDialogs'

const ACTOR_HELP: Record<ActorType, string> = {
  user: 'People using the product UI',
  admin: 'Staff using back-office or admin areas',
  client: 'Programs calling your API (partners, mobile apps, scripts)',
  cli: 'Developers or operators running commands',
  cron: 'Time-based triggers',
  webhook: 'Third parties calling back into you',
  system: 'Other internal systems, queues, devices'
}

export function Dialog({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const k = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [onClose])
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className={`modal ${wide ? 'wide' : ''}`} onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <strong>{title}</strong>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <X size={14} />
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}

export function ActorEditor({ actorId }: { actorId?: string }) {
  const model = useModel()
  const draft = useStore((s) => s.actorDraft)
  const { setModal, startPicking } = useStore.getState()
  const existing = actorId ? model.nodes.find((n) => n.id === actorId) : undefined

  // Initialise the draft once per opening (unless coming back from picking on the map).
  useEffect(() => {
    if (useStore.getState().actorDraft) return
    useStore.setState({
      actorDraft: existing
        ? {
            id: existing.id,
            label: existing.label,
            type: existing.actorType ?? 'user',
            description: existing.purpose,
            reaches: model.edges.filter((e) => e.source === existing.id).map((e) => e.target),
            routes: existing.routes ?? []
          }
        : { label: '', type: 'user', description: '', reaches: useStore.getState().scope.filter((id) => model.nodes.find((n) => n.id === id)?.kind === 'box'), routes: [] }
    })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const boxes = model.nodes.filter((n) => n.kind === 'box')
  const allRoutes = useMemo(() => model.nodes.flatMap((n) => (n.routes ?? []).map((r) => ({ r, box: n.label }))), [model])
  const d = draft
  if (!d) return null
  const set = (patch: Partial<ActorInput>): void => useStore.setState({ actorDraft: { ...d, ...patch } })
  const close = (): void => {
    useStore.setState({ actorDraft: null })
    setModal(null)
  }
  const save = async (): Promise<void> => {
    if (!d.label.trim()) return
    await apply({ op: 'upsertActor', actor: { ...d, label: d.label.trim(), routes: (d.routes ?? []).map((r) => r.trim()).filter(Boolean) } })
    close()
  }
  const routePatterns = (d.routes ?? []).filter((r) => r.trim())
  const matched = allRoutes.filter(({ r }) =>
    routePatterns.some((p) => {
      const pp = p.trim().replace(/^(GET|POST|PUT|PATCH|DELETE|PAGE|ANY)\s+/i, '')
      const rp = r.split(' ')[1] ?? ''
      return pp.endsWith('*') ? rp.startsWith(pp.slice(0, -1).replace(/\/$/, '')) : rp === pp
    })
  )

  return (
    <Dialog title={existing ? `Edit actor · ${existing.label}` : 'Declare an actor'} onClose={close}>
      <div className="form">
        <label>
          Name
          <input autoFocus value={d.label} placeholder="e.g. Gardener, Support agent, Partner API" onChange={(e) => set({ label: e.target.value })} />
        </label>
        <div className="form-field">
          <span>Type</span>
          <div className="type-grid">
            {ACTOR_TYPES.map((t) => (
              <button key={t} className={`type-chip ${d.type === t ? 'on' : ''}`} onClick={() => set({ type: t })} title={ACTOR_HELP[t]}>
                {t}
              </button>
            ))}
          </div>
          <span className="muted small">{ACTOR_HELP[d.type]}</span>
        </div>
        <label>
          Description
          <textarea rows={2} value={d.description ?? ''} placeholder="What they do with the system" onChange={(e) => set({ description: e.target.value })} />
        </label>
        <div className="form-field">
          <span>Reaches these boxes directly (front-facing)</span>
          <div className="chips">
            {(d.reaches ?? []).map((id) => (
              <span key={id} className="chip chip-scope">
                {model.nodes.find((n) => n.id === id)?.label ?? id}
                <button onClick={() => set({ reaches: d.reaches!.filter((x) => x !== id) })} aria-label="Remove">
                  <X size={11} />
                </button>
              </span>
            ))}
            {!(d.reaches ?? []).length && <span className="muted small">none yet</span>}
          </div>
          <div className="row-gap">
            <select value="" onChange={(e) => e.target.value && set({ reaches: [...new Set([...(d.reaches ?? []), e.target.value])] })}>
              <option value="">Add a box…</option>
              {boxes.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.label} ({b.id})
                </option>
              ))}
            </select>
            <button
              className="btn small"
              onClick={() => {
                startPicking(d.reaches ?? [])
                setModal(null)
              }}
            >
              <MousePointerClick size={12} /> Pick on the map
            </button>
          </div>
        </div>
        <label>
          Routes they use <span className="muted small">(one per line, e.g. /admin/* or POST /api/orders)</span>
          <textarea rows={3} className="mono" value={(d.routes ?? []).join('\n')} onChange={(e) => set({ routes: e.target.value.split('\n') })} />
          {routePatterns.length > 0 && (
            <span className="muted small">
              matches {matched.length} route{matched.length === 1 ? '' : 's'}
              {matched.length ? ` in ${[...new Set(matched.map((m) => m.box))].slice(0, 4).join(', ')}` : ''}
            </span>
          )}
        </label>
      </div>
      <div className="modal-foot">
        <button className="btn" onClick={close}>
          Cancel
        </button>
        <button className="btn primary" disabled={!d.label.trim()} onClick={save}>
          {existing ? 'Save actor' : 'Add actor'}
        </button>
      </div>
    </Dialog>
  )
}

export function GuardrailEditor() {
  const model = useModel()
  const { setModal } = useStore.getState()
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [reason, setReason] = useState('')
  const opts = model.nodes.filter((n) => n.kind !== 'actor')
  const save = async (): Promise<void> => {
    await apply({ op: 'upsertGuardrail', guardrail: { id: `${from}!->${to}`, from, to, reason: reason || undefined } })
    setModal(null)
  }
  return (
    <Dialog title="Add a guardrail" onClose={() => setModal(null)}>
      <div className="form">
        <p className="muted small">Viber flags any dependency from the first box (or anything inside it) to the second, including ones an agent adds.</p>
        <label>
          Never depend from
          <select value={from} onChange={(e) => setFrom(e.target.value)}>
            <option value="">Choose…</option>
            {opts.map((n) => (
              <option key={n.id} value={n.id}>
                {n.label} ({n.id})
              </option>
            ))}
          </select>
        </label>
        <label>
          on
          <select value={to} onChange={(e) => setTo(e.target.value)}>
            <option value="">Choose…</option>
            {opts.map((n) => (
              <option key={n.id} value={n.id}>
                {n.label} ({n.id})
              </option>
            ))}
          </select>
        </label>
        <label>
          Why <span className="muted small">(shown to agents)</span>
          <input value={reason} placeholder="e.g. UI must go through the API, never the DB" onChange={(e) => setReason(e.target.value)} />
        </label>
      </div>
      <div className="modal-foot">
        <button className="btn" onClick={() => setModal(null)}>
          Cancel
        </button>
        <button className="btn primary" disabled={!from || !to || from === to} onClick={save}>
          Add guardrail
        </button>
      </div>
    </Dialog>
  )
}

/** Banner shown while picking boxes on the map for a dialog. */
export function PickingBanner() {
  const picking = useStore((s) => s.picking)
  const model = useModel()
  if (!picking) return null
  const done = (): void => {
    const st = useStore.getState()
    useStore.setState({
      actorDraft: st.actorDraft ? { ...st.actorDraft, reaches: picking.picked } : st.actorDraft,
      picking: null,
      modal: { kind: 'actor', actorId: st.actorDraft?.id }
    })
  }
  return (
    <div className="picking-banner">
      <Crosshair size={14} />
      <span>
        Click the boxes this actor reaches directly. <strong>{picking.picked.length}</strong> selected
        {picking.picked.length ? `: ${picking.picked.map((id) => model.nodes.find((n) => n.id === id)?.label ?? id).slice(0, 4).join(', ')}` : ''}
      </span>
      <button className="btn small primary" onClick={done}>
        Done
      </button>
    </div>
  )
}

export function Modals() {
  const modal = useStore((s) => s.modal)
  if (!modal) return null
  if (modal.kind === 'actor') return <ActorEditor actorId={modal.actorId} />
  if (modal.kind === 'guardrail') return <GuardrailEditor />
  if (modal.kind === 'locate') return <LocateDialog />
  if (modal.kind === 'palette') return <Palette />
  if (modal.kind === 'settings') return <SettingsDialog />
  if (modal.kind === 'agents') return <AgentsDialog />
  if (modal.kind === 'newBox') return <NewBoxDialog parent={modal.parent} />
  if (modal.kind === 'edge') return <EdgeDialog from={modal.from} to={modal.to} />
  if (modal.kind === 'journey') return <JourneyDialog id={modal.id} />
  return null
}
