import { EventEmitter } from 'events'
import { promises as fs } from 'fs'
import path from 'path'
import type { Worker } from 'worker_threads'
import createScanWorker from './engine/scan.worker?nodeWorker'
import type { ArchModel, ArchNode } from '@shared/model'
import type { DefsOp, GitInfo, LocateResult, ScanProgress, SearchHit, WorkspaceSnapshot } from '@shared/api'
import { gitInfo } from './git'
import { loadDescriptions } from './insights'
import { buildCoChange, buildSymbolCoChange, type CoChange } from './targeting'
import type { ScanFile, ScanResult } from './engine/scan'
import { resolveImports, type Resolution } from './engine/resolve'
import { buildModel, emptyDefs, ownerOf, type ArchDefs, type BuildResult } from './engine/build'
import { humanize } from './engine/group'
import { loadDefs, loadLayout, saveDefs, saveLayout, type PinnedLayout } from './engine/store'
import { pathsMatch } from './engine/detect'

// One open repository: its curated definitions, the latest scan, and the model built from both.

class ScanClient {
  private worker: Worker
  private seq = 0
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; progress?: (p: ScanProgress) => void }>()

  constructor() {
    this.worker = createScanWorker({})
    this.worker.on('message', (m: { id: number; progress?: ScanProgress; result?: unknown; error?: string }) => {
      const p = this.pending.get(m.id)
      if (!p) return
      if (m.progress) return p.progress?.(m.progress)
      this.pending.delete(m.id)
      if (m.error) p.reject(new Error(m.error))
      else p.resolve(m.result)
    })
    this.worker.on('error', (e) => {
      for (const p of this.pending.values()) p.reject(e instanceof Error ? e : new Error(String(e)))
      this.pending.clear()
      this.worker = createScanWorker({}) // restart after a crash
    })
  }

  request<T>(msg: Record<string, unknown>, progress?: (p: ScanProgress) => void): Promise<T> {
    const id = ++this.seq
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, progress })
      this.worker.postMessage({ ...msg, id })
    })
  }

  dispose(): void {
    void this.worker.terminate()
  }
}

export class Workspace extends EventEmitter {
  readonly root: string
  readonly name: string
  defs: ArchDefs
  /** True when defs are an unsaved proposal (right after Initialize). */
  draft = false
  initialized = false
  scan: ScanResult | null = null
  res: Resolution | null = null
  built: BuildResult | null = null
  layout: PinnedLayout = {}
  /** AI-written purposes for boxes the user hasn't described (cached in .arch/cache). */
  descriptions: Record<string, string> = {}
  git: GitInfo | null = null
  /** Files that change together in git history (targeting signal). */
  coChange: CoChange | null = null
  symbolCoChange: CoChange | null = null
  private scanner = new ScanClient()
  private files = new Map<string, ScanFile>()

  private constructor(root: string) {
    super()
    this.root = root
    this.name = path.basename(root)
    this.defs = emptyDefs(this.name)
  }

  static async open(root: string): Promise<Workspace> {
    const ws = new Workspace(root)
    const defs = await loadDefs(root)
    if (defs) {
      ws.defs = defs
      ws.initialized = true
    }
    ws.layout = await loadLayout(root)
    ws.descriptions = await loadDescriptions(root)
    ws.git = await gitInfo(root)
    return ws
  }

  async refreshGit(): Promise<void> {
    this.git = await gitInfo(this.root)
    this.emit('model', this.snapshot())
  }

  dispose(): void {
    this.scanner.dispose()
    this.removeAllListeners()
  }

  async fullScan(): Promise<void> {
    const scan = await this.scanner.request<ScanResult>({ type: 'scan', root: this.root }, (p) => this.emit('progress', p))
    this.scan = scan
    this.files = new Map(scan.files.map((f) => [f.path, f]))
    this.emit('progress', { phase: 'Resolving imports', done: 0, total: 0 })
    this.res = resolveImports(scan)
    this.rebuild()
    // History is a background signal: never block the map on it.
    if (!this.coChange) void buildCoChange(this.root).then((c) => (this.coChange = c)).catch(() => {})
    if (!this.symbolCoChange) void buildSymbolCoChange(this.root).then((c) => (this.symbolCoChange = c)).catch(() => {})
  }

  /** Re-extract changed files only (watch mode). */
  async updatePaths(rels: string[]): Promise<void> {
    if (!this.scan) return
    const { files, removed } = await this.scanner.request<{ files: ScanFile[]; removed: string[] }>({ type: 'paths', root: this.root, paths: rels })
    for (const r of removed) this.files.delete(r)
    for (const f of files) this.files.set(f.path, f)
    const known = new Set(this.scan.allPaths)
    for (const f of files) if (!known.has(f.path)) this.scan.allPaths.push(f.path)
    this.scan = { ...this.scan, files: [...this.files.values()], allPaths: this.scan.allPaths.filter((p) => !removed.includes(p)) }
    this.res = resolveImports(this.scan)
    this.rebuild()
  }

  rebuild(): void {
    if (!this.scan || !this.res) return
    this.built = buildModel(this.scan, this.res, this.defs, { includeProposals: this.initialized && !this.draft, descriptions: this.descriptions })
    this.emit('model', this.snapshot())
  }

  snapshot(): WorkspaceSnapshot {
    const model = this.built?.model ?? { name: this.name, nodes: [], edges: [] }
    return {
      root: this.root,
      name: this.name,
      initialized: this.initialized,
      draft: this.draft,
      model,
      layout: this.layout,
      unmapped: this.built?.unmapped ?? [],
      stats: { files: this.scan?.files.length ?? 0, languages: (this.scan?.languages ?? {}) as Record<string, number>, ms: this.scan?.durationMs ?? 0 },
      git: this.git
    }
  }

  /** Initialize: scan, then turn every proposal into a draft definition for the user to curate. */
  async initialize(): Promise<void> {
    if (!this.scan) await this.fullScan()
    const proposal = buildModel(this.scan!, this.res!, emptyDefs(this.name), { includeProposals: true })
    this.defs = defsFromModel(this.name, proposal)
    this.draft = true
    this.rebuild()
  }

  /** Save the curated draft (or the current defs) to .arch/model.yaml. */
  async save(): Promise<void> {
    await saveDefs(this.root, this.defs)
    this.initialized = true
    this.draft = false
    this.rebuild()
  }

  async discardDraft(): Promise<void> {
    this.defs = (await loadDefs(this.root)) ?? emptyDefs(this.name)
    this.draft = false
    this.rebuild()
  }

  async saveLayout(zoom: string, l: PinnedLayout[string]): Promise<void> {
    this.layout = { ...this.layout, [zoom]: l }
    await saveLayout(this.root, this.layout)
  }

  async apply(op: DefsOp, inBatch = false): Promise<void> {
    const d = this.defs
    const model = this.built?.model
    const box = (id: string) => d.boxes.find((b) => b.id === id)
    const actor = (id: string) => d.actors.find((a) => a.id === id)
    const service = (id: string) => d.services.find((s) => s.id === id)
    const slug = (s: string) => s.toLowerCase().replace(/[^\w]+/g, '-').replace(/^-|-$/g, '')

    switch (op.op) {
      case 'rename': {
        const t = box(op.id) ?? actor(op.id) ?? service(op.id)
        if (t) t.label = op.label
        break
      }
      case 'setPurpose': {
        const b = box(op.id)
        if (b) b.purpose = op.purpose
        const a = actor(op.id)
        if (a) a.description = op.purpose
        const s = service(op.id)
        if (s) s.purpose = op.purpose
        break
      }
      case 'setRules': {
        const b = box(op.id)
        if (b) b.rules = op.rules.filter((r) => r.trim())
        break
      }
      case 'setTech': {
        const b = box(op.id) ?? service(op.id)
        if (b) b.tech = op.tech
        break
      }
      case 'mergeInto': {
        const src = box(op.id)
        const dst = box(op.target)
        if (!src || !dst || src === dst) break
        // A child merged into its parent simply disappears (the parent's prefix covers it).
        const isAncestor = isAncestorOf(d, dst.id, src.id)
        if (!isAncestor) dst.paths = [...new Set([...dst.paths, ...src.paths])]
        for (const b of d.boxes) if (b.parent === src.id) b.parent = dst.id
        for (const a of d.actors) a.reaches = a.reaches?.map((r) => (r === src.id ? dst.id : r))
        d.boxes = d.boxes.filter((b) => b !== src)
        if (!d.dismissed.includes(src.id)) d.dismissed.push(src.id)
        break
      }
      case 'setParent': {
        const b = box(op.id)
        if (b && op.parent !== op.id && !(op.parent && isAncestorOf(d, op.id, op.parent))) b.parent = op.parent ?? undefined
        break
      }
      case 'remove': {
        const b = box(op.id)
        if (b) {
          for (const c of d.boxes) if (c.parent === b.id) c.parent = b.parent
          d.boxes = d.boxes.filter((x) => x !== b)
        }
        d.actors = d.actors.filter((a) => a.id !== op.id)
        d.services = d.services.filter((s) => s.id !== op.id)
        for (const a of d.actors) a.reaches = a.reaches?.filter((r) => r !== op.id)
        d.edges = (d.edges ?? []).filter((e) => e.from !== op.id && e.to !== op.id)
        for (const j of d.journeys ?? []) j.steps = j.steps.filter((s) => s.box !== op.id)
        if (!d.dismissed.includes(op.id)) d.dismissed.push(op.id)
        break
      }
      case 'accept':
      case 'acceptAll': {
        if (!model) break
        const ids = op.op === 'accept' ? [op.id] : model.nodes.filter((n) => n.proposed).map((n) => n.id)
        const fresh = defsFromModel(this.name, this.built!, ids)
        d.boxes.push(...fresh.boxes.filter((b) => !box(b.id)))
        d.actors.push(...fresh.actors.filter((a) => !actor(a.id)))
        d.services.push(...fresh.services.filter((s) => !service(s.id)))
        break
      }
      case 'addPaths': {
        const b = box(op.id)
        if (b) b.paths = [...new Set([...b.paths, ...op.paths])]
        break
      }
      case 'addBox': {
        let id = op.id ?? (op.parent ? `${op.parent}/${slug(op.label)}` : op.paths[0] || slug(op.label))
        while (box(id)) id += '_'
        d.boxes.push({ id, label: op.label, paths: op.paths, parent: op.parent, tech: op.tech, declared: true, spec: op.spec ?? (op.paths.length ? undefined : { status: 'planned' }) })
        break
      }
      case 'setTech': {
        const b = box(op.id)
        if (b) b.tech = op.tech.trim() || undefined
        break
      }
      case 'setStyle':
        d.style = Object.values(op.style).some((v) => v !== undefined) ? op.style : undefined
        break
      case 'setSpec': {
        const b = box(op.id)
        if (b) b.spec = { ...(b.spec ?? {}), ...op.spec }
        break
      }
      case 'upsertEdge': {
        d.edges = d.edges ?? []
        const i = d.edges.findIndex((e) => e.id === op.edge.id)
        if (i >= 0) d.edges[i] = op.edge
        else d.edges.push(op.edge)
        break
      }
      case 'removeEdge':
        d.edges = (d.edges ?? []).filter((e) => e.id !== op.id)
        break
      case 'upsertJourney': {
        d.journeys = d.journeys ?? []
        const i = d.journeys.findIndex((j) => j.id === op.journey.id)
        // Editing a journey keeps its test unless the edit says otherwise.
        if (i >= 0) d.journeys[i] = { ...op.journey, test: 'test' in op.journey ? op.journey.test : d.journeys[i].test }
        else d.journeys.push(op.journey)
        break
      }
      case 'removeJourney':
        d.journeys = (d.journeys ?? []).filter((j) => j.id !== op.id)
        break
      case 'batch':
        // Apply without saving/rebuilding in between, then once at the end.
        for (const o of op.ops) await this.apply(o, true)
        break
      case 'upsertActor': {
        const id = op.actor.id ?? 'actor:' + slug(op.actor.label)
        const existing = actor(id)
        const next = { id, label: op.actor.label, type: op.actor.type, description: op.actor.description, reaches: op.actor.reaches ?? [], routes: op.actor.routes?.filter(Boolean) }
        if (existing) Object.assign(existing, next)
        else d.actors.push(next)
        d.dismissed = d.dismissed.filter((x) => x !== id)
        break
      }
      case 'upsertService': {
        const id = op.service.id ?? (op.service.kind === 'datastore' ? 'ds:' : 'ext:') + slug(op.service.label)
        const existing = service(id)
        const next = { ...op.service, id }
        if (existing) Object.assign(existing, next)
        else d.services.push(next)
        break
      }
      case 'upsertGuardrail': {
        const i = d.guardrails.findIndex((g) => g.id === op.guardrail.id)
        if (i >= 0) d.guardrails[i] = op.guardrail
        else d.guardrails.push(op.guardrail)
        break
      }
      case 'removeGuardrail':
        d.guardrails = d.guardrails.filter((g) => g.id !== op.id)
        break
    }
    if (inBatch) return
    if (!this.draft && this.initialized) await saveDefs(this.root, this.defs)
    this.rebuild()
  }

  /** Build the model as it would be after `ops`, without saving or changing anything. */
  async preview(ops: DefsOp[]): Promise<ArchModel | null> {
    if (!this.scan || !this.res) return null
    const saved = this.defs
    this.defs = structuredClone(saved)
    try {
      for (const op of ops) {
        try {
          await this.apply(op, true)
        } catch {
          /* skip invalid op */
        }
      }
      return buildModel(this.scan, this.res, this.defs, { includeProposals: false, descriptions: this.descriptions }).model
    } finally {
      this.defs = saved
    }
  }

  // ── Reading code ───────────────────────────────────────────────────────────────────────

  async readFile(rel: string): Promise<string> {
    const abs = path.resolve(this.root, rel)
    if (!abs.startsWith(path.resolve(this.root))) throw new Error('outside workspace')
    return (await fs.readFile(abs, 'utf8')).replace(/\r\n/g, '\n')
  }

  fileInfo(rel: string): ScanFile | undefined {
    return this.files.get(rel)
  }

  allFiles(): ScanFile[] {
    return [...this.files.values()]
  }

  /** Box-level edges a file participates in (via its imports or importers). */
  edgesForFile(rel: string): string[] {
    const own = this.built?.fileOwner ?? {}
    const out = new Set<string>()
    for (const d of this.res?.deps ?? []) {
      if (d.from !== rel && d.to !== rel) continue
      const s = own[d.from]
      const t = own[d.to]
      if (s && t && s !== t) out.add(`${s}->${t}`)
    }
    return [...out]
  }

  /** Who depends on a file / symbol / box: files, boxes and tests that would be affected by a change. */
  impact(target: string): { files: string[]; boxes: string[]; tests: string[] } {
    const m = this.built?.model
    const own = this.built?.fileOwner ?? {}
    let seeds: string[] = []
    if (this.files.has(target)) seeds = [target]
    else {
      const box = m?.nodes.find((n) => n.id === target || n.label.toLowerCase() === target.toLowerCase())
      if (box) seeds = m!.nodes.filter((n) => n.id === box.id || isUnder(m!.nodes, n.id, box.id)).flatMap((n) => n.files)
      else seeds = [...this.files.values()].filter((f) => f.symbols.some((s) => s.name === target)).map((f) => f.path)
    }
    const affected = new Set<string>()
    const queue = [...seeds]
    const reverse = new Map<string, string[]>()
    for (const d of this.res?.deps ?? []) reverse.set(d.to, [...(reverse.get(d.to) ?? []), d.from])
    while (queue.length && affected.size < 400) {
      const f = queue.shift()!
      for (const dep of reverse.get(f) ?? []) if (!affected.has(dep) && !seeds.includes(dep)) (affected.add(dep), queue.push(dep))
    }
    const files = [...affected]
    const boxes = [...new Set(files.map((f) => own[f]).filter(Boolean))]
    const tests = files.filter((f) => this.files.get(f)?.flags.includes('test'))
    return { files: files.filter((f) => !tests.includes(f)), boxes, tests }
  }

  ownerOfFile(rel: string): string | null {
    return this.built?.fileOwner[rel] ?? ownerOf(this.defs.boxes, rel)
  }

  // ── Search (boxes, symbols, routes, files) ────────────────────────────────────────────

  search(query: string, limit = 40): SearchHit[] {
    const q = query.trim().toLowerCase()
    if (!q || !this.built) return []
    const terms = q.split(/\s+/)
    const score = (text: string, weight: number): number => {
      const t = text.toLowerCase()
      let s = 0
      for (const term of terms) {
        if (!t.includes(term)) return 0
        s += t === term ? 6 : t.startsWith(term) ? 3 : 1
      }
      return s * weight
    }
    const hits: SearchHit[] = []
    for (const n of this.built.model.nodes) {
      const s = Math.max(score(n.label, 5), score(n.purpose, 1.5), score(n.id, 2))
      if (s) hits.push({ kind: 'box', nodeId: n.id, title: n.label, detail: n.purpose.slice(0, 120), score: s + 2 })
      for (const r of n.routes ?? []) {
        const rs = score(r, 3)
        if (rs) hits.push({ kind: 'route', nodeId: n.id, title: r, detail: n.label, score: rs })
      }
    }
    for (const f of this.files.values()) {
      const owner = this.built.fileOwner[f.path] ?? null
      const fs_ = score(f.path, 1.2)
      if (fs_) hits.push({ kind: 'file', nodeId: owner, title: f.path, file: f.path, score: fs_ })
      for (const s of f.symbols) {
        const ss = Math.max(score(s.name, 4), score(s.signature, 1))
        if (ss) hits.push({ kind: 'symbol', nodeId: owner, title: s.name, detail: s.signature, file: f.path, line: s.line, score: ss + (s.exported ? 1 : 0) })
      }
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, limit)
  }

  // ── Bug → box: map a stack trace / error / failing test to boxes and symbols ───────────

  async locate(text: string): Promise<LocateResult> {
    const hits: LocateResult['hits'] = []
    const files = [...this.files.keys()]
    const owner = (f: string) => this.built?.fileOwner[f] ?? null
    const symbolAt = (f: string, line: number) =>
      this.files
        .get(f)
        ?.symbols.filter((s) => s.line && s.endLine && s.line <= line && line <= s.endLine)
        .sort((a, b) => a.endLine! - a.line! - (b.endLine! - b.line!))[0]

    // 1. file:line references in any common trace format.
    const refRe = /([\w@./\\-]+\.(?:tsx?|jsx?|mjs|cjs|py|go|rs|java|kt|cs|php|rb|swift|vue|svelte))(?:"?,? line |:|\()(\d+)/g
    let m: RegExpExecArray | null
    let order = 0
    while ((m = refRe.exec(text))) {
      const raw = m[1].replace(/\\/g, '/')
      const rel = files.find((f) => raw === f || raw.endsWith('/' + f)) ?? files.filter((f) => raw.endsWith(f.slice(f.indexOf('/') + 1))).sort((a, b) => b.length - a.length)[0]
      if (!rel) continue
      const o = owner(rel)
      if (!o) continue
      const line = Number(m[2])
      const sym = symbolAt(rel, line)
      hits.push({ nodeId: o, file: rel, line, symbol: sym?.name, reason: `stack frame ${rel}:${line}`, score: 10 - Math.min(order++, 8) })
    }

    // 2. HTTP request lines: "POST /api/orders 500".
    const httpRe = /\b(GET|POST|PUT|PATCH|DELETE)\s+(\/[\w/:{}.-]*)/g
    while ((m = httpRe.exec(text))) {
      for (const n of this.built?.model.nodes ?? []) {
        const r = n.routes?.find((r) => {
          const [method, p] = r.split(' ')
          return (method === m![1] || method === 'ANY') && pathsMatch(m![2], p)
        })
        if (r) hits.push({ nodeId: n.id, file: n.files[0] ?? '', reason: `serves ${r}`, score: 7 })
      }
    }

    // 3. Quoted error messages: find the string literal in the code.
    const quoted = [...text.matchAll(/["'`]([^"'`\n]{12,120})["'`]/g)].map((x) => x[1]).slice(0, 4)
    const firstLine = text.split('\n').map((l) => l.trim()).find((l) => l.length > 12)
    const needles = [...quoted, ...(firstLine ? [firstLine.replace(/^(\w*Error|Exception|Traceback)[:\s]*/i, '').slice(0, 80)] : [])].filter((s) => s.length >= 12)
    if (needles.length) {
      for (const f of files.slice(0, 6000)) {
        let content: string
        try {
          content = await this.readFile(f)
        } catch {
          continue
        }
        for (const n of needles) {
          const idx = content.indexOf(n)
          if (idx < 0) continue
          const line = content.slice(0, idx).split('\n').length
          const o = owner(f)
          if (o) hits.push({ nodeId: o, file: f, line, symbol: symbolAt(f, line)?.name, reason: `message “${n.slice(0, 40)}${n.length > 40 ? '…' : ''}” appears here`, score: 8 })
        }
      }
    }

    // 4. Identifiers that name known symbols.
    const idents = new Set([...text.matchAll(/\b([A-Za-z_][A-Za-z0-9_]{3,})\b/g)].map((x) => x[1]))
    for (const f of this.files.values()) {
      for (const s of f.symbols) {
        if (idents.has(s.name) && s.name.length > 4) {
          const o = owner(f.path)
          if (o) hits.push({ nodeId: o, file: f.path, line: s.line, symbol: s.name, reason: `mentions ${s.name}`, score: s.exported ? 3 : 2 })
        }
      }
    }

    // Merge duplicates, best first.
    const best = new Map<string, LocateResult['hits'][number]>()
    for (const h of hits) {
      const k = `${h.file}:${h.line ?? ''}:${h.symbol ?? ''}`
      const prev = best.get(k)
      if (!prev || prev.score < h.score) best.set(k, h)
    }
    const sorted = [...best.values()].sort((a, b) => b.score - a.score).slice(0, 25)
    const boxes = [...new Set(sorted.map((h) => h.nodeId))]
    const label = (id: string) => this.built?.model.nodes.find((n) => n.id === id)?.label ?? id
    return {
      hits: sorted,
      summary: sorted.length
        ? `Most likely in ${label(sorted[0].nodeId)}${sorted[0].symbol ? ` → ${sorted[0].symbol}()` : ''} (${sorted[0].file}${sorted[0].line ? ':' + sorted[0].line : ''}). ${boxes.length > 1 ? `Also involved: ${boxes.slice(1, 4).map(label).join(', ')}.` : ''}`
        : 'No match found in this repository.'
    }
  }
}

function isUnder(nodes: ArchNode[], id: string, ancestor: string): boolean {
  let cur = nodes.find((n) => n.id === id)?.parent
  while (cur) {
    if (cur === ancestor) return true
    cur = nodes.find((n) => n.id === cur)?.parent
  }
  return false
}

function isAncestorOf(d: ArchDefs, ancestor: string, id: string): boolean {
  let cur = d.boxes.find((b) => b.id === id)?.parent
  while (cur) {
    if (cur === ancestor) return true
    cur = d.boxes.find((b) => b.id === cur)?.parent
  }
  return false
}

/** Convert built nodes back into definitions (used for Initialize and for accepting proposals). */
function defsFromModel(name: string, built: BuildResult, only?: string[]): ArchDefs {
  const pick = (n: ArchNode) => !only || only.includes(n.id)
  const defs = emptyDefs(name)
  const nodes = built.model.nodes
  for (const n of nodes) {
    if (!pick(n)) continue
    if (n.kind === 'box') defs.boxes.push({ id: n.id, label: n.label, parent: n.parent, paths: n.paths ?? [], tech: n.tech })
    else if (n.kind === 'actor')
      defs.actors.push({
        id: n.id,
        label: n.label,
        type: n.actorType ?? 'user',
        description: n.purpose || undefined,
        reaches: built.model.edges.filter((e) => e.source === n.id).map((e) => e.target),
        routes: n.routes
      })
    else
      defs.services.push({
        id: n.id,
        label: n.label,
        kind: n.kind,
        tech: n.tech,
        purpose: n.purpose || undefined,
        match: (n.evidence ?? []).filter((e) => e.startsWith('imports ')).map((e) => e.slice(8))
      })
  }
  return defs
}

export { humanize }
