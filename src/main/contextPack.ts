import type { ArchModel, ArchNode } from '@shared/model'
import type { ContextItem } from '@shared/events'
import type { Workspace } from './workspace'
import { predictionsText, whereToChange } from './targeting'

// Compact, deterministic text views of the architecture. The overview is stable between tasks,
// so it works as a cached prompt prefix; the per-task pack is scoped to the selected boxes.

export const estimateTokens = (s: string): number => Math.ceil(s.length / 3.8)

/** A box's spec as text: what it must do, offer, refuse, and how "done" is judged. */
export function specText(n: ArchNode): string {
  const s = n.spec ?? {}
  if (!n.spec && !n.style && !n.tech) return ''
  const out: string[] = []
  if (n.tech) out.push(`Tech: ${n.tech} (use it; do not switch frameworks)`)
  if (s.status) out.push(`Status: ${s.status}${s.autonomy ? ` · autonomy: ${s.autonomy}` : ''}`)
  if (s.responsibility) out.push(`Responsibility: ${s.responsibility}`)
  if (s.outOfScope?.length) out.push(`Not this box's job: ${s.outOfScope.join('; ')}`)
  if (s.contract?.length)
    out.push('Contract (the only way in):', ...s.contract.map((c) => `- [${c.kind}] ${c.name}${c.input ? ` ← ${c.input}` : ''}${c.output ? ` → ${c.output}` : ''}${c.note ? ` (${c.note})` : ''}`))
  if (s.sideEffects) out.push(`Side effects allowed: ${s.sideEffects.join(', ') || 'none (pure)'}. Do not add any other kind (network, filesystem, database, queue, process, env, global-state).`)
  if (s.contract?.some((c) => c.input || c.output)) out.push('Keep handler inputs/outputs exactly as typed in the contract; changing them needs propose_contract_change.')
  const st = n.style
  if (st && (st.maxFunctionLines || st.maxNesting || st.publicDocs))
    out.push(`Code style (checked): ${[st.maxFunctionLines ? `functions at most ${st.maxFunctionLines} lines` : '', st.maxNesting ? `nesting at most ${st.maxNesting} levels (prefer early returns)` : '', st.publicDocs ? 'a one-line docstring on every public function' : ''].filter(Boolean).join('; ')}.`)
  if (s.acceptance?.length) out.push('Acceptance (done means):', ...s.acceptance.map((a) => `- ${a}`))
  if (s.decisions?.length) out.push('Decisions:', ...s.decisions.slice(-5).map((d) => `- ${d.date}: ${d.text}`))
  return out.join('\n')
}


const byId = (m: ArchModel): Map<string, ArchNode> => new Map(m.nodes.map((n) => [n.id, n]))

function depth(m: ArchModel, id: string): number {
  const ids = byId(m)
  let d = 1
  let cur = ids.get(id)?.parent
  while (cur) {
    d++
    cur = ids.get(cur)?.parent
  }
  return d
}

export function overviewText(m: ArchModel, zoom = 2): string {
  const ids = byId(m)
  const lines: string[] = [`# ${m.name} — architecture (from Viber, .arch/model.yaml)`]
  const actors = m.nodes.filter((n) => n.kind === 'actor')
  if (actors.length) {
    lines.push('', '## Actors (who uses the system → boxes they reach)')
    for (const a of actors) {
      const reach = m.edges.filter((e) => e.source === a.id).map((e) => ids.get(e.target)?.label ?? e.target)
      lines.push(`- ${a.label} [${a.actorType}]${a.purpose ? ': ' + a.purpose : ''} → ${reach.join(', ') || '—'}`)
    }
  }
  lines.push('', '## Boxes (id — label: purpose)')
  const walk = (parent: string | undefined, indent: string): void => {
    for (const n of m.nodes.filter((x) => x.kind === 'box' && x.parent === parent)) {
      if (depth(m, n.id) > zoom) continue
      const purpose = n.purpose.length > 140 ? n.purpose.slice(0, 137) + '…' : n.purpose
      lines.push(`${indent}- ${n.id} — ${n.label}${n.tech ? ` (${n.tech})` : ''}: ${purpose}`)
      walk(n.id, indent + '  ')
    }
  }
  walk(undefined, '')
  const services = m.nodes.filter((n) => n.kind === 'external' || n.kind === 'datastore')
  if (services.length) {
    lines.push('', '## External services & data stores')
    for (const s of services) lines.push(`- ${s.id} — ${s.label}${s.tech ? ` (${s.tech})` : ''}`)
  }
  const rep = (id: string): string => {
    let cur = ids.get(id)
    while (cur && cur.parent && depth(m, cur.id) > zoom) cur = ids.get(cur.parent)
    return cur?.id ?? id
  }
  const agg = new Map<string, { n: number; labels: Set<string> }>()
  for (const e of m.edges) {
    if (ids.get(e.source)?.kind === 'actor') continue
    const s = rep(e.source)
    const t = rep(e.target)
    if (s === t) continue
    const k = `${s} → ${t}`
    const g = agg.get(k) ?? { n: 0, labels: new Set() }
    g.n += e.weight ?? 1
    g.labels.add(e.label)
    agg.set(k, g)
  }
  if (agg.size) {
    lines.push('', '## Dependencies (from → to: what crosses)')
    for (const [k, g] of [...agg.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 80)) lines.push(`- ${k}: ${[...g.labels].slice(0, 3).join(', ')}`)
  }
  if (m.guardrails?.length) {
    lines.push('', '## Guardrails (never add these dependencies)')
    for (const g of m.guardrails) lines.push(`- ${g.from} must not depend on ${g.to}${g.reason ? ` — ${g.reason}` : ''}`)
  }
  return lines.join('\n')
}

export function boxText(ws: Workspace, id: string): string {
  const m = ws.built?.model
  if (!m) return 'No model loaded.'
  const n = resolveNode(m, id)
  if (!n) return `Unknown box "${id}". Use arch_overview to list box ids.`
  const ids = byId(m)
  const members = new Set([n.id, ...m.nodes.filter((x) => isDescendant(m, x.id, n.id)).map((x) => x.id)])
  const label = (x: string): string => ids.get(x)?.label ?? x
  const out: string[] = [`# ${n.label} (${n.id}) — ${n.kind}${n.tech ? `, ${n.tech}` : ''}`, n.purpose]
  const spec = specText(n)
  if (spec) out.push('', '## Spec', spec)
  if (n.rules?.length) out.push('', '## Rules for this box (must follow)', ...n.rules.map((r) => `- ${r}`))
  if (n.paths?.length) out.push('', `Paths: ${n.paths.join(', ')}`)
  const kids = m.nodes.filter((x) => x.parent === n.id)
  if (kids.length) out.push(`Contains: ${kids.map((k) => `${k.id} (${k.label})`).join(', ')}`)
  const files = m.nodes.filter((x) => members.has(x.id)).flatMap((x) => x.files)
  if (files.length) out.push('', `## Files (${files.length})`, ...files.slice(0, 40).map((f) => `- ${f}`), ...(files.length > 40 ? [`- … ${files.length - 40} more`] : []))
  const routes = m.nodes.filter((x) => members.has(x.id)).flatMap((x) => x.routes ?? [])
  if (routes.length) out.push('', '## Routes', ...routes.slice(0, 40).map((r) => `- ${r}`))
  const syms = m.nodes.filter((x) => members.has(x.id)).flatMap((x) => x.symbols)
  if (syms.length) out.push('', '## Public symbols (signatures only; use code_symbol for bodies)', ...syms.slice(0, 50).map((s) => `- ${s.signature}  [${s.file}:${s.line}]`))
  const inc = m.edges.filter((e) => members.has(e.target) && !members.has(e.source))
  const outE = m.edges.filter((e) => members.has(e.source) && !members.has(e.target))
  if (inc.length) out.push('', '## Used by', ...inc.slice(0, 30).map((e) => `- ${label(e.source)} → ${label(e.target)}: ${e.contract.slice(0, 6).join('; ') || e.label}`))
  if (outE.length) out.push('', '## Depends on', ...outE.slice(0, 30).map((e) => `- ${label(e.source)} → ${label(e.target)}: ${e.contract.slice(0, 6).join('; ') || e.label}`))
  const tests = m.nodes.filter((x) => members.has(x.id)).flatMap((x) => x.tests ?? [])
  if (tests.length) out.push('', '## Tests', ...tests.slice(0, 20).map((t) => `- ${t}`))
  const facing = m.edges.filter((e) => members.has(e.target) && ids.get(e.source)?.kind === 'actor').map((e) => label(e.source))
  if (facing.length) out.push('', `Front-facing to: ${[...new Set(facing)].join(', ')}`)
  return out.join('\n')
}

export { keywords, stem, termCounts } from './engine/words'
import { keywords } from './engine/words'

const relevance = (text: string, kws: string[]): number => {
  const t = text.toLowerCase()
  return kws.reduce((a, k) => a + (t.includes(k) ? 1 : 0), 0)
}

/**
 * The scoped summary sent with a task: purpose, rules, contracts, and only the routes and
 * symbols that look relevant to the prompt. Everything else is one arch_box / code_find away.
 */
export function focusedBoxText(ws: Workspace, id: string, prompt: string): string {
  const m = ws.built?.model
  const n = m ? resolveNode(m, id) : undefined
  if (!m || !n) return ''
  const kws = keywords(prompt)
  const members = new Set([n.id, ...m.nodes.filter((x) => isDescendant(m, x.id, n.id)).map((x) => x.id)])
  const inside = m.nodes.filter((x) => members.has(x.id))
  const label = (x: string): string => m.nodes.find((y) => y.id === x)?.label ?? x
  const out: string[] = [`## ${n.label} (${n.id})`, n.purpose]
  const spec = specText(n)
  if (spec) out.push(spec)
  if (n.rules?.length) out.push('Rules (must follow):', ...n.rules.map((r) => `- ${r}`))
  const files = inside.flatMap((x) => x.files)
  out.push(`Files (${files.length}): ${files.slice(0, 12).join(', ')}${files.length > 12 ? ', …' : ''}`)
  const routes = inside.flatMap((x) => x.routes ?? [])
  if (routes.length) {
    const ranked = [...routes].sort((a, b) => relevance(b, kws) - relevance(a, kws))
    const hits = ranked.filter((r) => relevance(r, kws) > 0).slice(0, 8)
    out.push(`Routes (${routes.length}${hits.length ? `; relevant: ${hits.join(', ')}` : ''})`)
  }
  const syms = inside.flatMap((x) => x.symbols)
  if (syms.length) {
    const hits = syms.filter((s) => relevance(s.name + ' ' + s.signature, kws) > 0).slice(0, 8)
    out.push(`Symbols (${syms.length}${hits.length ? '; relevant:' : ''})`, ...hits.map((s) => `- ${s.signature} [${s.file}:${s.line}]`))
  }
  const inc = [...new Set(m.edges.filter((e) => members.has(e.target) && !members.has(e.source)).map((e) => label(e.source)))]
  const outE = [...new Set(m.edges.filter((e) => members.has(e.source) && !members.has(e.target)).map((e) => label(e.target)))]
  if (inc.length) out.push(`Used by: ${inc.slice(0, 8).join(', ')}`)
  if (outE.length) out.push(`Depends on: ${outE.slice(0, 8).join(', ')}`)
  return out.join('\n')
}

export function resolveNode(m: ArchModel, idOrLabel: string): ArchNode | undefined {
  const q = idOrLabel.trim().toLowerCase()
  return m.nodes.find((n) => n.id.toLowerCase() === q) ?? m.nodes.find((n) => n.label.toLowerCase() === q) ?? m.nodes.find((n) => n.id.toLowerCase().endsWith('/' + q))
}

export function isDescendant(m: ArchModel, id: string, ancestor: string): boolean {
  const ids = byId(m)
  let cur = ids.get(id)?.parent
  while (cur) {
    if (cur === ancestor) return true
    cur = ids.get(cur)?.parent
  }
  return false
}

/** The per-task context pack for a scope, plus an honest estimate of exploring without it. */
export async function buildContextPack(
  ws: Workspace,
  scope: string[],
  prompt = ''
): Promise<{ items: ContextItem[]; text: string; naive: number; naiveNote: string; overview: string }> {
  const m = ws.built!.model
  const overview = overviewText(m, 2)
  const items: ContextItem[] = [{ label: 'Architecture overview', detail: 'cached prompt prefix · zoom: Service', tokens: estimateTokens(overview) }]
  const parts: string[] = []
  let scopeFiles: string[] = []
  for (const id of scope) {
    const n = resolveNode(m, id)
    if (!n) continue
    const t = focusedBoxText(ws, n.id, prompt)
    parts.push(t)
    items.push({ label: `${n.label} · purpose, rules, relevant contracts`, detail: 'filtered to the task; arch_box has the rest', tokens: estimateTokens(t) })
    scopeFiles = scopeFiles.concat(m.nodes.filter((x) => x.id === n.id || isDescendant(m, x.id, n.id)).flatMap((x) => x.files))
  }
  // Naive estimate: an agent without a map typically greps around, then reads the scoped files in
  // full plus about half of their direct dependents/callers.
  const deps = ws.res?.deps ?? []
  const neighbours = new Set<string>()
  for (const d of deps) {
    if (scopeFiles.includes(d.from)) neighbours.add(d.to)
    if (scopeFiles.includes(d.to)) neighbours.add(d.from)
  }
  for (const f of scopeFiles) neighbours.delete(f)
  let chars = 0
  for (const f of scopeFiles) chars += (ws.fileInfo(f)?.lines ?? 0) * 38
  let nchars = 0
  for (const f of neighbours) nchars += (ws.fileInfo(f)?.lines ?? 0) * 38
  const greps = Math.min(12, 3 + scope.length * 3)
  const naive = Math.round(chars / 3.8 + nchars / 3.8 / 2 + greps * 900 + estimateTokens(overview) * 0.3)
  // The biggest saver: tell the agent where to look before it starts looking.
  if (prompt) {
    const preds = whereToChange(ws, prompt, { scope, limit: 6 })
    if (preds.length) {
      const t = `<targets>\nLikely edit sites for this task (ranked):\n${predictionsText(preds)}\n</targets>`
      parts.push(t)
      items.push({ label: 'Likely edit sites', detail: preds.slice(0, 3).map((p) => p.file.split('/').pop()).join(' · '), tokens: estimateTokens(t) })
    }
  }
  return {
    items,
    text: parts.join('\n\n---\n\n'),
    overview,
    naive,
    naiveNote: `≈ ${scopeFiles.length} whole-file reads, ${Math.ceil(neighbours.size / 2)} neighbour reads and ${greps} searches`
  }
}
