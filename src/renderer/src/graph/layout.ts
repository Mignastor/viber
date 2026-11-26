import ELK, { type ElkNode } from 'elkjs/lib/elk.bundled.js'
import type { NodeKind } from '@shared/model'
import type { EdgeView, NodeView } from './view'

// Layout stability rules:
//  1. ELK lays out the graph once per zoom level, and those positions are then pinned.
//  2. New boxes are placed next to a neighbour without moving anything else; when a container
//     must grow, only the nodes to its right/below are pushed, by the exact growth amount.
//  3. User drags are pinned too. Nothing is ever fully re-laid-out automatically.

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}
/** Positions relative to the node's visible parent container (React Flow sub-flow convention). */
export type Layout = Record<string, Rect>

export const SIZE: Record<NodeKind, { w: number; h: number }> = {
  box: { w: 188, h: 76 },
  actor: { w: 150, h: 58 },
  external: { w: 164, h: 62 },
  datastore: { w: 176, h: 76 }
}

const PAD = { top: 46, left: 22, bottom: 22, right: 22 }
const GAP = 34

const elk = new ELK()

export async function elkLayout(nodes: NodeView[], edges: EdgeView[]): Promise<Layout> {
  const byParent = new Map<string | undefined, NodeView[]>()
  for (const n of nodes) byParent.set(n.parentId, [...(byParent.get(n.parentId) ?? []), n])

  const toElk = (n: NodeView): ElkNode => {
    const children = byParent.get(n.id) ?? []
    if (n.container && children.length) {
      return {
        id: n.id,
        layoutOptions: { 'elk.padding': `[top=${PAD.top},left=${PAD.left},bottom=${PAD.bottom},right=${PAD.right}]` },
        children: children.map(toElk)
      }
    }
    return { id: n.id, ...size(n) }
  }

  const graph: ElkNode = {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'DOWN',
      'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
      'elk.layered.spacing.nodeNodeBetweenLayers': '56',
      'elk.spacing.nodeNode': '28',
      'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
      'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES'
    },
    children: (byParent.get(undefined) ?? []).map(toElk),
    edges: edges.map((e) => ({ id: e.id, sources: [e.source], targets: [e.target] }))
  }

  const out = await elk.layout(graph)
  const layout: Layout = {}
  const collect = (n: ElkNode): void => {
    for (const c of n.children ?? []) {
      layout[c.id] = { x: c.x ?? 0, y: c.y ?? 0, w: c.width ?? 0, h: c.height ?? 0 }
      collect(c)
    }
  }
  collect(out)
  return layout
}

export function size(n: NodeView): { width: number; height: number } {
  const s = SIZE[n.node.kind]
  return { width: s.w, height: s.h }
}

const overlaps = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.w + GAP / 2 && b.x < a.x + a.w + GAP / 2 && a.y < b.y + b.h + GAP / 2 && b.y < a.y + a.h + GAP / 2

/**
 * Give every visible node without a pinned position a place, without moving pinned nodes
 * (except pushing nodes aside when a container grows). Returns a new layout or the same
 * object when nothing was missing.
 */
export function placeMissing(layout: Layout, nodes: NodeView[], edges: EdgeView[]): Layout {
  const missing = nodes.filter((n) => !layout[n.id]).sort((a, b) => a.depth - b.depth)
  if (!missing.length) return layout
  const L: Layout = { ...layout }
  const parentOf = new Map(nodes.map((n) => [n.id, n.parentId]))

  for (const n of missing) {
    const { width: w, height: h } = size(n)
    const siblings = nodes.filter((s) => s.parentId === n.parentId && s.id !== n.id && L[s.id]).map((s) => L[s.id])
    const anchorId = edges
      .filter((e) => e.target === n.id || e.source === n.id)
      .map((e) => (e.target === n.id ? e.source : e.target))
      .find((id) => parentOf.get(id) === n.parentId && L[id])
    const parent = n.parentId ? L[n.parentId] : undefined

    let r: Rect
    if (anchorId) {
      const a = L[anchorId]
      const isCallee = edges.some((e) => e.source === anchorId && e.target === n.id)
      // Top-down layout: a callee goes below its caller, a caller above; fall back to the side.
      const vertical: Rect = { x: a.x, y: isCallee ? a.y + a.h + GAP + 22 : a.y - h - GAP - 22, w, h }
      const side: Rect = { x: a.x + a.w + GAP, y: a.y, w, h }
      const fitsParent = (c: Rect) => !parent || (c.x >= PAD.left && c.y >= PAD.top && c.x + w + PAD.right <= parent.w)
      r = [vertical, side].find((c) => fitsParent(c) && !siblings.some((s) => overlaps(s, c))) ?? vertical
    } else {
      const bottom = siblings.reduce((m, s) => Math.max(m, s.y + s.h), parent ? PAD.top - GAP : 0)
      r = { x: parent ? PAD.left : 0, y: bottom + GAP, w, h }
    }
    // Slide down until free.
    for (let guard = 0; guard < 50; guard++) {
      const hit = siblings.find((s) => overlaps(s, r))
      if (!hit) break
      r = { ...r, y: hit.y + hit.h + GAP }
    }
    L[n.id] = r
    if (n.parentId) grow(L, nodes, n.parentId, r)
  }
  return L
}

/** Grow container `id` so it encloses `child`, pushing its own siblings aside, recursively. */
function grow(L: Layout, nodes: NodeView[], id: string, child: Rect): void {
  const c = L[id]
  if (!c) return
  const dw = Math.max(0, child.x + child.w + PAD.right - c.w)
  const dh = Math.max(0, child.y + child.h + PAD.bottom - c.h)
  if (!dw && !dh) return
  const old = { ...c }
  L[id] = { ...c, w: c.w + dw, h: c.h + dh }
  const parentId = nodes.find((n) => n.id === id)?.parentId
  const moved: Rect[] = [L[id]]
  for (const s of nodes) {
    if (s.parentId !== parentId || s.id === id || !L[s.id]) continue
    const r = L[s.id]
    const vOverlap = r.y < old.y + old.h && old.y < r.y + r.h
    const hOverlap = r.x < old.x + old.w && old.x < r.x + r.w
    if (dw && r.x >= old.x + old.w - 1 && vOverlap) L[s.id] = { ...r, x: r.x + dw }
    else if (dh && r.y >= old.y + old.h - 1 && hOverlap) L[s.id] = { ...r, y: r.y + dh }
    else continue
    moved.push(L[s.id])
  }
  if (parentId) for (const r of moved) grow(L, nodes, parentId, r)
}
