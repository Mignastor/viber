import { EventEmitter } from 'events'
import { promises as fs } from 'fs'
import path from 'path'
import { app } from 'electron'
import chokidar, { type FSWatcher } from 'chokidar'
import type { ArchEdge } from '@shared/model'
import type { SimEvent, ContractChange, EventInput } from '@shared/events'
import type { SessionInfo, StartSessionInput } from '@shared/api'
import type { Workspace } from './workspace'
import { addWorktree, createCheckpoint, diffCounts, isRepo, removeWorktree, showAt } from './git'
import { humanize } from './engine/group'

// Sessions are what the map lights up for. One "watching" session always observes the repo, so
// edits from *any* agent or editor show up (agent-agnostic). Agent runs get their own session with
// a checkpoint, a fence, a plan gate and, optionally, an isolated git worktree.

const IGNORED = /(^|[\\/])(node_modules|\.git|dist|build|out|\.next|\.nuxt|\.svelte-kit|target|vendor|__pycache__|\.venv|venv|coverage|\.arch|\.turbo|\.cache|\.idea|\.vscode|bin|obj)([\\/]|$)/
const SESSION_COLORS = ['#3fd0ff', '#f472b6', '#4ade80', '#fb923c', '#c084fc', '#facc15']

type Decision = { approved: boolean; feedback?: string }

/**
 * Something an agent waits on from the human: a plan, a question, a contract change. Agents can't block
 * for long (MCP clients time out after a few minutes), so they wait in rounds; the human's answer is kept
 * here even if it arrives between two rounds.
 */
interface Gate {
  label: string
  settled: boolean
  value?: unknown
  resolvers: ((v: unknown) => void)[]
}

/** How long one waiting round lasts: under every MCP client's tool timeout. */
export const HUMAN_WAIT_MS = 4 * 60_000

export class Session {
  info: SessionInfo
  events: SimEvent[] = []
  checkpoint: string | null = null
  /** Non-git fallback: file contents at session start. */
  snapshot: Map<string, string> | null = null
  fence: string[] = []
  baselineEdges = new Map<string, string[]>()
  gates = new Map<string, Gate>()
  stop: (() => void) | null = null
  seq = 0
  autoApprove = false

  constructor(info: SessionInfo) {
    this.info = info
  }

  get root(): string {
    return this.info.cwd
  }

  get id(): string {
    return this.info.id
  }
}

export class SessionManager extends EventEmitter {
  sessions = new Map<string, Session>()
  private watchers = new Map<string, FSWatcher>()
  private pending = new Map<string, ReturnType<typeof setTimeout>>()
  private modelTimer: ReturnType<typeof setTimeout> | null = null
  private changedForModel = new Set<string>()
  watching!: Session

  constructor(private ws: Workspace) {
    super()
  }

  async init(): Promise<void> {
    const s = new Session({
      id: 'watch',
      title: 'Changes on disk',
      agent: 'external',
      status: 'watching',
      cwd: this.ws.root,
      scope: [],
      color: SESSION_COLORS[0],
      startedAt: Date.now(),
      tokens: { input: 0, output: 0, cacheRead: 0 },
      ambient: true
    })
    // Baseline for "changes on disk": HEAD (what's committed).
    s.checkpoint = (await isRepo(this.ws.root)) ? 'HEAD' : null
    if (!s.checkpoint) s.snapshot = await this.snapshotFiles(this.ws.root)
    this.recordBaseline(s)
    this.sessions.set(s.id, s)
    this.watching = s
    this.watch(this.ws.root)
    this.emitList()
  }

  dispose(): void {
    for (const w of this.watchers.values()) void w.close()
    for (const s of this.sessions.values()) s.stop?.()
    this.removeAllListeners()
  }

  list(): SessionInfo[] {
    return [...this.sessions.values()].map((s) => s.info)
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id)
  }

  /** The session that owns edits under `dir`: the latest running agent session there, else the watcher. */
  private ownerFor(dir: string): Session {
    const running = [...this.sessions.values()].filter((s) => !s.info.ambient && s.root === dir && (s.info.status === 'running' || s.info.status === 'waiting'))
    return running[running.length - 1] ?? (dir === this.ws.root ? this.watching : [...this.sessions.values()].find((s) => s.root === dir) ?? this.watching)
  }

  async create(input: StartSessionInput & { title: string }): Promise<Session> {
    const id = Math.random().toString(36).slice(2, 8)
    let cwd = this.ws.root
    let worktree: SessionInfo['worktree']
    if (input.isolate && (await isRepo(this.ws.root))) {
      const dir = path.join(app.getPath('userData'), 'worktrees', `${this.ws.name}-${id}`)
      const branch = `viber/${id}`
      const r = await addWorktree(this.ws.root, dir, branch)
      if (r.code === 0) {
        cwd = dir
        worktree = { dir, branch }
      } else {
        throw new Error('Could not create a worktree: ' + r.stderr.trim())
      }
    }
    const used = new Set([...this.sessions.values()].map((s) => s.info.color))
    const s = new Session({
      id,
      title: input.title,
      agent: input.agent,
      status: 'running',
      cwd,
      worktree,
      scope: input.scope,
      color: SESSION_COLORS.find((c) => !used.has(c)) ?? SESSION_COLORS[this.sessions.size % SESSION_COLORS.length],
      startedAt: Date.now(),
      tokens: { input: 0, output: 0, cacheRead: 0 },
      model: input.model
    })
    s.checkpoint = await createCheckpoint(cwd, `session-${id}`)
    if (!s.checkpoint) s.snapshot = await this.snapshotFiles(cwd)
    s.fence = [...input.scope]
    s.autoApprove = !!input.autoApprove
    this.recordBaseline(s)
    this.sessions.set(id, s)
    if (cwd !== this.ws.root) this.watch(cwd)
    this.emitList()
    return s
  }

  push(sessionId: string, ev: EventInput): void {
    const s = this.sessions.get(sessionId)
    if (!s) return
    const full = { ms: 0, ...ev, id: ev.id ?? `${sessionId}-${++s.seq}` } as SimEvent
    if (full.t === 'plan') s.fence = [...new Set([...s.fence, ...full.fence])]
    s.events.push(full)
    s.info.tokens.input += full.tokens
    this.emit('event', { sessionId, event: full })
  }

  setStatus(sessionId: string, status: SessionInfo['status']): void {
    const s = this.sessions.get(sessionId)
    if (!s) return
    s.info.status = status
    this.emitList()
  }

  addUsage(sessionId: string, u: { input?: number; output?: number; cacheRead?: number; costUsd?: number }): void {
    const s = this.sessions.get(sessionId)
    if (!s) return
    s.info.tokens.input += u.input ?? 0
    s.info.tokens.output += u.output ?? 0
    s.info.tokens.cacheRead += u.cacheRead ?? 0
    if (u.costUsd !== undefined) s.info.tokens.costUsd = (s.info.tokens.costUsd ?? 0) + u.costUsd
    this.emitList()
  }

  emitList(): void {
    this.emit('list', this.list())
  }

  // ── Plan gate (used by the MCP propose_plan tool and the built-in agent) ─────────────

  openGate(sessionId: string, key: string, label: string): void {
    const s = this.sessions.get(sessionId)
    if (!s) return
    s.gates.set(key, { label, settled: false, resolvers: [] })
    this.setStatus(sessionId, 'waiting')
  }

  /** Record the human's answer. False when nothing is waiting under that key (expired, or already answered). */
  settleGate(sessionId: string, key: string, value: unknown): boolean {
    const s = this.sessions.get(sessionId)
    const g = s?.gates.get(key)
    if (!s || !g || g.settled) return false
    g.settled = true
    g.value = value
    for (const r of g.resolvers.splice(0)) r(value)
    return true
  }

  /** Wait one round for a gate; undefined when the round ends first (the gate stays open). */
  waitGate<T>(sessionId: string, key: string, ms = HUMAN_WAIT_MS): Promise<T | undefined> {
    const s = this.sessions.get(sessionId)
    const g = s?.gates.get(key)
    if (!s || !g) return Promise.resolve(undefined)
    const take = (v: unknown): T => {
      s.gates.delete(key)
      if (![...s.gates.values()].some((x) => !x.settled) && s.info.status === 'waiting') this.setStatus(sessionId, 'running')
      return v as T
    }
    if (g.settled) return Promise.resolve(take(g.value))
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        g.resolvers = g.resolvers.filter((r) => r !== done)
        resolve(undefined)
      }, ms)
      const done = (v: unknown): void => {
        clearTimeout(t)
        resolve(take(v))
      }
      g.resolvers.push(done)
    })
  }

  /** Gates still waiting for the human, oldest first. */
  openGates(sessionId: string): { key: string; label: string; settled: boolean }[] {
    const s = this.sessions.get(sessionId)
    return s ? [...s.gates.entries()].map(([key, g]) => ({ key, label: g.label, settled: g.settled })) : []
  }

  /** Close every gate (the session stopped or ended): answers that arrive later are refused. */
  closeGates(sessionId: string, value: unknown): void {
    const s = this.sessions.get(sessionId)
    if (!s) return
    for (const [key] of s.gates) this.settleGate(sessionId, key, value)
    s.gates.clear()
  }

  /** The human's decision on the pending plan; false when no plan is waiting any more. */
  decidePlan(sessionId: string, approved: boolean, feedback?: string): boolean {
    const s = this.sessions.get(sessionId)
    if (!s || ['done', 'error', 'stopped'].includes(s.info.status)) return false
    if (!this.settleGate(sessionId, 'plan', { approved, feedback })) return false
    this.push(sessionId, { t: 'message', role: 'user', text: approved ? 'Plan approved' : `Plan rejected${feedback ? ': ' + feedback : ''}`, tokens: 0, naive: 0 })
    return true
  }

  // ── Checkpoint access ───────────────────────────────────────────────────────────────

  async baseContent(sessionId: string, rel: string): Promise<string> {
    const s = this.sessions.get(sessionId) ?? this.watching
    const text = s.checkpoint ? ((await showAt(s.root, s.checkpoint, rel)) ?? '') : (s.snapshot?.get(rel) ?? '')
    return text.replace(/\r\n/g, '\n')
  }

  async currentContent(sessionId: string, rel: string): Promise<string> {
    const s = this.sessions.get(sessionId) ?? this.watching
    return (await fs.readFile(path.join(s.root, rel), 'utf8').catch(() => '')).replace(/\r\n/g, '\n')
  }

  /** Put files back to how they were at the session checkpoint (deleting files the session created). */
  async revert(sessionId: string, files: string[]): Promise<void> {
    const s = this.sessions.get(sessionId) ?? this.watching
    for (const rel of files) {
      const abs = path.join(s.root, rel)
      const base = s.checkpoint ? await showAt(s.root, s.checkpoint, rel) : (s.snapshot?.get(rel) ?? null)
      if (base === null) await fs.rm(abs, { force: true })
      else {
        // Keep the file's current line endings so a revert doesn't show up as a whole-file change.
        const current = await fs.readFile(abs, 'utf8').catch(() => '')
        const lf = base.replace(/\r\n/g, '\n')
        await fs.mkdir(path.dirname(abs), { recursive: true })
        await fs.writeFile(abs, current.includes('\r\n') ? lf.replace(/\n/g, '\r\n') : lf)
      }
    }
  }

  async discardWorktree(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId)
    if (!s?.info.worktree) return
    await this.watchers.get(s.root)?.close()
    this.watchers.delete(s.root)
    await removeWorktree(this.ws.root, s.info.worktree.dir)
  }

  // ── Watching ────────────────────────────────────────────────────────────────────────

  private watch(dir: string): void {
    if (this.watchers.has(dir)) return
    const w = chokidar.watch(dir, {
      ignored: (p: string) => IGNORED.test(path.relative(dir, p)),
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 180, pollInterval: 60 }
    })
    const on = (abs: string): void => {
      const rel = path.relative(dir, abs).split(path.sep).join('/')
      if (!rel || rel.startsWith('..')) return
      const key = dir + '|' + rel
      clearTimeout(this.pending.get(key))
      this.pending.set(
        key,
        setTimeout(() => {
          this.pending.delete(key)
          void this.onFileChanged(dir, rel)
        }, 150)
      )
    }
    w.on('add', on).on('change', on).on('unlink', on)
    this.watchers.set(dir, w)
  }

  private async onFileChanged(dir: string, rel: string): Promise<void> {
    const s = this.ownerFor(dir)
    const base = s.checkpoint ? await showAt(dir, s.checkpoint, rel) : (s.snapshot?.get(rel) ?? null)
    let current: string | null = null
    try {
      current = await fs.readFile(path.join(dir, rel), 'utf8')
    } catch {
      current = null
    }
    if (current !== null && current.includes('\u0000')) return // binary
    const { added, removed } = diffCounts(base ?? '', current ?? '')

    // Update the model for files in the main repo (worktrees are separate copies).
    if (dir === this.ws.root) await this.queueModelUpdate(rel)

    const classify = this.ws.ownerOfFile(rel) ? undefined : this.classify(rel)
    const edges = this.ws.edgesForFile(rel)
    this.push(s.id, {
      t: 'edit',
      file: rel,
      version: 'disk',
      note: current === null ? 'Deleted' : base === null ? 'Created' : 'Modified',
      added,
      removed,
      created: base === null,
      deleted: current === null,
      edges,
      classify,
      tokens: 0,
      naive: 0
    })
    this.emit('fileChanged', { dir, rel })
    this.checkContracts(s)
  }

  private queueModelUpdate(rel: string): Promise<void> {
    this.changedForModel.add(rel)
    return new Promise((resolve) => {
      if (this.modelTimer) clearTimeout(this.modelTimer)
      this.modelTimer = setTimeout(async () => {
        const paths = [...this.changedForModel]
        this.changedForModel.clear()
        this.modelTimer = null
        try {
          await this.ws.updatePaths(paths)
        } finally {
          resolve()
        }
      }, 120)
      // Callers don't need to wait for later batches.
      setTimeout(resolve, 400)
    })
  }

  /** Unmapped file → proposed new box under its top-most new folder, or attach to the closest box. */
  private classify(rel: string): Extract<SimEvent, { t: 'edit' }>['classify'] {
    const segs = rel.split('/')
    const dir = segs.length > 1 ? segs.slice(0, Math.min(segs.length - 1, 2)).join('/') : rel
    const boxes = this.ws.built?.model.nodes.filter((n) => n.kind === 'box') ?? []
    // Closest box by shared path prefix.
    const score = (p: string): number => {
      let i = 0
      while (i < p.length && i < rel.length && p[i] === rel[i]) i++
      return i
    }
    const closest = [...boxes].sort((a, b) => Math.max(...(b.paths ?? ['']).map(score)) - Math.max(...(a.paths ?? ['']).map(score)))[0]
    return {
      node: {
        id: dir,
        label: humanize(path.posix.basename(dir).replace(/\.\w+$/, '')),
        kind: 'box',
        purpose: `New code in ${dir}.`,
        files: [rel],
        paths: [dir],
        symbols: []
      },
      edges: [],
      attachTo: closest?.id ?? '',
      reason: `${rel} is not inside any box.`
    }
  }

  private recordBaseline(s: Session): void {
    s.baselineEdges = new Map((this.ws.built?.model.edges ?? []).map((e) => [e.id, e.contract]))
  }

  /** Compare edge contracts with the session's baseline; emit what changed. */
  private checkContracts(s: Session): void {
    const edges = this.ws.built?.model.edges ?? []
    const changes: Record<string, ContractChange> = {}
    const newEdges: ArchEdge[] = []
    for (const e of edges) {
      if (e.kind === 'uses') continue
      const before = s.baselineEdges.get(e.id)
      if (!before) {
        newEdges.push(e)
        changes[e.id] = { added: e.contract, removed: [] }
        continue
      }
      const added = e.contract.filter((c) => !before.includes(c))
      const removed = before.filter((c) => !e.contract.includes(c))
      if (added.length || removed.length) changes[e.id] = { added, removed }
    }
    const key = JSON.stringify(changes)
    if (key === (s as unknown as { lastContracts?: string }).lastContracts || key === '{}') return
    ;(s as unknown as { lastContracts?: string }).lastContracts = key
    this.push(s.id, { t: 'contracts', changes, newEdges, tokens: 0, naive: 0 })
  }

  private async snapshotFiles(dir: string): Promise<Map<string, string>> {
    const m = new Map<string, string>()
    let total = 0
    for (const f of this.ws.scan?.files ?? []) {
      if (total > 60_000_000) break
      try {
        const t = await fs.readFile(path.join(dir, f.path), 'utf8')
        m.set(f.path, t)
        total += t.length
      } catch {
        /* skip */
      }
    }
    return m
  }
}
