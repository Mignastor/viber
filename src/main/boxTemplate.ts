import type { DefsOp } from '@shared/api'
import type { ArchModel, ArchNode, BoxSpec, ContractItem } from '@shared/model'

// .box templates: a component as a reusable, shareable file. The spec is the template (responsibility,
// contract, acceptance, side effects, style, rules, tech); code is optional. Importing creates a box,
// planned when the template has no code, so an agent builds it to the spec.

export const BOX_SCHEMA = 'viber.box/1'
const MAX_CODE_BYTES = 2 * 1024 * 1024

export interface BoxTemplate {
  schema: typeof BOX_SCHEMA
  name: string
  label: string
  description?: string
  tech?: string
  spec: Pick<BoxSpec, 'responsibility' | 'outOfScope' | 'contract' | 'acceptance' | 'sideEffects' | 'style'>
  rules?: string[]
  /** Contracts this box needs from others, so an importer can wire it up. */
  requires?: { kind: string; uses: string[]; note?: string }[]
  /** Source files relative to the box folder, when exported with code. */
  files?: Record<string, string>
}

const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'box'

/** Common folder of a box's files (what code paths are made relative to). */
function baseOf(files: string[]): string {
  if (!files.length) return ''
  const parts = files.map((f) => f.split('/').slice(0, -1))
  const out: string[] = []
  for (let i = 0; ; i++) {
    const seg = parts[0][i]
    if (seg === undefined || parts.some((p) => p[i] !== seg)) break
    out.push(seg)
  }
  return out.join('/')
}

export function toTemplate(model: ArchModel, n: ArchNode, code?: Record<string, string>): BoxTemplate {
  const s = n.spec ?? {}
  const requires = model.edges
    .filter((e) => e.source === n.id && e.kind !== 'uses' && model.nodes.find((x) => x.id === e.target)?.kind !== 'actor')
    .map((e) => {
      const target = model.nodes.find((x) => x.id === e.target)
      return { kind: e.kind, uses: e.contract.slice(0, 12), note: target ? `provided by "${target.label}" in the source project` : undefined }
    })
  let files: Record<string, string> | undefined
  if (code && Object.keys(code).length) {
    const base = baseOf(Object.keys(code))
    let bytes = 0
    files = {}
    for (const [p, text] of Object.entries(code)) {
      bytes += text.length
      if (bytes > MAX_CODE_BYTES) throw new Error('This box has more than 2 MB of code; export the spec only.')
      files[base ? p.slice(base.length + 1) : p] = text
    }
  }
  return {
    schema: BOX_SCHEMA,
    name: slug(n.label),
    label: n.label,
    description: s.responsibility ?? n.purpose,
    tech: n.tech,
    spec: { responsibility: s.responsibility ?? n.purpose, outOfScope: s.outOfScope, contract: s.contract, acceptance: s.acceptance, sideEffects: s.sideEffects, style: s.style },
    rules: n.rules?.length ? n.rules : undefined,
    requires: requires.length ? requires : undefined,
    files
  }
}

/** Validate a parsed .box file; returns an error message or null. */
export function checkTemplate(t: unknown): string | null {
  const x = t as Partial<BoxTemplate>
  if (!x || typeof x !== 'object') return 'Not a .box template.'
  if (x.schema !== BOX_SCHEMA) return `Unsupported template format (${String(x.schema)}).`
  if (!x.label || typeof x.label !== 'string') return 'The template has no label.'
  if (x.files && Object.keys(x.files).some((p) => p.startsWith('/') || p.split(/[\\/]/).includes('..'))) return 'The template has file paths outside its folder.'
  const kinds: ContractItem['kind'][] = ['http', 'event', 'function', 'queue', 'data']
  if (x.spec?.contract?.some((c) => !kinds.includes(c.kind) || typeof c.name !== 'string')) return 'The template has an invalid contract item.'
  return null
}

/** Ops that add the template as a box, and the files to write (relative to the repo) when it carries code. */
export function fromTemplate(t: BoxTemplate, model: ArchModel, parent?: string): { ops: DefsOp[]; files: Record<string, string>; id: string; folder: string } {
  const taken = new Set(model.nodes.map((n) => n.id))
  const parentNode = parent ? model.nodes.find((n) => n.id === parent) : undefined
  let id = parent ? `${parent}/${t.name}` : t.name
  while (taken.has(id)) id += '-2'
  const parentDir = parentNode?.paths?.find((p) => !/\.\w+$/.test(p))
  const folder = parentDir ? `${parentDir}/${id.split('/').pop()}` : id
  const hasCode = !!t.files && Object.keys(t.files).length > 0
  const ops: DefsOp[] = [
    {
      op: 'addBox',
      id,
      label: t.label,
      parent,
      tech: t.tech,
      paths: hasCode ? [folder] : [],
      spec: { ...t.spec, status: hasCode ? 'built' : 'planned', autonomy: 'ask', decisions: [{ date: new Date().toISOString().slice(0, 10), text: `Imported from the "${t.label}" template.` }] }
    }
  ]
  if (t.rules?.length) ops.push({ op: 'setRules', id, rules: t.rules })
  const files: Record<string, string> = {}
  for (const [p, text] of Object.entries(t.files ?? {})) files[`${folder}/${p}`] = text
  return { ops, files, id, folder }
}
