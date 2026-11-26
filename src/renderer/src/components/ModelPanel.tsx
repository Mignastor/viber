import { useMemo, useState, type ReactNode } from 'react'
import {
  Check,
  ChevronDown,
  ChevronRight,
  CornerLeftUp,
  Crosshair,
  Plus,
  RefreshCw,
  Save,
  ShieldAlert,
  Sparkles,
  Trash2,
  Undo2,
  UserPlus,
  X
} from 'lucide-react'
import type { ArchNode } from '@shared/model'
import type { DefsOp } from '@shared/api'
import { useStore } from '../store'
import { KindIcon } from './common'

export const apply = (op: DefsOp): Promise<unknown> => window.viber.invoke('ws:apply', op)

/** Click-to-edit text. */
export function Editable({ value, onSave, className, multiline, placeholder }: { value: string; onSave: (v: string) => void; className?: string; multiline?: boolean; placeholder?: string }) {
  const [editing, setEditing] = useState(false)
  const [v, setV] = useState(value)
  if (!editing)
    return (
      <span className={`editable ${className ?? ''} ${value ? '' : 'empty'}`} title="Click to edit" onClick={(e) => (e.stopPropagation(), setV(value), setEditing(true))}>
        {value || placeholder || 'Click to edit'}
      </span>
    )
  const done = (save: boolean): void => {
    setEditing(false)
    if (save && v.trim() !== value) onSave(v.trim())
  }
  return multiline ? (
    <textarea className="edit-input" autoFocus value={v} rows={3} onChange={(e) => setV(e.target.value)} onBlur={() => done(true)} onKeyDown={(e) => e.key === 'Escape' && done(false)} />
  ) : (
    <input className="edit-input" autoFocus value={v} onChange={(e) => setV(e.target.value)} onBlur={() => done(true)} onKeyDown={(e) => (e.key === 'Enter' ? done(true) : e.key === 'Escape' ? done(false) : undefined)} />
  )
}

export function ModelPanel() {
  const snapshot = useStore((s) => s.snapshot)
  const busy = useStore((s) => s.busy)
  const { setModal, select, setBusy, setActorFocus } = useStore.getState()
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const [note, setNote] = useState<string | null>(null)
  const model = snapshot?.model
  const nodes = model?.nodes ?? []
  const children = useMemo(() => {
    const m = new Map<string | undefined, ArchNode[]>()
    for (const n of nodes) if (n.kind === 'box') m.set(n.parent, [...(m.get(n.parent) ?? []), n])
    return m
  }, [nodes])
  if (!snapshot || !model) return null

  const actors = nodes.filter((n) => n.kind === 'actor')
  const services = nodes.filter((n) => n.kind === 'external' || n.kind === 'datastore')
  const proposals = nodes.filter((n) => n.proposed)
  const reachCount = (id: string): number => model.edges.filter((e) => e.source === id).length
  const label = (id: string): string => nodes.find((n) => n.id === id)?.label ?? id

  const run = async (what: string, fn: () => Promise<unknown>): Promise<void> => {
    setBusy(what)
    setNote(null)
    try {
      await fn()
    } catch (e) {
      setNote(String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    } finally {
      setBusy(null)
      useStore.setState({ progress: null })
    }
  }
  const describe = async (): Promise<void> => {
    const r = await window.viber.invoke<{ described: number; skipped: number; tokens: number }>('insights:describe')
    setNote(`Described ${r.described} box${r.described === 1 ? '' : 'es'} (${r.skipped} unchanged, ${r.tokens.toLocaleString()} tokens).`)
  }

  const row = (n: ArchNode, depth: number): ReactNode => {
    const kids = children.get(n.id) ?? []
    const isOpen = open[n.id] ?? depth < 1
    return (
      <div key={n.id}>
        <div className={`tree-row ${n.proposed ? 'proposed' : ''}`} style={{ paddingLeft: 6 + depth * 14 }} onClick={() => select({ kind: 'node', id: n.id })}>
          <button className="tree-toggle" onClick={(e) => (e.stopPropagation(), setOpen({ ...open, [n.id]: !isOpen }))} style={{ visibility: kids.length ? 'visible' : 'hidden' }}>
            {isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </button>
          <KindIcon node={n} container={kids.length > 0} size={13} />
          <Editable value={n.label} onSave={(label) => apply({ op: 'rename', id: n.id, label })} className="tree-label" />
          <span className="tree-meta">{n.stats?.files ? `${n.stats.files}f` : ''}</span>
          <span className="tree-actions">
            {n.proposed && (
              <button title="Accept" onClick={(e) => (e.stopPropagation(), apply({ op: 'accept', id: n.id }))}>
                <Check size={12} />
              </button>
            )}
            {n.parent && (
              <button title={`Merge into ${label(n.parent)}`} onClick={(e) => (e.stopPropagation(), apply({ op: 'mergeInto', id: n.id, target: n.parent! }))}>
                <CornerLeftUp size={12} />
              </button>
            )}
            <button title={n.proposed ? 'Dismiss' : 'Remove box (its files fall to the parent)'} onClick={(e) => (e.stopPropagation(), apply({ op: 'remove', id: n.id }))}>
              <Trash2 size={12} />
            </button>
          </span>
        </div>
        {isOpen && kids.map((k) => row(k, depth + 1))}
      </div>
    )
  }

  return (
    <div className="model-panel">
      {snapshot.draft ? (
        <div className="draft-banner">
          <strong>Draft model</strong>
          <p className="small">
            Viber's first guess from the code. Rename, merge or remove boxes, check the actors, then save to <code>.arch/model.yaml</code>.
          </p>
          <div className="card-actions">
            <button className="btn small" onClick={() => run('Discarding…', () => window.viber.invoke('ws:discard'))}>
              <Undo2 size={12} /> Discard
            </button>
            <button className="btn small primary" onClick={() => run('Saving…', () => window.viber.invoke('ws:save'))}>
              <Save size={12} /> Save model
            </button>
          </div>
        </div>
      ) : (
        <div className="model-head">
          <span className="muted small">
            {snapshot.stats.files} files · {Object.entries(snapshot.stats.languages).map(([l, n]) => `${l} ${n}`).join(' · ')}
          </span>
          <span className="row-gap tight">
            <button className="icon-btn" title="Write box descriptions with AI (model set in Settings)" disabled={!!busy} onClick={() => run('Describing boxes…', describe)}>
              <Sparkles size={13} />
            </button>
            <button className="icon-btn" title="Rescan" disabled={!!busy} onClick={() => run('Scanning…', () => window.viber.invoke('ws:rescan'))}>
              <RefreshCw size={13} />
            </button>
          </span>
        </div>
      )}

      {note && <p className="small muted note">{note}</p>}
      {!snapshot.draft && proposals.length > 0 && (
        <div className="proposal-banner">
          <span>
            {proposals.length} new proposal{proposals.length > 1 ? 's' : ''} from the code (dashed on the map)
          </span>
          <button className="btn small" onClick={() => apply({ op: 'acceptAll' })}>
            Accept all
          </button>
        </div>
      )}

      <section>
        <h3>Actors</h3>
        <p className="muted small">Who uses the system. Boxes they reach are front-facing to them.</p>
        {actors.map((a) => (
          <div key={a.id} className={`list-row ${a.proposed ? 'proposed' : ''}`} onClick={() => select({ kind: 'node', id: a.id })}>
            <KindIcon node={a} size={13} />
            <span className="list-label">{a.label}</span>
            <span className="tree-meta">{a.actorType} · {reachCount(a.id)} box{reachCount(a.id) === 1 ? '' : 'es'}</span>
            <span className="tree-actions">
              <button title="Highlight what this actor faces" onClick={(e) => (e.stopPropagation(), setActorFocus(a.id))}>
                <Crosshair size={12} />
              </button>
              {a.proposed && (
                <button title="Accept" onClick={(e) => (e.stopPropagation(), apply({ op: 'accept', id: a.id }))}>
                  <Check size={12} />
                </button>
              )}
              <button title="Edit" onClick={(e) => (e.stopPropagation(), setModal({ kind: 'actor', actorId: a.id }))}>
                <ChevronRight size={12} />
              </button>
              <button title={a.proposed ? 'Dismiss' : 'Remove'} onClick={(e) => (e.stopPropagation(), apply({ op: 'remove', id: a.id }))}>
                <X size={12} />
              </button>
            </span>
          </div>
        ))}
        <button className="btn small ghost" onClick={() => setModal({ kind: 'actor' })}>
          <UserPlus size={12} /> Declare an actor
        </button>
      </section>

      <section>
        <h3>Boxes</h3>
        <div className="tree">{(children.get(undefined) ?? []).map((n) => row(n, 0))}</div>
        {snapshot.unmapped.length > 0 && <p className="muted small">{snapshot.unmapped.length} files belong to no box.</p>}
      </section>

      <section>
        <h3>External services & data</h3>
        {services.map((s) => (
          <div key={s.id} className={`list-row ${s.proposed ? 'proposed' : ''}`} onClick={() => select({ kind: 'node', id: s.id })}>
            <KindIcon node={s} size={13} />
            <Editable value={s.label} onSave={(label) => apply({ op: 'rename', id: s.id, label })} className="list-label" />
            <span className="tree-meta">{s.tech ?? ''}</span>
            <span className="tree-actions">
              {s.proposed && (
                <button title="Accept" onClick={(e) => (e.stopPropagation(), apply({ op: 'accept', id: s.id }))}>
                  <Check size={12} />
                </button>
              )}
              <button title={s.proposed ? 'Dismiss' : 'Remove'} onClick={(e) => (e.stopPropagation(), apply({ op: 'remove', id: s.id }))}>
                <X size={12} />
              </button>
            </span>
          </div>
        ))}
        {services.length === 0 && <p className="muted small">None detected.</p>}
      </section>

      <section>
        <h3>Guardrails</h3>
        <p className="muted small">Dependencies that must never exist. Violations show as red edges.</p>
        {(model.guardrails ?? []).map((g) => {
          const v = (model.violations ?? []).filter((x) => x.guardrail === g.id).length
          return (
            <div key={g.id} className={`list-row ${v ? 'violating' : ''}`}>
              <ShieldAlert size={13} />
              <span className="list-label">
                {label(g.from)} ↛ {label(g.to)}
              </span>
              <span className={`tree-meta ${v ? 'bad' : 'ok'}`}>{v ? `${v} violation${v > 1 ? 's' : ''}` : 'ok'}</span>
              <span className="tree-actions">
                <button title="Remove" onClick={() => apply({ op: 'removeGuardrail', id: g.id })}>
                  <X size={12} />
                </button>
              </span>
            </div>
          )
        })}
        <button className="btn small ghost" onClick={() => setModal({ kind: 'guardrail' })}>
          <Plus size={12} /> Add guardrail
        </button>
      </section>
    </div>
  )
}
