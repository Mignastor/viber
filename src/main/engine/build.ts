import path from 'path'
import type { ActorType, ArchEdge, ArchModel, ArchNode, CodeSymbol, CodeStyle, ContractCheck, EffectKind, DeclaredEdge, DriftItem, Guardrail, Journey, Violation } from '@shared/model'
import type { ScanFile, ScanResult } from './scan'
import type { Resolution } from './resolve'
import { proposeBoxes, humanize, type BoxDef } from './group'
import { hostService, knownService, pathsMatch, topicsMatch } from './detect'
import { checkFunction, checkHttp } from './contracts'
import { LANGS } from './languages'

// Assembles the architecture model from (curated definitions + a fresh scan).
// Definitions say *what the boxes are*; the scan says *what is in them and how they connect*.

const P = path.posix

export interface ActorDef {
  id: string
  label: string
  type: ActorType
  description?: string
  /** Boxes this actor reaches directly (front-facing boxes). */
  reaches?: string[]
  /** Route patterns this actor uses, e.g. "/admin/*" or "POST /api/orders". Matched against box routes. */
  routes?: string[]
}

export interface ServiceDef {
  id: string
  label: string
  kind: 'external' | 'datastore'
  tech?: string
  purpose?: string
  /** Package names or hosts that indicate a use of this service. */
  match?: string[]
}

export interface ArchDefs {
  version: 1
  name: string
  boxes: BoxDef[]
  actors: ActorDef[]
  services: ServiceDef[]
  guardrails: Guardrail[]
  /** Dependencies the human designed (contracts between boxes). */
  edges: DeclaredEdge[]
  /** Actor journeys through the boxes. */
  journeys: Journey[]
  /** Project-wide code style (boxes can override). */
  style?: CodeStyle
  /** Proposals the user dismissed, so they are not proposed again. */
  dismissed: string[]
}

export const emptyDefs = (name: string): ArchDefs => ({ version: 1, name, boxes: [], actors: [], services: [], guardrails: [], edges: [], journeys: [], dismissed: [] })

export interface BuildResult {
  model: ArchModel
  /** file → owning node id (boxes only). */
  fileOwner: Record<string, string>
  /** Files no box owns. */
  unmapped: string[]
}

/** Longest path-prefix match of a file against box paths. */
export function ownerOf(boxes: BoxDef[], file: string): string | null {
  let best: { id: string; len: number } | null = null
  for (const b of boxes) {
    for (const p of b.paths) {
      const hit = p === file || p === '' || file.startsWith(p + '/')
      const len = p === file ? 1e6 : p.length
      // On a tie, the later (deeper) definition wins: children are listed after their parent.
      if (hit && (!best || len >= best.len)) best = { id: b.id, len }
    }
  }
  return best?.id ?? null
}

const sigOf = (syms: CodeSymbol[], name: string): string => syms.find((s) => s.name === name && s.exported)?.signature ?? syms.find((s) => s.name === name)?.signature ?? name

export function buildModel(scan: ScanResult, res: Resolution, defs: ArchDefs, opts: { includeProposals: boolean; descriptions?: Record<string, string> }): BuildResult {
  const dismissed = new Set(defs.dismissed)
  const fileByPath = new Map(scan.files.map((f) => [f.path, f]))

  // ── Boxes: curated definitions, plus fresh proposals for folders nobody has curated yet ──
  const boxDefs: (BoxDef & { proposed?: boolean })[] = [...defs.boxes]
  if (opts.includeProposals) {
    const known = new Set(defs.boxes.flatMap((b) => b.paths))
    for (const p of proposeBoxes(scan, defs.name, res.deps)) {
      if (dismissed.has(p.id) || known.has(p.paths[0]) || boxDefs.some((b) => b.id === p.id)) continue
      // Re-parent under the deepest curated box that contains it.
      const parent = p.parent && boxDefs.some((b) => b.id === p.parent) ? p.parent : (ownerOf(boxDefs, p.paths[0] + '/x') ?? undefined)
      boxDefs.push({ ...p, parent, proposed: defs.boxes.length > 0 || undefined })
    }
  }
  const boxIds = new Set(boxDefs.map((b) => b.id))

  const fileOwner: Record<string, string> = {}
  const unmapped: string[] = []
  for (const f of scan.files) {
    if (f.flags.includes('test')) continue
    const o = ownerOf(boxDefs, f.path)
    if (o) fileOwner[f.path] = o
    else unmapped.push(f.path)
  }

  // Tests map to the box they exercise most (by imports), else by mirrored path.
  const testsOf = new Map<string, string[]>()
  for (const f of scan.files) {
    if (!f.flags.includes('test')) continue
    const votes = new Map<string, number>()
    for (const d of res.deps) if (d.from === f.path && fileOwner[d.to]) votes.set(fileOwner[d.to], (votes.get(fileOwner[d.to]) ?? 0) + 1)
    let target: string | undefined = [...votes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
    if (!target) {
      const mirrored = f.path.replace(/(^|\/)(__tests__|tests?|spec)\//, '$1').replace(/(\.test|\.spec|_test|Test|Tests)(\.\w+)$/, '$2').replace(/(^|\/)test_/, '$1')
      target = ownerOf(boxDefs, mirrored) ?? undefined
    }
    if (target) testsOf.set(target, [...(testsOf.get(target) ?? []), f.path])
  }

  const nodes: ArchNode[] = []
  const nodeById = new Map<string, ArchNode>()
  const push = (n: ArchNode): void => {
    nodes.push(n)
    nodeById.set(n.id, n)
  }

  const ownedFiles = new Map<string, ScanFile[]>()
  for (const [file, owner] of Object.entries(fileOwner)) ownedFiles.set(owner, [...(ownedFiles.get(owner) ?? []), fileByPath.get(file)!])

  for (const b of boxDefs) {
    const files = ownedFiles.get(b.id) ?? []
    const symbols = files
      .flatMap((f) => f.symbols)
      .filter((s) => s.exported && s.kind !== 'method')
      .slice(0, 60)
    const routes = files.flatMap((f) => [...f.routes.map((r) => `${r.method} ${r.path}`), ...(f.pageRoute ? [`PAGE ${f.pageRoute}`] : [])])
    const lineCount = files.reduce((a, f) => a + f.lines, 0)
    const langs = new Map<string, number>()
    for (const f of files) langs.set(LANGS[f.lang].label, (langs.get(LANGS[f.lang].label) ?? 0) + f.lines)
    push({
      id: b.id,
      label: b.label,
      kind: 'box',
      parent: b.parent && boxIds.has(b.parent) ? b.parent : undefined,
      tech: b.tech,
      purpose: b.purpose ?? b.spec?.responsibility ?? opts.descriptions?.[b.id] ?? (files.length || boxDefs.some((x) => x.parent === b.id) ? autoPurpose(files, symbols, routes) : 'Planned component: not built yet.'),
      files: files.map((f) => f.path),
      paths: b.paths,
      symbols,
      tests: testsOf.get(b.id),
      rules: b.rules,
      routes: routes.length ? [...new Set(routes)].slice(0, 80) : undefined,
      declared: b.declared,
      proposed: b.proposed,
      spec: b.spec,
      stats: { files: files.length, lines: lineCount, lang: [...langs.entries()].sort((a, c) => c[1] - a[1])[0]?.[0] }
    })
  }

  // ── Edges between boxes (from file-level imports) ───────────────────────────────────────
  const edges = new Map<string, ArchEdge & { names: Set<string>; short: Set<string> }>()
  const addEdge = (src: string, tgt: string, kind: ArchEdge['kind'], contract: string[], label?: string, shortNames?: string[]): void => {
    if (src === tgt) return
    const id = `${src}->${tgt}`
    const e = edges.get(id) ?? { id, source: src, target: tgt, kind, label: '', contract: [], weight: 0, names: new Set<string>(), short: new Set<string>() }
    e.weight = (e.weight ?? 0) + 1
    for (const c of contract) e.names.add(c)
    for (const n of shortNames ?? []) e.short.add(n)
    if (kind === 'http') e.kind = 'http'
    if (label) e.label = label
    edges.set(id, e)
  }
  for (const d of res.deps) {
    const s = fileOwner[d.from]
    const t = fileOwner[d.to]
    if (!s || !t || s === t) continue
    const target = fileByPath.get(d.to)!
    const names = d.names.filter((n) => n !== '*')
    addEdge(s, t, 'call', names.map((n) => sigOf(target.symbols, n)), undefined, names)
  }

  // HTTP: client calls in one box matched to server routes in another.
  const routeIndex = scan.files.flatMap((f) => f.routes.map((r) => ({ r, owner: fileOwner[f.path] }))).filter((x) => x.owner)
  for (const f of scan.files) {
    const s = fileOwner[f.path]
    if (!s) continue
    for (const c of f.calls) {
      if (/^https?:/.test(c.url)) continue
      const hit = routeIndex.find((x) => x.owner !== s && (c.method === 'ANY' || x.r.method === 'ANY' || x.r.method === c.method) && pathsMatch(c.url, x.r.path))
      if (hit) addEdge(s, hit.owner, 'http', [`${hit.r.method === 'ANY' ? c.method : hit.r.method} ${hit.r.path}`])
    }
  }

  // ── External services and data stores ────────────────────────────────────────────────────
  const services = new Map<string, ArchNode>()
  const ensureService = (id: string, label: string, kind: 'external' | 'datastore', tech?: string, purpose?: string, proposed?: boolean): ArchNode => {
    let n = services.get(id)
    if (!n) {
      n = { id, label, kind, tech, purpose: purpose ?? '', files: [], symbols: [], proposed }
      services.set(id, n)
    }
    return n
  }
  for (const s of defs.services) ensureService(s.id, s.label, s.kind, s.tech, s.purpose)
  const dbFlavour = detectDbFlavour(scan)
  for (const u of res.pkgs) {
    const owner = fileOwner[u.file]
    if (!owner) continue
    const declared = defs.services.find((s) => s.match?.some((m) => m === u.pkg || u.pkg.startsWith(m)))
    const known = declared ? null : knownService(u.pkg)
    const svc = declared ?? known
    if (!svc) continue
    const id = (declared ? declared.id : `${known!.kind === 'datastore' ? 'ds' : 'ext'}:${known!.id}`)
    if (!declared && dismissed.has(id)) continue
    const label = !declared && known!.id === 'db' && dbFlavour ? dbFlavour : svc.label
    const n = ensureService(id, label, svc.kind, svc.tech, declared ? declared.purpose : known!.kind === 'datastore' ? 'Data store used by the app.' : 'Third-party service called by the app.', !declared)
    n.evidence = [...new Set([...(n.evidence ?? []), `imports ${u.pkg}`])].slice(0, 6)
    addEdge(owner, id, svc.kind === 'datastore' ? 'sql' : 'external', [u.pkg])
  }
  for (const f of scan.files) {
    const owner = fileOwner[f.path]
    if (!owner) continue
    for (const c of f.calls) {
      const h = /^https?:/.test(c.url) ? hostService(c.url) : null
      if (!h || dismissed.has(h.id)) continue
      const n = ensureService(h.id, h.label, 'external', h.tech, 'External HTTP API called by the app.', true)
      n.evidence = [...new Set([...(n.evidence ?? []), `calls ${c.url.slice(0, 60)}`])].slice(0, 6)
      addEdge(owner, h.id, 'external', [`${c.method} ${c.url.replace(/^https?:\/\/[^/]+/, '') || '/'}`])
    }
  }
  for (const n of services.values()) {
    const curated = defs.services.some((s) => s.id === n.id)
    if (curated || opts.includeProposals) push({ ...n, proposed: curated ? undefined : n.proposed })
  }

  // ── Actors: declared ones, plus proposals from entry points ──────────────────────────────
  const boxNodes = nodes.filter((n) => n.kind === 'box')
  const actorEdges: [string, string, string[]][] = []
  const matchRoutes = (patterns: string[]): Map<string, string[]> => {
    const hits = new Map<string, string[]>()
    for (const b of boxNodes) {
      for (const r of b.routes ?? []) {
        const [method, rpath] = r.split(' ')
        for (const pat of patterns) {
          const m = pat.match(/^(GET|POST|PUT|PATCH|DELETE|PAGE|ANY)\s+(.*)$/i)
          const pm = m ? m[1].toUpperCase() : null
          const pp = (m ? m[2] : pat).trim()
          const okMethod = !pm || pm === method || method === 'ANY' || pm === 'ANY'
          const okPath = pp.endsWith('*') ? rpath.startsWith(pp.slice(0, -1).replace(/\/$/, '')) : pathsMatch(rpath, pp)
          if (okMethod && okPath) hits.set(b.id, [...(hits.get(b.id) ?? []), r])
        }
      }
    }
    return hits
  }

  const actorNode = (a: ActorDef, proposed: boolean, evidence?: string[]): void => {
    const reached = new Map<string, string[]>()
    for (const id of a.reaches ?? []) if (nodeById.has(id)) reached.set(id, [])
    for (const [id, rs] of matchRoutes(a.routes ?? [])) reached.set(id, [...(reached.get(id) ?? []), ...rs])
    push({
      id: a.id,
      label: a.label,
      kind: 'actor',
      actorType: a.type,
      purpose: a.description ?? '',
      files: [],
      symbols: [],
      routes: a.routes,
      declared: !proposed,
      proposed,
      evidence
    })
    for (const [id, rs] of reached) actorEdges.push([a.id, id, [...new Set(rs)].slice(0, 20)])
  }
  for (const a of defs.actors) actorNode(a, false)
  if (opts.includeProposals) {
    for (const p of proposeActors(scan, boxNodes, fileOwner, routeIndex, edges)) {
      if (dismissed.has(p.def.id) || defs.actors.some((a) => a.id === p.def.id)) continue
      actorNode(p.def, true, p.evidence)
    }
  }
  for (const [a, b, rs] of actorEdges) {
    addEdge(a, b, 'uses', rs.length ? rs : ['uses'], 'uses')
  }

  // ── Finalise edges: labels and readable contracts ────────────────────────────────────────
  const outEdges: ArchEdge[] = [...edges.values()].map(({ names, short, ...e }) => {
    const contract = [...names].slice(0, 16)
    const callable = (n: string): string => {
      const sig = contract.find((c) => c.includes(n))
      return sig && /\(/.test(sig) && !/^(class|interface|type)/.test(sig) ? `${n}()` : n
    }
    const shorts = [...short]
    const label =
      e.label ||
      (e.kind === 'http'
        ? contract.length === 1 ? contract[0].replace(/^ANY /, '').slice(0, 32) : `${contract.length} routes`
        : shorts.length === 1 ? callable(shorts[0])
        : shorts.length > 1 ? `${callable(shorts[0])} +${shorts.length - 1}`
        : contract.length === 1 ? contract[0].slice(0, 28)
        : e.kind === 'call' ? 'imports' : e.kind)
    return { ...e, label, contract: contract.length ? contract : [] }
  })

  // ── Designed contracts vs code: planned edges, undeclared dependencies, route drift ─────
  const drift: DriftItem[] = []
  const subtree = (id: string): Set<string> => {
    const out = new Set([id])
    let grew = true
    while (grew) {
      grew = false
      for (const n of nodes) if (n.parent && out.has(n.parent) && !out.has(n.id)) (out.add(n.id), (grew = true))
    }
    return out
  }
  const statusOf = (id: string): string | undefined => nodeById.get(id)?.spec?.status
  const built = (id: string): boolean => (nodeById.get(id)?.files.length ?? 0) > 0 && statusOf(id) !== 'planned'
  for (const d of defs.edges ?? []) {
    if (!nodeById.has(d.from) || !nodeById.has(d.to)) continue
    const from = subtree(d.from)
    const to = subtree(d.to)
    const actual = outEdges.find((e) => from.has(e.source) && to.has(e.target))
    if (actual) {
      actual.declared = true
      if (d.uses.length) actual.contract = [...new Set([...d.uses, ...actual.contract])].slice(0, 20)
    } else {
      outEdges.push({ id: d.id, source: d.from, target: d.to, kind: d.kind, label: d.uses[0]?.slice(0, 28) ?? 'planned', contract: d.uses, declared: true, planned: true })
      if (built(d.from) && built(d.to)) drift.push({ kind: 'missing-dependency', source: d.from, target: d.to, detail: `Designed ${d.from} → ${d.to} (${d.uses.join(', ') || d.kind}) is not in the code.` })
    }
  }
  // A box whose outgoing dependencies were designed opts into "everything else is drift".
  const designedSources = new Set((defs.edges ?? []).map((d) => d.from))
  for (const e of outEdges) {
    if (e.declared || e.kind === 'uses') continue
    const src = [...designedSources].find((s) => subtree(s).has(e.source))
    if (!src) continue
    const tgtKind = nodeById.get(e.target)?.kind
    if (tgtKind === 'actor') continue
    e.undeclared = true
    drift.push({ kind: 'undeclared-dependency', source: e.source, target: e.target, detail: `${e.source} depends on ${e.target} (${e.contract.slice(0, 2).join(', ') || e.kind}) but that is not in the design.` })
  }
  for (const n of nodes) {
    const items = n.spec?.contract?.filter((c) => c.kind === 'http' && /\//.test(c.name)) ?? []
    if (!items.length || !n.files.length) continue
    const routes = subtreeRoutes(nodes, n.id)
    for (const c of items) {
      const [m, p] = c.name.includes(' ') ? c.name.split(/\s+/, 2) : ['ANY', c.name]
      const ok = routes.some((r) => {
        const [rm, rp] = r.split(' ')
        return (m === 'ANY' || rm === 'ANY' || rm === m.toUpperCase()) && pathsMatch(rp, p)
      })
      if (!ok && statusOf(n.id) !== 'planned') drift.push({ kind: 'missing-route', source: n.id, detail: `${n.label} promises ${c.name} but no handler serves it.` })
    }
    for (const r of routes) {
      const [rm, rp] = r.split(' ')
      if (rm === 'PAGE') continue
      const designed = items.some((c) => {
        const [m, p] = c.name.includes(' ') ? c.name.split(/\s+/, 2) : ['ANY', c.name]
        return (m === 'ANY' || rm === 'ANY' || rm === m.toUpperCase()) && pathsMatch(rp, p)
      })
      if (!designed) drift.push({ kind: 'undeclared-route', source: n.id, detail: `${n.label} serves ${r}, which is not in its contract.` })
    }
  }

  // ── Typed contracts and side effects vs code ────────────────────────────────────────────
  const typeIndex = new Map<string, CodeSymbol[]>()
  for (const f of scan.files) for (const s of f.symbols) if (s.fields) typeIndex.set(s.name, [...(typeIndex.get(s.name) ?? []), s])
  for (const n of nodes) {
    if (n.kind !== 'box') continue
    const files = [...subtree(n.id)].flatMap((id) => nodeById.get(id)?.files ?? []).map((p) => fileByPath.get(p)!).filter(Boolean)
    // Prefer a type defined in this box, else anywhere in the repo.
    const typeFields = (name: string): string[] | undefined => {
      const hits = typeIndex.get(name)
      return (hits?.find((s) => files.some((f) => f.path === s.file)) ?? hits?.[0])?.fields
    }
    const effects = new Map<EffectKind, string[]>()
    for (const f of files) for (const e of f.effects) effects.set(e.kind, [...(effects.get(e.kind) ?? []), `${f.path}:${e.line} ${e.what}`])
    if (effects.size) n.effects = [...effects.entries()].map(([kind, at]) => ({ kind, at: at.slice(0, 4) }))
    const allowed = n.spec?.sideEffects
    if (allowed)
      for (const [kind, at] of effects)
        if (!allowed.includes(kind)) drift.push({ kind: 'undeclared-effect', source: n.id, detail: `${n.label} has a ${kind} side effect that is not declared (${at[0]}).` })

    // Code style: project default, overridden per box; each box checks only its own files.
    const style: CodeStyle = { ...defs.style }
    for (const [k, v] of Object.entries(n.spec?.style ?? {})) if (v !== undefined && v !== null) (style as Record<string, unknown>)[k] = v
    if (Object.keys(style).length) {
      n.style = style
      for (const p of n.files) {
        for (const s of fileByPath.get(p)?.symbols ?? []) {
          if (!['function', 'method', 'component'].includes(s.kind ?? '') || !s.line) continue
          const at = `${s.file}:${s.line} ${s.name}`
          const len = (s.endLine ?? s.line) - s.line + 1
          if (style.maxFunctionLines && len > style.maxFunctionLines) drift.push({ kind: 'style', source: n.id, detail: `${at} is ${len} lines (max ${style.maxFunctionLines}).` })
          if (style.maxNesting && (s.nesting ?? 0) > style.maxNesting) drift.push({ kind: 'style', source: n.id, detail: `${at} nests ${s.nesting} levels deep (max ${style.maxNesting}).` })
          if (style.publicDocs && s.exported && s.kind !== 'method' && !s.doc) drift.push({ kind: 'style', source: n.id, detail: `${at} is public but has no docstring.` })
        }
      }
    }

    const items = n.spec?.contract ?? []
    if (!items.length || !files.length || statusOf(n.id) === 'planned') continue
    const checks: Record<string, ContractCheck> = {}
    for (const c of items) {
      if (c.kind === 'http' && (c.input || c.output)) {
        const [m, p] = c.name.includes(' ') ? c.name.split(/\s+/, 2) : ['ANY', c.name]
        const hit = files.flatMap((f) => f.routes.map((r) => ({ f, r }))).find(({ r }) => (m === 'ANY' || r.method === 'ANY' || r.method === m.toUpperCase()) && pathsMatch(r.path, p))
        if (!hit) continue // already reported as missing-route
        const handler = hit.f.symbols.find((s) => s.name === hit.r.handler) ?? (hit.r.handlerSig ? { name: hit.r.handler!, signature: hit.r.handlerSig, file: hit.f.path } : undefined)
        checks[c.name] = checkHttp(c, hit.r, handler, typeFields)
      } else if (c.kind === 'event' || c.kind === 'queue') {
        const topic = c.name.replace(/^(event|queue)\s*:\s*/i, '').trim()
        const pub = files.some((f) => f.emits?.some((e) => topicsMatch(e.topic, topic)))
        const sub = files.some((f) => f.listens?.some((e) => topicsMatch(e.topic, topic)))
        checks[c.name] = pub || (c.kind === 'queue' && sub) ? { status: 'ok' } : { status: 'mismatch', detail: c.kind === 'queue' ? `no code in this box publishes to or consumes ${topic}` : `no code in this box publishes ${topic}` }
      } else if (c.kind === 'function') {
        const name = c.name.match(/^\s*([\w.]+)/)?.[1]?.split('.').pop()
        const fn = files.flatMap((f) => f.symbols).filter((s) => s.name === name && (s.kind === 'function' || s.kind === 'method'))
        checks[c.name] = checkFunction(c, fn.find((s) => s.exported) ?? fn[0], typeFields)
      } else continue
      const r = checks[c.name]
      if (r.status === 'mismatch') drift.push({ kind: 'contract-mismatch', source: n.id, detail: `${n.label}: ${c.name}: ${r.detail}` })
    }
    if (Object.keys(checks).length) n.contractCheck = checks
    // Once a box declares any event, every topic it publishes must be declared.
    const topics = items.filter((c) => c.kind === 'event' || c.kind === 'queue').map((c) => c.name.replace(/^(event|queue)\s*:\s*/i, '').trim())
    if (topics.length)
      for (const f of files)
        for (const e of f.emits ?? [])
          if (!topics.some((t) => topicsMatch(e.topic, t))) drift.push({ kind: 'undeclared-event', source: n.id, detail: `${n.label} publishes ${e.topic} (${f.path}:${e.line}), which is not in its contract.` })
  }

  // ── Guardrails ───────────────────────────────────────────────────────────────────────────
  const descendantsOf = (id: string): Set<string> => {
    const out = new Set([id])
    let grew = true
    while (grew) {
      grew = false
      for (const n of nodes) if (n.parent && out.has(n.parent) && !out.has(n.id)) (out.add(n.id), (grew = true))
    }
    return out
  }
  const violations: Violation[] = []
  for (const g of defs.guardrails) {
    const from = descendantsOf(g.from)
    const to = descendantsOf(g.to)
    for (const e of outEdges) if (from.has(e.source) && to.has(e.target)) violations.push({ guardrail: g.id, edge: e.id, source: e.source, target: e.target })
  }

  return {
    model: { name: defs.name, nodes, edges: outEdges, guardrails: defs.guardrails, violations, journeys: defs.journeys ?? [], drift, style: defs.style },
    fileOwner,
    unmapped
  }
}

export function subtreeRoutes(nodes: ArchNode[], id: string): string[] {
  const ids = new Set([id])
  let grew = true
  while (grew) {
    grew = false
    for (const n of nodes) if (n.parent && ids.has(n.parent) && !ids.has(n.id)) (ids.add(n.id), (grew = true))
  }
  return nodes.filter((n) => ids.has(n.id)).flatMap((n) => n.routes ?? [])
}

function autoPurpose(files: ScanFile[], symbols: CodeSymbol[], routes: string[]): string {
  if (!files.length) return 'Groups the boxes inside it.'
  const parts: string[] = []
  const api = routes.filter((r) => !r.startsWith('PAGE'))
  const pages = routes.filter((r) => r.startsWith('PAGE'))
  if (api.length) parts.push(`Serves ${api.length} HTTP route${api.length > 1 ? 's' : ''} (${api.slice(0, 3).join(', ')}${api.length > 3 ? ', …' : ''}).`)
  if (pages.length) parts.push(`Renders ${pages.length} page${pages.length > 1 ? 's' : ''} (${pages.slice(0, 3).map((p) => p.slice(5)).join(', ')}${pages.length > 3 ? ', …' : ''}).`)
  const comps = symbols.filter((s) => s.kind === 'component').map((s) => s.name)
  const fns = symbols.filter((s) => s.kind !== 'component').map((s) => s.name)
  if (comps.length) parts.push(`Components: ${comps.slice(0, 5).join(', ')}${comps.length > 5 ? ', …' : ''}.`)
  if (fns.length) parts.push(`Exposes ${fns.slice(0, 5).join(', ')}${fns.length > 5 ? ', …' : ''}.`)
  if (files.some((f) => f.flags.includes('cli'))) parts.push('Command-line entry point.')
  if (files.some((f) => f.flags.includes('cron'))) parts.push('Runs scheduled jobs.')
  if (!parts.length) parts.push(`${files.length} file${files.length > 1 ? 's' : ''}.`)
  return parts.join(' ')
}

function detectDbFlavour(scan: ScanResult): string | null {
  const texts = Object.entries(scan.manifests)
  for (const [p, t] of texts) {
    if (p.endsWith('schema.prisma')) {
      const m = t.match(/provider\s*=\s*"(postgresql|mysql|sqlite|mongodb|sqlserver|cockroachdb)"/)
      if (m) return { postgresql: 'PostgreSQL', mysql: 'MySQL', sqlite: 'SQLite', mongodb: 'MongoDB', sqlserver: 'SQL Server', cockroachdb: 'CockroachDB' }[m[1]] ?? null
    }
  }
  for (const [p, t] of texts) {
    if (/\.env\.(example|sample)$|docker-compose|compose\.ya?ml/.test(p)) {
      if (/postgres(ql)?:\/\/|image:\s*postgres/.test(t)) return 'PostgreSQL'
      if (/mysql:\/\/|image:\s*mysql|image:\s*mariadb/.test(t)) return 'MySQL'
      if (/mongodb(\+srv)?:\/\/|image:\s*mongo/.test(t)) return 'MongoDB'
    }
  }
  return null
}

interface ActorProposal {
  def: ActorDef
  evidence: string[]
}

/** Who uses this system? Inferred from entry points: pages, routes, CLIs, schedulers, webhooks. */
export function proposeActors(
  scan: ScanResult,
  boxes: ArchNode[],
  fileOwner: Record<string, string>,
  routeIndex: { r: { method: string; path: string }; owner: string }[],
  edges: Map<string, ArchEdge>
): ActorProposal[] {
  const out: ActorProposal[] = []
  const filesWith = (flag: string): ScanFile[] => scan.files.filter((f) => f.flags.includes(flag as never) && fileOwner[f.path])
  const ownersOf = (fs: ScanFile[]): string[] => [...new Set(fs.map((f) => fileOwner[f.path]))]
  const byId = new Map(boxes.map((b) => [b.id, b]))
  const rootOf = (id: string): string => {
    let cur = byId.get(id)
    while (cur?.parent && byId.get(cur.parent)) cur = byId.get(cur.parent)
    return cur?.id ?? id
  }

  // People using a UI.
  const pages = filesWith('page').filter((f) => !f.flags.includes('admin') && !/\/admin\//.test(f.path))
  const uiBoxes = ownersOf(pages)
  const frontendRoots = boxes.filter((b) => !b.parent && /React|Vue|Svelte|Angular|Next|Nuxt|Remix|Astro|Streamlit/.test(b.tech ?? ''))
  const componentsOnly = ownersOf(filesWith('component'))
  const reachesUi = uiBoxes.length ? uiBoxes : frontendRoots.length ? frontendRoots.map((b) => b.id) : componentsOnly.slice(0, 3)
  const mobile = boxes.some((b) => /React Native|Flutter|Swift/.test(b.tech ?? ''))
  if (reachesUi.length) {
    out.push({
      def: { id: 'actor:user', label: mobile ? 'User (app)' : 'User (browser)', type: 'user', description: 'End users interacting with the UI.', reaches: reachesUi.slice(0, 8) },
      evidence: pages.length ? [`${pages.length} page${pages.length > 1 ? 's' : ''}, e.g. ${pages.slice(0, 2).map((p) => p.path).join(', ')}`] : ['UI components']
    })
  }

  // Admins: an /admin area in routes or pages.
  const adminRoutes = routeIndex.filter((x) => /(^|\/)admin(\/|$)/i.test(x.r.path))
  const adminPages = filesWith('page').filter((f) => /\/admin\//.test(f.path) || f.flags.includes('admin'))
  if (adminRoutes.length || adminPages.length) {
    out.push({
      def: { id: 'actor:admin', label: 'Admin', type: 'admin', description: 'Operators managing the system through the admin area.', reaches: ownersOf(adminPages), routes: adminRoutes.length ? ['/admin/*', '/api/admin/*'] : undefined },
      evidence: [`${adminRoutes.length} admin route${adminRoutes.length === 1 ? '' : 's'}${adminPages.length ? `, ${adminPages.length} admin page(s)` : ''}`]
    })
  }

  // API consumers: routes that no in-repo UI calls.
  const calledOwners = new Set([...edges.values()].filter((e) => e.kind === 'http').map((e) => e.target))
  const uncalled = routeIndex.filter((x) => !calledOwners.has(x.owner) && !/admin|webhook/i.test(x.r.path))
  if (uncalled.length && !reachesUi.length) {
    out.push({
      def: { id: 'actor:client', label: 'API client', type: 'client', description: 'Programs calling the HTTP API.', reaches: [...new Set(uncalled.map((x) => x.owner))].slice(0, 8) },
      evidence: [`${uncalled.length} HTTP route(s) with no caller in this repo`]
    })
  }

  // Webhook senders.
  const hooks = routeIndex.filter((x) => /webhook|hook|callback/i.test(x.r.path))
  if (hooks.length) {
    out.push({
      def: { id: 'actor:webhook', label: 'Webhook sender', type: 'webhook', description: 'Third-party services calling back into the app.', reaches: [...new Set(hooks.map((x) => x.owner))] },
      evidence: hooks.slice(0, 3).map((x) => `${x.r.method} ${x.r.path}`)
    })
  }

  // Command line.
  const cli = filesWith('cli')
  if (cli.length) {
    out.push({
      def: { id: 'actor:cli', label: 'Operator (CLI)', type: 'cli', description: 'Developers or operators running commands.', reaches: ownersOf(cli).slice(0, 6) },
      evidence: cli.slice(0, 3).map((f) => f.path)
    })
  }

  // Schedulers.
  const cron = filesWith('cron')
  const ciCron = Object.entries(scan.manifests).some(([p, t]) => /vercel\.json$/.test(p) && /"crons"/.test(t))
  if (cron.length || ciCron) {
    out.push({
      def: { id: 'actor:cron', label: 'Scheduler', type: 'cron', description: 'Time-based triggers (cron, beat, scheduled functions).', reaches: ownersOf(cron).slice(0, 6) },
      evidence: cron.length ? cron.slice(0, 3).map((f) => f.path) : ['vercel.json crons']
    })
  }

  // Message queues.
  const queue = filesWith('queue')
  if (queue.length) {
    out.push({
      def: { id: 'actor:queue', label: 'Message queue', type: 'system', description: 'Messages consumed by background workers.', reaches: ownersOf(queue).slice(0, 6) },
      evidence: queue.slice(0, 3).map((f) => f.path)
    })
  }

  // Programs without any other entry point: whoever runs main().
  if (!out.length) {
    const entry = filesWith('entry')
    if (entry.length) out.push({ def: { id: 'actor:operator', label: 'Operator', type: 'cli', description: 'Whoever runs the program.', reaches: ownersOf(entry).map(rootOf).slice(0, 4) }, evidence: entry.slice(0, 3).map((f) => f.path) })
  }
  return out
}

export { humanize }
