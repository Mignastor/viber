import type { ArchEdge, ArchNode, ZoomLevel } from '@shared/model'
import { ancestors, inFence, type SimState } from '../sim/reducer'

// Turns (model + session state + zoom) into what the canvas draws.
// Zoom level L shows every node at depth ≤ L. Nodes above L with children become containers,
// nodes at L with children are collapsed and aggregate the state of everything inside them.

export type VisualState = 'idle' | 'warning' | 'active' | 'failing' | 'intent' | 'candidate' | 'ghost' | 'changed'
export type ReviewStatus = 'approved' | 'rejected'

export interface NodeView {
  id: string
  node: ArchNode
  depth: number
  parentId?: string
  container: boolean
  state: VisualState
  dimmed: boolean
  added: number
  removed: number
  tests?: { passed: number; failed: number }
  plannedInside: number
  hiddenChildren: number
  review?: ReviewStatus
  /** Descendants folded into this collapsed node (including itself). */
  members: string[]
  /** Actors that reach this node directly (it is front-facing to them). */
  facing: string[]
  /** Relation to the focused actor, when one is focused. */
  focus?: 'actor' | 'front' | 'reach' | 'out'
  proposed: boolean
  violation: boolean
}

export type EdgeState = 'idle' | 'active' | 'changed' | 'ghost'

export interface EdgeView {
  id: string
  source: string
  target: string
  members: ArchEdge[]
  state: EdgeState
  label: string
  dimmed: boolean
  violation: boolean
  proposed: boolean
}

export interface GraphView {
  nodes: NodeView[]
  edges: EdgeView[]
}

const ACTIVE_PHASES = new Set(['plan', 'awaitApproval', 'executing', 'testing'])

export function depthOf(nodes: ArchNode[], id: string): number {
  return ancestors(nodes, id).length + 1
}

export function descendants(nodes: ArchNode[], id: string): string[] {
  const out: string[] = []
  const walk = (p: string): void => {
    for (const n of nodes) if (n.parent === p) (out.push(n.id), walk(n.id))
  }
  walk(id)
  return out
}

/** The visible node that represents `id` at zoom L (itself or its ancestor at depth L). */
function representative(nodes: ArchNode[], id: string, L: number): string {
  const chain = [id, ...ancestors(nodes, id)] // self → root
  const d = chain.length
  return d <= L ? id : chain[d - L]
}

/** Boxes an actor reaches directly, and everything downstream of those. */
export function actorReach(s: SimState, actorId: string): { front: Set<string>; reach: Set<string> } {
  const expand = (ids: string[]): string[] => ids.flatMap((id) => [id, ...descendants(s.nodes, id)])
  const front = new Set(expand(s.edges.filter((e) => e.source === actorId).map((e) => e.target)))
  const reach = new Set(front)
  const queue = [...front]
  while (queue.length) {
    const cur = queue.shift()!
    for (const e of s.edges) {
      if (e.source !== cur || reach.has(e.target)) continue
      if (s.nodes.find((n) => n.id === e.target)?.kind === 'actor') continue
      for (const t of expand([e.target])) if (!reach.has(t)) (reach.add(t), queue.push(t))
    }
    // Containers reach what their children reach.
    for (const d of descendants(s.nodes, cur)) if (!reach.has(d)) (reach.add(d), queue.push(d))
  }
  return { front, reach }
}

export function buildView(s: SimState, zoom: ZoomLevel, reviews: Record<string, ReviewStatus>, actorFocus: string | null = null, violations: Set<string> = new Set()): GraphView {
  const nodes = s.nodes
  const hasChildren = new Set(nodes.filter((n) => n.parent).map((n) => n.parent!))
  const fencing = ACTIVE_PHASES.has(s.phase) && s.fence.length > 0
  const intentOpen = s.intent && s.phase !== 'review' ? s.intent.nodes.filter((id) => !s.touched.has(id)) : []
  const focus = actorFocus && nodes.some((n) => n.id === actorFocus) ? actorReach(s, actorFocus) : null
  const actorIds = new Set(nodes.filter((n) => n.kind === 'actor').map((n) => n.id))
  const facingOf = new Map<string, Set<string>>()
  for (const e of s.edges) {
    if (!actorIds.has(e.source)) continue
    for (const t of [e.target, ...ancestors(nodes, e.target)]) facingOf.set(t, new Set([...(facingOf.get(t) ?? []), e.source]))
  }

  const views: NodeView[] = nodes
    .map((n) => ({ n, depth: depthOf(nodes, n.id) }))
    .filter(({ depth }) => depth <= zoom)
    .map(({ n, depth }) => {
      const container = depth < zoom && hasChildren.has(n.id)
      const members = container ? [n.id] : [n.id, ...descendants(nodes, n.id)]
      const inS = (id: string | null | undefined): boolean => !!id && members.includes(id)

      let state: VisualState = 'idle'
      if (s.warnings.some((w) => !w.resolution && inS(w.nodeId))) state = 'warning'
      else if (inS(s.activeNode)) state = 'active'
      else if (members.some((m) => (s.tests[m]?.failed ?? 0) > 0)) state = 'failing'
      else if (intentOpen.some(inS)) state = 'intent'
      else if (s.candidates.some((c) => !c.resolution && inS(c.nodeId))) state = 'candidate'
      else if (s.ghostNodes.has(n.id)) state = 'ghost'
      else if (members.some((m) => s.touched.has(m))) state = 'changed'

      let added = 0
      let removed = 0
      for (const f of Object.values(s.files)) {
        if (inS(f.nodeId)) (added += f.added), (removed += f.removed)
      }

      let tests: NodeView['tests']
      for (const m of members) {
        const t = s.tests[m]
        if (t) tests = { passed: (tests?.passed ?? 0) + t.passed, failed: (tests?.failed ?? 0) + t.failed }
      }

      const changedMembers = members.filter((m) => s.touched.has(m))
      let review: ReviewStatus | undefined
      if (changedMembers.length && changedMembers.some((m) => reviews[m] === 'rejected')) review = 'rejected'
      else if (changedMembers.length && changedMembers.every((m) => reviews[m] === 'approved')) review = 'approved'

      const parentId = n.parent && depthOf(nodes, n.parent) < zoom ? n.parent : undefined
      let focusRel: NodeView['focus']
      if (focus) {
        if (n.id === actorFocus) focusRel = 'actor'
        else if (members.some((m) => focus.front.has(m))) focusRel = 'front'
        else if (members.some((m) => focus.reach.has(m))) focusRel = 'reach'
        else focusRel = 'out'
      }
      return {
        id: n.id,
        node: n,
        depth,
        parentId,
        container,
        state,
        // Alerts are never dimmed: they are exactly what needs your attention.
        dimmed: fencing && state !== 'warning' && state !== 'candidate' && !inFence(s, n.id),
        added,
        removed,
        tests,
        plannedInside: container ? 0 : members.filter((m) => m !== n.id && s.ghostNodes.has(m)).length,
        hiddenChildren: container ? 0 : nodes.filter((c) => c.parent === n.id).length,
        review,
        members,
        facing: [...(facingOf.get(n.id) ?? [])],
        focus: focusRel,
        proposed: !!n.proposed,
        violation: false
      }
    })

  const visible = new Map(views.map((v) => [v.id, v]))
  const showChanges = s.phase !== 'idle' && s.planSteps.length > 0
  const groups = new Map<string, EdgeView>()
  for (const e of s.edges) {
    if (!nodes.some((n) => n.id === e.source) || !nodes.some((n) => n.id === e.target)) continue
    const src = representative(nodes, e.source, zoom)
    const tgt = representative(nodes, e.target, zoom)
    if (src === tgt || !visible.has(src) || !visible.has(tgt)) continue
    // A container's own files depending on its children (or vice versa) reads as noise on the map.
    if (ancestors(nodes, tgt).includes(src) || ancestors(nodes, src).includes(tgt)) continue
    const key = `${src}->${tgt}`
    const g = groups.get(key) ?? { id: key, source: src, target: tgt, members: [], state: 'idle', label: '', dimmed: false, violation: false, proposed: false }
    g.members.push(e)
    groups.set(key, g)
  }
  for (const g of groups.values()) {
    const ids = g.members.map((m) => m.id)
    if (ids.some((id) => s.activeEdges.has(id))) g.state = 'active'
    else if (ids.every((id) => s.ghostEdges.has(id))) g.state = 'ghost'
    else if (showChanges && ids.some((id) => s.edgeChanges[id] || s.ghostEdges.has(id))) g.state = 'changed'
    g.label = g.members.length === 1 ? g.members[0].label : `${g.members.length} links`
    g.violation = ids.some((id) => violations.has(id))
    g.proposed = !!(visible.get(g.source)?.proposed || visible.get(g.target)?.proposed)
    const fs = visible.get(g.source)?.focus
    const ft = visible.get(g.target)?.focus
    g.dimmed = !!(visible.get(g.source)?.dimmed || visible.get(g.target)?.dimmed) || (!!focus && (fs === 'out' || ft === 'out'))
  }

  return { nodes: views, edges: [...groups.values()] }
}
