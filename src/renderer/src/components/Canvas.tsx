import { useCallback, useEffect, useMemo, useRef } from 'react'
import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  useReactFlow,
  type NodeChange,
  type NodeMouseHandler,
  type EdgeMouseHandler
} from '@xyflow/react'
import { useModel, useSim, useStore } from '../store'
import { buildView } from '../graph/view'
import { elkLayout, placeMissing, type Rect } from '../graph/layout'
import { ArchNodeCard, ContainerNode, type ArchFlowNode, type ContainerFlowNode } from './ArchNodeCard'
import { FloatingEdge, type FloatingFlowEdge } from './FloatingEdge'
import { PromptBar } from './PromptBar'
import { actorColor } from './colors'
import { ExplainBar, HistoryBar, useHeat } from './Modes'
import { DesignToolbar } from './DesignDialogs'
import { cssVar, useTheme } from '../theme'

const nodeTypes = { arch: ArchNodeCard, container: ContainerNode }
const edgeTypes = { floating: FloatingEdge }

export function Canvas() {
  const sim = useSim()
  const model = useModel()
  const baseIds = useMemo(() => new Set(model.nodes.map((n) => n.id)), [model])
  const zoom = useStore((s) => s.zoom)
  const reviews = useStore((s) => s.reviews)
  const layout = useStore((s) => s.layouts[zoom])
  const selection = useStore((s) => s.selection)
  const scope = useStore((s) => s.scope)
  const fit = useStore((s) => s.fit)
  const actorFocus = useStore((s) => s.actorFocus)
  const highlight = useStore((s) => s.highlight)
  const picking = useStore((s) => s.picking)
  const runtime = useStore((s) => s.runtime)
  const thumbs = useStore((s) => s.thumbs)
  const explain = useStore((s) => s.explain)
  const heat = useHeat()
  const theme = useTheme()
  const preview = useStore((s) => s.preview)
  const acps = useStore((s) => s.acps)
  const acpBoxes = useMemo(() => new Set(acps.filter((a) => a.status === 'pending').map((a) => a.box)), [acps])
  const acpPairs = useMemo(() => new Set(acps.filter((a) => a.status === 'pending' && a.consumer).map((a) => `${a.consumer}->${a.box}`)), [acps])
  const baseModel = useStore((s) => s.snapshot?.model)
  // Diagram diff: what the previewed proposal adds compared with the saved model.
  const previewNew = useMemo(() => {
    if (!preview || !baseModel) return null
    const ids = new Set(baseModel.nodes.map((n) => n.id))
    const eids = new Set(baseModel.edges.map((e) => e.id))
    return { nodes: new Set(preview.model.nodes.filter((n) => !ids.has(n.id)).map((n) => n.id)), edges: new Set(preview.model.edges.filter((e) => !eids.has(e.id)).map((e) => e.id)) }
  }, [preview, baseModel])
  const { setLayout, moveNode, select, setZoom } = useStore.getState()
  const rf = useReactFlow()

  const violations = useMemo(() => new Set((model.violations ?? []).map((v) => v.edge)), [model])
  const view = useMemo(() => buildView(sim, zoom, reviews, actorFocus, violations), [sim, zoom, reviews, actorFocus, violations])
  // Playback (journeys and Explain): which visible node stands for each step, at this zoom.
  const playback = useMemo(() => {
    if (!explain) return null
    const repOf = (id: string): string | undefined => view.nodes.find((v) => v.id === id)?.id ?? view.nodes.find((v) => !v.container && v.members.includes(id))?.id
    const reps = explain.path.map(repOf)
    const pair = (a?: string, b?: string): { id?: string; reverse: boolean } => {
      if (!a || !b || a === b) return { reverse: false }
      const fwd = view.edges.find((e) => e.source === a && e.target === b)
      if (fwd) return { id: fwd.id, reverse: false }
      const back = view.edges.find((e) => e.source === b && e.target === a)
      return back ? { id: back.id, reverse: true } : { reverse: false }
    }
    const visitedEdges = new Map<string, boolean>()
    const hops: { id: string; source: string; target: string; current: boolean; label: string }[] = []
    for (let j = 1; j <= explain.i; j++) {
      const p = pair(reps[j - 1], reps[j])
      if (p.id) visitedEdges.set(p.id, p.reverse)
      else if (reps[j - 1] && reps[j] && reps[j - 1] !== reps[j]) hops.push({ id: `hop-${j}`, source: reps[j - 1]!, target: reps[j]!, current: j === explain.i, label: explain.actions?.[j] ?? '' })
    }
    const cur = explain.i > 0 ? pair(reps[explain.i - 1], reps[explain.i]) : { reverse: false }
    return {
      current: reps[explain.i],
      visited: new Set(reps.slice(0, explain.i + 1).filter(Boolean) as string[]),
      onPath: new Set(reps.filter(Boolean) as string[]),
      stepOf: (id: string): number => reps.indexOf(id),
      currentEdge: cur.id,
      currentReverse: cur.reverse,
      visitedEdges,
      hops
    }
  }, [explain, view])

  // 1. First visit to a zoom level: ELK lays out the *base* model once, then it is pinned.
  useEffect(() => {
    if (layout) return
    let cancelled = false
    const nodes = view.nodes.filter((n) => baseIds.has(n.id))
    const ids = new Set(nodes.map((n) => n.id))
    const edges = view.edges.filter((e) => ids.has(e.source) && ids.has(e.target))
    elkLayout(nodes, edges).then((l) => !cancelled && setLayout(zoom, l))
    return () => {
      cancelled = true
    }
  }, [layout, zoom, view, setLayout, baseIds])

  // 2. Boxes that appear later (planned, candidates) are placed incrementally around pinned ones.
  useEffect(() => {
    if (!layout) return
    const next = placeMissing(layout, view.nodes, view.edges)
    if (next !== layout) {
      setLayout(zoom, next)
      if (view.nodes.some((n) => !layout[n.id] && !n.parentId)) useStore.setState((s) => ({ fit: { n: s.fit.n + 1 } }))
    }
  }, [layout, view, zoom, setLayout])

  // 3. Fit on request (zoom-level change, reset). Computed from the pinned layout rather than
  //    measured DOM, so it is exact even before React Flow has measured anything.
  const lastFit = useRef(-1)
  const wrap = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!layout || !wrap.current || lastFit.current === fit.n) return
    lastFit.current = fit.n
    const parentOf = new Map(view.nodes.map((n) => [n.id, n.parentId]))
    const abs = (id: string): Rect => {
      const r = layout[id]
      const p = parentOf.get(id)
      if (!p || !layout[p]) return r
      const pr = abs(p)
      return { ...r, x: pr.x + r.x, y: pr.y + r.y }
    }
    const targets = fit.nodeId && layout[fit.nodeId] ? [fit.nodeId] : view.nodes.filter((n) => !n.parentId && layout[n.id]).map((n) => n.id)
    if (!targets.length) return
    const rects = targets.map(abs)
    const x0 = Math.min(...rects.map((r) => r.x))
    const y0 = Math.min(...rects.map((r) => r.y))
    const x1 = Math.max(...rects.map((r) => r.x + r.w))
    const y1 = Math.max(...rects.map((r) => r.y + r.h))
    // Keep clear of the legend (top) and the prompt bar (bottom).
    const pad = { top: 80, bottom: 150, side: 40 }
    const W = wrap.current.clientWidth - pad.side * 2
    const H = wrap.current.clientHeight - pad.top - pad.bottom
    const zoom = Math.min(1.1, W / (x1 - x0), H / (y1 - y0))
    const x = pad.side + (W - (x1 - x0) * zoom) / 2 - x0 * zoom
    const y = pad.top + (H - (y1 - y0) * zoom) / 2 - y0 * zoom
    rf.setViewport({ x, y, zoom }, { duration: fit.n === 0 ? 0 : 400 })
  }, [layout, fit, rf, view])

  const nodes = useMemo(() => {
    if (!layout) return []
    return view.nodes
      .filter((n) => layout[n.id])
      .sort((a, b) => a.depth - b.depth) // parents before children
      .map((n) => {
        const r = layout[n.id]
        const data = {
          view: n,
          activeFile: sim.activeFile,
          inScope: scope.includes(n.id),
          facingColors: n.facing.map((a) => actorColor(model, a)),
          color: n.node.kind === 'actor' ? actorColor(model, n.id) : undefined,
          highlighted: highlight.some((h) => n.members.includes(h)),
          picked: picking ? picking.picked.includes(n.id) : undefined,
          runtime: aggregateRuntime(runtime, n.members),
          thumb: thumbs[n.id],
          heat: Math.max(0, ...n.members.map((m) => heat[m] ?? 0)),
          step: playback ? playback.stepOf(n.id) : -1,
          journey: playback ? (playback.current === n.id ? 'current' : playback.visited.has(n.id) ? 'visited' : playback.onPath.has(n.id) ? 'pending' : n.container ? undefined : 'off') : undefined,
          isNew: previewNew?.nodes.has(n.id) ?? false,
          acp: n.members.some((m) => acpBoxes.has(m))
        }
        const common = {
          id: n.id,
          position: { x: r.x, y: r.y },
          width: r.w,
          height: r.h,
          parentId: n.parentId,
          extent: n.parentId ? ('parent' as const) : undefined,
          selected: selection?.kind === 'node' && selection.id === n.id,
          data
        }
        return n.container
          ? ({ ...common, type: 'container', zIndex: n.depth - 10, selectable: true } as ContainerFlowNode)
          : ({ ...common, type: 'arch', zIndex: n.depth } as ArchFlowNode)
      })
  }, [view, layout, selection, scope, sim.activeFile, model, highlight, picking, runtime, thumbs, heat, playback, previewNew, acpBoxes])

  const edges = useMemo<FloatingFlowEdge[]>(
    () =>
      view.edges
        .filter((e) => layout?.[e.source] && layout?.[e.target])
        .map((e) => ({
          id: e.id,
          source: e.source,
          target: e.target,
          type: 'floating',
          data: {
            view: e,
            runtime: aggregateRuntime(runtime ? { ...runtime, boxes: runtime.edges } : null, e.members.map((m) => m.id)),
            planned: e.members.every((m) => m.planned),
            undeclared: e.members.some((m) => m.undeclared),
            isNew: e.members.some((m) => previewNew?.edges.has(m.id)),
            acp: e.members.some((m) => acpPairs.has(`${m.source}->${m.target}`)) || acpPairs.has(`${e.source}->${e.target}`),
            journey: playback ? (playback.currentEdge === e.id ? 'current' : playback.visitedEdges.has(e.id) ? 'visited' : 'off') : undefined,
            reverse: playback ? (playback.currentEdge === e.id ? playback.currentReverse : playback.visitedEdges.get(e.id)) : undefined
          },
          zIndex: 5,
          selected: selection?.kind === 'edge' && selection.id === e.id,
          markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16, color: e.violation ? cssVar('--warning') : edgeColor(e.state) }
        })),
    // theme: marker colours are concrete values read from the current palette
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [view, layout, selection, runtime, theme, previewNew, playback, acpPairs]
  )

  // A journey step between two boxes with no contract: draw the hop so the gap is visible.
  const allEdges = useMemo<FloatingFlowEdge[]>(() => {
    if (!playback?.hops.length || !layout) return edges
    const hopEdges: FloatingFlowEdge[] = playback.hops
      .filter((h) => layout[h.source] && layout[h.target])
      .map((h) => ({
        id: h.id,
        source: h.source,
        target: h.target,
        type: 'floating',
        zIndex: 6,
        data: {
          view: { id: h.id, source: h.source, target: h.target, members: [], state: 'idle', label: h.label ? `${h.label} (no contract)` : 'no contract', dimmed: false, violation: false, proposed: false },
          journey: h.current ? 'current' : 'visited',
          hop: true
        },
        markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16, color: cssVar('--intent') }
      }))
    return [...edges, ...hopEdges]
  }, [edges, playback, layout])

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      for (const c of changes) {
        if (c.type === 'position' && c.position) moveNode(zoom, c.id, c.position.x, c.position.y)
      }
    },
    [zoom, moveNode]
  )

  const onNodeClick: NodeMouseHandler = useCallback(
    (e, n) => select({ kind: 'node', id: n.id }, e.shiftKey || e.metaKey || e.ctrlKey),
    [select]
  )
  const onNodeDoubleClick: NodeMouseHandler = useCallback(
    (_e, n) => {
      const v = view.nodes.find((x) => x.id === n.id)
      if (v && v.hiddenChildren > 0 && zoom < 3) setZoom((zoom + 1) as 2 | 3, n.id)
    },
    [view, zoom, setZoom]
  )
  const onEdgeClick: EdgeMouseHandler = useCallback((_e, ed) => select({ kind: 'edge', id: ed.id }), [select])

  return (
    <div className={`canvas ${picking ? 'picking' : ''}`} ref={wrap}>
      <ReactFlow
        nodes={nodes}
        edges={allEdges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onNodeClick={onNodeClick}
        onNodeDoubleClick={onNodeDoubleClick}
        onEdgeClick={onEdgeClick}
        onPaneClick={() => (useStore.getState().designTool === 'connect' ? useStore.setState({ connectFrom: null }) : select(null))}
        nodesConnectable={false}
        zoomOnDoubleClick={false}
        minZoom={0.2}
        maxZoom={2}
        colorMode={theme}
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1.2} color={cssVar('--dots')} />
        <Controls showInteractive={false} position="bottom-left" />
        <MiniMap pannable zoomable position="top-right" nodeColor={(n) => miniColor((n.data as { view: { state: string } }).view.state)} maskColor={cssVar('--minimap-mask')} />
      </ReactFlow>
      <Legend />
      <DesignToolbar />
      <ExplainBar />
      <div className="canvas-bottom">
        <HistoryBar />
        <PromptBar />
      </div>
    </div>
  )
}

function aggregateRuntime(rt: { boxes: Record<string, { count: number; errors: number; avgMs: number }> } | null, ids: string[]): { count: number; errors: number; avgMs: number } | undefined {
  if (!rt) return undefined
  let count = 0
  let errors = 0
  let ms = 0
  for (const id of ids) {
    const s = rt.boxes[id]
    if (!s) continue
    count += s.count
    errors += s.errors
    ms += s.avgMs * s.count
  }
  return count ? { count, errors, avgMs: ms / count } : undefined
}

function edgeColor(state: string): string {
  return cssVar(state === 'active' ? '--active' : state === 'changed' ? '--changed' : state === 'ghost' ? '--ghost' : '--edge-idle-marker')
}

function miniColor(state: string): string {
  const m: Record<string, string> = {
    active: '--active',
    intent: '--intent',
    ghost: '--ghost',
    changed: '--changed',
    warning: '--warning',
    failing: '--warning',
    candidate: '--candidate'
  }
  return cssVar(m[state] ?? '--minimap-node')
}

function Legend() {
  const items: [string, string][] = [
    ['intent', 'about to change'],
    ['active', 'editing now'],
    ['changed', 'changed'],
    ['ghost', 'planned'],
    ['candidate', 'new box candidate'],
    ['warning', 'outside fence / failing']
  ]
  return (
    <div className="legend">
      {items.map(([k, l]) => (
        <span key={k} className="legend-item">
          <i className={`swatch sw-${k}`} />
          {l}
        </span>
      ))}
    </div>
  )
}
