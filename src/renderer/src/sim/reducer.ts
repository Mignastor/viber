import type { ArchEdge, ArchModel, ArchNode } from '@shared/model'
import { diffCounts, fileContent } from '../model/code'
import type { ContextItem, ContractChange, SimEvent } from './scenario'

// Derives the whole session state from (model, events applied so far, user decisions).
// Being a pure function is what makes scrubbing / replay trivial.

export type Phase = 'idle' | 'context' | 'intent' | 'plan' | 'awaitApproval' | 'executing' | 'testing' | 'review'

export type WarningResolution = 'revert' | 'allow'
export type CandidateResolution = 'attach' | 'create'

export interface Decisions {
  planApproved: boolean
  warnings: Record<string, WarningResolution> // by event id
  candidates: Record<string, CandidateResolution> // by event id
}

export interface FileChange {
  path: string
  nodeId: string | null
  version: string
  added: number
  removed: number
  created: boolean
}

export interface FenceWarning {
  eventId: string
  nodeId: string
  file: string
  resolution?: WarningResolution
}

export interface Candidate {
  eventId: string
  nodeId: string
  file: string
  attachTo: string
  reason: string
  resolution?: CandidateResolution
}

export interface SimState {
  phase: Phase
  prompt: string | null
  scope: string[]
  context: { items: ContextItem[]; naiveNote: string } | null
  tokensUsed: number
  tokensNaive: number
  intent: { agent: string; nodes: string[]; summary: string } | null
  planSteps: string[]
  planApproved: boolean
  fence: string[]
  nodes: ArchNode[]
  edges: ArchEdge[]
  ghostNodes: Set<string>
  ghostEdges: Set<string>
  edgeChanges: Record<string, ContractChange>
  files: Record<string, FileChange>
  /** Nodes edited so far (leaf level). */
  touched: Set<string>
  activeNode: string | null
  activeFile: string | null
  activeEdges: Set<string>
  warnings: FenceWarning[]
  candidates: Candidate[]
  tests: Record<string, { passed: number; failed: number }>
  testRun: { selected: number; total: number; failures: string[] } | null
  doneSummary: string | null
}

export function initialState(model: ArchModel): SimState {
  return {
    phase: 'idle',
    prompt: null,
    scope: [],
    context: null,
    tokensUsed: 0,
    tokensNaive: 0,
    intent: null,
    planSteps: [],
    planApproved: false,
    fence: [],
    nodes: model.nodes,
    edges: model.edges,
    ghostNodes: new Set(),
    ghostEdges: new Set(),
    edgeChanges: {},
    files: {},
    touched: new Set(),
    activeNode: null,
    activeFile: null,
    activeEdges: new Set(),
    warnings: [],
    candidates: [],
    tests: {},
    testRun: null,
    doneSummary: null
  }
}

export function ancestors(nodes: ArchNode[], id: string): string[] {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const out: string[] = []
  let cur = byId.get(id)?.parent
  while (cur) {
    out.push(cur)
    cur = byId.get(cur)?.parent
  }
  return out
}

/** A node is inside the fence if it, an ancestor, or a descendant is fenced. */
export function inFence(state: SimState, id: string): boolean {
  if (state.fence.length === 0) return true
  const fence = new Set(state.fence)
  if (fence.has(id)) return true
  if (ancestors(state.nodes, id).some((a) => fence.has(a))) return true
  return state.fence.some((f) => ancestors(state.nodes, f).includes(id))
}

/** Map a file to the box that owns it, the way the watcher does: exact file, then same folder. */
export function mapFile(nodes: ArchNode[], path: string): string | null {
  const exact = nodes.find((n) => n.files.includes(path))
  if (exact) return exact.id
  let best: { id: string; len: number } | null = null
  for (const n of nodes) {
    for (const p of n.paths ?? []) {
      if (p && (path === p || path.startsWith(p + '/')) && (!best || p.length > best.len)) best = { id: n.id, len: p.length }
    }
  }
  if (best) return best.id
  const dir = path.slice(0, path.lastIndexOf('/') + 1)
  const sameDir = nodes.filter((n) => n.files.some((f) => f.slice(0, f.lastIndexOf('/') + 1) === dir))
  return sameDir.length === 1 ? sameDir[0].id : null
}

export function reduce(model: ArchModel, events: SimEvent[], decisions: Decisions): SimState {
  const s = initialState(model)
  let nodes = [...model.nodes]
  let edges = [...model.edges]

  events.forEach((ev, i) => {
    const isLast = i === events.length - 1
    s.tokensUsed += ev.t === 'context' ? ev.items.reduce((a, it) => a + it.tokens, 0) : ev.tokens
    s.tokensNaive += ev.naive
    s.activeNode = null
    s.activeFile = null
    s.activeEdges = new Set()

    switch (ev.t) {
      case 'task':
        s.phase = 'context'
        s.prompt = ev.prompt
        s.scope = ev.scope
        break
      case 'context':
        s.phase = 'context'
        s.context = { items: ev.items, naiveNote: ev.naiveNote }
        break
      case 'intent':
        s.phase = 'intent'
        s.intent = { agent: ev.agent, nodes: ev.nodes, summary: ev.summary }
        break
      case 'plan':
        s.phase = 'plan'
        s.planSteps = ev.steps
        nodes = [...nodes, ...ev.addNodes]
        edges = [...edges, ...ev.addEdges]
        ev.addNodes.forEach((n) => s.ghostNodes.add(n.id))
        ev.addEdges.forEach((e) => s.ghostEdges.add(e.id))
        s.edgeChanges = { ...ev.edgeChanges }
        ev.addEdges.forEach((e) => (s.edgeChanges[e.id] = { added: e.contract, removed: [] }))
        s.fence = [...ev.fence]
        break
      case 'approval':
        s.planApproved = decisions.planApproved
        s.phase = decisions.planApproved ? 'executing' : 'awaitApproval'
        break
      case 'edit': {
        s.phase = 'executing'
        let nodeId = mapFile(nodes, ev.file)
        let isCandidate = false

        // Unmapped file → new box candidate, classified by the extractor.
        if (!nodeId && ev.classify) {
          const c = ev.classify
          const resolution = decisions.candidates[ev.id]
          s.candidates.push({ eventId: ev.id, nodeId: c.node.id, file: ev.file, attachTo: c.attachTo, reason: c.reason, resolution })
          isCandidate = true
          if (resolution === 'attach') {
            nodes = nodes.map((n) => (n.id === c.attachTo ? { ...n, files: [...n.files, ev.file], symbols: [...n.symbols, ...c.node.symbols] } : n))
            nodeId = c.attachTo
          } else {
            nodes = [...nodes, c.node]
            edges = [...edges, ...c.edges]
            c.edges.forEach((e) => (s.edgeChanges[e.id] = { added: e.contract, removed: [] }))
            nodeId = c.node.id
          }
        }

        // Edit outside the approved fence → warning (unless the user already decided).
        if (nodeId && !isCandidate && s.planApproved && !inFence({ ...s, nodes }, nodeId)) {
          const resolution = decisions.warnings[ev.id]
          s.warnings.push({ eventId: ev.id, nodeId, file: ev.file, resolution })
          if (resolution === 'revert') {
            if (isLast) {
              s.activeNode = nodeId
              s.activeFile = ev.file
            }
            break
          }
          if (resolution === 'allow') s.fence.push(nodeId)
        }

        let added: number, removed: number, created: boolean
        if (ev.added !== undefined) {
          added = ev.added
          removed = ev.removed ?? 0
          created = !!ev.created
        } else {
          const before = fileContent(ev.file, 'base')
          ;({ added, removed } = diffCounts(before, fileContent(ev.file, ev.version)))
          created = before === ''
        }
        if (!added && !removed && !ev.deleted) {
          // Reverted back to the checkpoint: no longer a change.
          delete s.files[ev.file]
          break
        }
        s.files[ev.file] = { path: ev.file, nodeId, version: ev.version, added, removed, created }
        if (nodeId) {
          s.touched.add(nodeId)
          s.ghostNodes.delete(nodeId)
        }
        ev.edges?.forEach((id) => s.ghostEdges.delete(id))
        if (isLast) {
          s.activeNode = nodeId
          s.activeFile = ev.file
          s.activeEdges = new Set(ev.edges ?? [])
        }
        break
      }
      case 'contracts':
        for (const e of ev.newEdges) if (!edges.some((x) => x.id === e.id)) edges = [...edges, e]
        s.edgeChanges = { ...s.edgeChanges, ...ev.changes }
        s.activeEdges = new Set(Object.keys(ev.changes))
        break
      case 'runtime':
        if (ev.level === 'error') for (const b of ev.boxes) s.tests[b] = { passed: s.tests[b]?.passed ?? 0, failed: Math.max(1, s.tests[b]?.failed ?? 0) }
        break
      case 'tests':
        s.phase = 'testing'
        s.tests = { ...ev.results }
        s.testRun = { selected: ev.selected, total: ev.total, failures: ev.failures }
        break
      case 'done':
        s.phase = 'review'
        s.doneSummary = ev.summary
        break
    }
  })

  s.nodes = nodes
  s.edges = edges
  return s
}

/** Can the player move past `step` events, or is it waiting on the user? */
export function isBlocked(events: SimEvent[], step: number, decisions: Decisions): boolean {
  const last = events[step - 1]
  return last?.t === 'approval' && !decisions.planApproved
}
