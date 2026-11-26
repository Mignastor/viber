import { useState } from 'react'
import { CircleCheck, CircleHelp, CircleX, Plus, X } from 'lucide-react'
import type { ArchNode, Autonomy, BoxSpec, BoxStatus, CodeStyle, ContractCheck, ContractItem, EffectKind } from '@shared/model'
import { apply, Editable } from './ModelPanel'
import { useModel } from '../store'
import { recommendTech } from '@shared/techAdvice'

// A box as a spec: the human owns responsibility, contract and acceptance; agents own the code.

const STATUSES: BoxStatus[] = ['planned', 'building', 'built', 'verified']
const AUTONOMY: { id: Autonomy; label: string; hint: string }[] = [
  { id: 'ask', label: 'Ask me', hint: 'The agent proposes a plan and waits for your approval' },
  { id: 'tell', label: 'Tell me', hint: 'Plans are approved automatically; you review the result' },
  { id: 'auto', label: 'Just do it', hint: 'Tests are the gate; isolated builds merge on green' }
]
const KINDS: ContractItem['kind'][] = ['http', 'function', 'event', 'queue', 'data']
const EFFECTS: { id: EffectKind; label: string }[] = [
  { id: 'network', label: 'Network' },
  { id: 'database', label: 'Database' },
  { id: 'queue', label: 'Queue' },
  { id: 'filesystem', label: 'Files' },
  { id: 'process', label: 'Subprocess' },
  { id: 'env', label: 'Env vars' },
  { id: 'global-state', label: 'Global state' }
]

/** Max function lines, max nesting, docstrings on public functions. Empty = not checked (or inherited). */
export function StyleFields({ style, inherited, onChange }: { style: CodeStyle; inherited?: CodeStyle; onChange: (s: CodeStyle) => void }) {
  const num = (v: string): number | undefined => (v.trim() ? Math.max(1, Number(v) || 0) : undefined)
  return (
    <div className="style-fields">
      <label>
        Max lines / function
        <input type="number" min={1} value={style.maxFunctionLines ?? ''} placeholder={inherited?.maxFunctionLines ? String(inherited.maxFunctionLines) : 'off'} onChange={(e) => onChange({ ...style, maxFunctionLines: num(e.target.value) })} />
      </label>
      <label>
        Max nesting
        <input type="number" min={1} value={style.maxNesting ?? ''} placeholder={inherited?.maxNesting ? String(inherited.maxNesting) : 'off'} onChange={(e) => onChange({ ...style, maxNesting: num(e.target.value) })} />
      </label>
      <label className="check-row">
        <input type="checkbox" checked={style.publicDocs ?? inherited?.publicDocs ?? false} onChange={(e) => onChange({ ...style, publicDocs: e.target.checked })} />
        Docstrings on public functions
      </label>
    </div>
  )
}

function CheckBadge({ check }: { check?: ContractCheck }) {
  if (!check) return null
  const Icon = check.status === 'ok' ? CircleCheck : check.status === 'mismatch' ? CircleX : CircleHelp
  const title = check.status === 'ok' ? 'Matches the code' : (check.detail ?? check.status)
  return (
    <span className={`check-badge ${check.status}`} title={title}>
      <Icon size={12} />
    </span>
  )
}

/** Which side effects the box may have; detected ones the spec does not allow are flagged. */
function EffectsEditor({ node, onChange }: { node: ArchNode; onChange: (v: EffectKind[] | undefined) => void }) {
  const allowed = node.spec?.sideEffects
  const detected = new Map((node.effects ?? []).map((e) => [e.kind, e.at]))
  return (
    <>
      <div className="effect-chips">
        {EFFECTS.map((e) => {
          const on = allowed?.includes(e.id) ?? false
          const found = detected.get(e.id)
          const bad = !!allowed && !on && !!found
          return (
            <button
              key={e.id}
              className={`effect-chip ${on ? 'on' : ''} ${found ? 'found' : ''} ${bad ? 'bad' : ''}`}
              title={found ? `Found in the code:\n${found.join('\n')}` : 'Not found in the code'}
              onClick={() => onChange(on ? (allowed ?? []).filter((k) => k !== e.id) : [...(allowed ?? []), e.id])}
            >
              {e.label}
            </button>
          )
        })}
      </div>
      {!allowed ? (
        <div className="row-gap">
          <span className="muted small">Not declared yet. Found in the code: {[...detected.keys()].join(', ') || 'nothing'}.</span>
          <button className="btn small" onClick={() => onChange([...detected.keys()])}>
            {detected.size ? 'Allow what it does today' : 'Mark as pure'}
          </button>
        </div>
      ) : (
        <span className="muted small">
          {allowed.length ? 'Anything else the code does shows up as drift.' : 'Pure: any side effect shows up as drift.'}{' '}
          <button className="link-btn" onClick={() => onChange(undefined)}>
            Stop checking
          </button>
        </span>
      )}
    </>
  )
}

function ListEditor({ items, placeholder, onChange }: { items: string[]; placeholder: string; onChange: (v: string[]) => void }) {
  const [draft, setDraft] = useState('')
  const add = (): void => {
    if (!draft.trim()) return
    onChange([...items, draft.trim()])
    setDraft('')
  }
  return (
    <>
      <ul className="rules">
        {items.map((r, i) => (
          <li key={i}>
            <Editable value={r} onSave={(v) => onChange(items.map((x, j) => (j === i ? v : x)).filter(Boolean))} />
            <button className="icon-btn tiny" onClick={() => onChange(items.filter((_, j) => j !== i))} aria-label="Remove">
              <X size={11} />
            </button>
          </li>
        ))}
      </ul>
      <div className="row-gap">
        <input className="edit-input" value={draft} placeholder={placeholder} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} />
        <button className="btn small" disabled={!draft.trim()} onClick={add} aria-label="Add">
          <Plus size={12} />
        </button>
      </div>
    </>
  )
}

function ContractEditor({ items, checks, onChange }: { items: ContractItem[]; checks?: Record<string, ContractCheck>; onChange: (v: ContractItem[]) => void }) {
  const [d, setD] = useState<ContractItem>({ kind: 'http', name: '' })
  const add = (): void => {
    if (!d.name.trim()) return
    onChange([...items, { ...d, name: d.name.trim(), input: d.input?.trim() || undefined, output: d.output?.trim() || undefined }])
    setD({ kind: d.kind, name: '' })
  }
  return (
    <>
      <ul className="contract-items">
        {items.map((c, i) => (
          <li key={i}>
            <CheckBadge check={checks?.[c.name]} />
            <span className="contract-kind">{c.kind}</span>
            <span className="mono">{c.name}</span>
            {(c.input || c.output) && (
              <span className="muted small mono">
                {c.input ? ` ← ${c.input}` : ''}
                {c.output ? ` → ${c.output}` : ''}
              </span>
            )}
            <button className="icon-btn tiny" onClick={() => onChange(items.filter((_, j) => j !== i))} aria-label="Remove">
              <X size={11} />
            </button>
          </li>
        ))}
      </ul>
      <div className="contract-add">
        <select value={d.kind} onChange={(e) => setD({ ...d, kind: e.target.value as ContractItem['kind'] })} aria-label="Kind">
          {KINDS.map((k) => (
            <option key={k}>{k}</option>
          ))}
        </select>
        <input className="edit-input mono" value={d.name} placeholder={d.kind === 'http' ? 'POST /api/invoices' : d.kind === 'event' ? 'invoice.created' : 'createInvoice(orderId)'} onChange={(e) => setD({ ...d, name: e.target.value })} />
        <input className="edit-input mono" value={d.input ?? ''} placeholder="input" onChange={(e) => setD({ ...d, input: e.target.value })} />
        <input className="edit-input mono" value={d.output ?? ''} placeholder="output" onChange={(e) => setD({ ...d, output: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && add()} />
        <button className="btn small" disabled={!d.name.trim()} onClick={add} aria-label="Add contract item">
          <Plus size={12} />
        </button>
      </div>
    </>
  )
}

const useModelStyle = (): CodeStyle | undefined => useModel()?.style

/** The box's language/framework, with Viber's suggestion for its role when it differs. */
function TechField({ node }: { node: ArchNode }) {
  const model = useModel()
  const advice = model ? recommendTech(node, model) : null
  const differs = advice && (node.tech ?? '').toLowerCase() !== advice.tech.toLowerCase()
  return (
    <div className="spec-block">
      <span className="spec-label">Tech — the language agents write this box in</span>
      <Editable value={node.tech ?? ''} placeholder={advice ? advice.tech : 'e.g. TypeScript + React'} onSave={(v) => void apply({ op: 'setTech', id: node.id, tech: v })} />
      {advice && differs && (
        <div className="tech-advice">
          <span className="muted small">
            {node.tech ? 'Viber would pick' : 'Suggested'}: <strong>{advice.tech}</strong> ({advice.role} box). {advice.reason}
          </span>
          {!node.files.length && (
            <button className="link-btn small" onClick={() => void apply({ op: 'setTech', id: node.id, tech: advice.tech })}>
              Use {advice.tech}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

export function SpecEditor({ node }: { node: ArchNode }) {
  const spec = node.spec ?? {}
  const set = (patch: BoxSpec): void => void apply({ op: 'setSpec', id: node.id, spec: patch })
  return (
    <div className="spec">
      <h3>Spec</h3>
      <div className="spec-row">
        <label className="spec-field">
          Status
          <select value={spec.status ?? (node.files.length ? 'built' : 'planned')} onChange={(e) => set({ status: e.target.value as BoxStatus })}>
            {STATUSES.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </label>
        <div className="spec-field">
          Autonomy
          <div className="seg small">
            {AUTONOMY.map((a) => (
              <button key={a.id} className={(spec.autonomy ?? 'ask') === a.id ? 'on' : ''} title={a.hint} onClick={() => set({ autonomy: a.id })}>
                {a.label}
              </button>
            ))}
          </div>
        </div>
      </div>
      <TechField node={node} />
      <div className="spec-block">
        <span className="spec-label">Responsibility</span>
        <Editable value={spec.responsibility ?? ''} multiline placeholder="The one thing this box is responsible for" onSave={(v) => set({ responsibility: v })} className="purpose" />
      </div>
      <div className="spec-block">
        <span className="spec-label">Not its job</span>
        <ListEditor items={spec.outOfScope ?? []} placeholder="e.g. Sending emails (that's Notifications)" onChange={(v) => set({ outOfScope: v })} />
      </div>
      <div className="spec-block">
        <span className="spec-label">Contract — the only way in</span>
        <ContractEditor items={spec.contract ?? []} checks={node.contractCheck} onChange={(v) => set({ contract: v })} />
      </div>
      <div className="spec-block">
        <span className="spec-label">Side effects — what it may do to the world</span>
        <EffectsEditor node={node} onChange={(v) => set({ sideEffects: v })} />
      </div>
      <div className="spec-block">
        <span className="spec-label">Code style — empty fields use the project's</span>
        <StyleFields style={spec.style ?? {}} inherited={useModelStyle()} onChange={(v) => set({ style: v })} />
      </div>
      <div className="spec-block">
        <span className="spec-label">Acceptance — done means</span>
        <ListEditor items={spec.acceptance ?? []} placeholder="e.g. An invoice total includes VAT" onChange={(v) => set({ acceptance: v })} />
      </div>
      {spec.decisions && spec.decisions.length > 0 && (
        <div className="spec-block">
          <span className="spec-label">Decisions</span>
          <ul className="contract">
            {spec.decisions.map((d, i) => (
              <li key={i}>
                <span className="muted">{d.date}</span> {d.text}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
