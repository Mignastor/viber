import { memo } from 'react'
import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  Position,
  useInternalNode,
  type Edge,
  type EdgeProps,
  type InternalNode
} from '@xyflow/react'
import type { EdgeView } from '../graph/view'
import { useStore } from '../store'

export type FloatingEdgeData = {
  view: EdgeView
  runtime?: { count: number; errors: number; avgMs: number }
  planned?: boolean
  undeclared?: boolean
  isNew?: boolean
  /** Journey / Explain playback role, and whether the step travels against the arrow. */
  journey?: 'current' | 'visited' | 'off'
  reverse?: boolean
  /** A journey step with no contract behind it. */
  hop?: boolean
  /** A contract change on this edge awaits the human. */
  acp?: boolean
}
export type FloatingFlowEdge = Edge<FloatingEdgeData, 'floating'>

// Border-to-border edges: each end attaches where the line between the two node centres
// crosses the node's rectangle. Reads better than fixed handles on an architecture map.

function center(n: InternalNode) {
  const w = n.measured.width ?? 0
  const h = n.measured.height ?? 0
  return { x: n.internals.positionAbsolute.x + w / 2, y: n.internals.positionAbsolute.y + h / 2, w, h }
}

function intersection(node: InternalNode, other: InternalNode) {
  const a = center(node)
  const b = center(other)
  const w = a.w / 2
  const h = a.h / 2
  const xx1 = (b.x - a.x) / (2 * w) - (b.y - a.y) / (2 * h)
  const yy1 = (b.x - a.x) / (2 * w) + (b.y - a.y) / (2 * h)
  const k = 1 / (Math.abs(xx1) + Math.abs(yy1) || 1)
  const xx3 = k * xx1
  const yy3 = k * yy1
  return { x: w * (xx3 + yy3) + a.x, y: h * (-xx3 + yy3) + a.y }
}

function side(node: InternalNode, p: { x: number; y: number }): Position {
  const { x, y } = node.internals.positionAbsolute
  const w = node.measured.width ?? 0
  const h = node.measured.height ?? 0
  if (p.x <= x + 1) return Position.Left
  if (p.x >= x + w - 1) return Position.Right
  if (p.y <= y + 1) return Position.Top
  if (p.y >= y + h - 1) return Position.Bottom
  return Position.Top
}

export const FloatingEdge = memo(function FloatingEdge({ id, source, target, data, selected, markerEnd }: EdgeProps<FloatingFlowEdge>) {
  const select = useStore((st) => st.select)
  const s = useInternalNode(source)
  const t = useInternalNode(target)
  if (!s || !t || !data) return null

  const sp = intersection(s, t)
  const tp = intersection(t, s)
  const [path, lx, ly] = getBezierPath({
    sourceX: sp.x,
    sourceY: sp.y,
    sourcePosition: side(s, sp),
    targetX: tp.x,
    targetY: tp.y,
    targetPosition: side(t, tp)
  })
  const v = data.view
  const cls = `arch-edge edge-${v.state} ${v.dimmed ? 'dimmed' : ''} ${selected ? 'selected' : ''} ${v.violation ? 'violation' : ''} ${v.proposed ? 'proposed' : ''} ${data.planned ? 'planned' : ''} ${data.undeclared ? 'undeclared' : ''} ${data.isNew ? 'is-new' : ''} ${data.journey ? `journey-${data.journey}` : ''} ${data.hop ? 'hop' : ''} ${data.acp ? 'acp' : ''}`

  return (
    <>
      <BaseEdge id={id} path={path} className={cls} markerEnd={markerEnd} interactionWidth={18} />
      {data.journey === 'current' ? (
        // The step being played: a pulse travelling the way the journey goes.
        <circle r={5} className="edge-pulse journey-pulse">
          <animateMotion dur="1.2s" repeatCount="indefinite" path={path} keyPoints={data.reverse ? '1;0' : '0;1'} keyTimes="0;1" calcMode="linear" />
        </circle>
      ) : (
        (v.state === 'active' || data.runtime) && (
          <circle r={4} className="edge-pulse">
            <animateMotion dur="1.1s" repeatCount="indefinite" path={path} />
          </circle>
        )
      )}
      <EdgeLabelRenderer>
        <div
          className={`edge-label nodrag nopan edge-label-${v.state} ${v.dimmed ? 'dimmed' : ''} ${selected ? 'selected' : ''} ${v.violation ? 'violation' : ''} ${data.journey ? `journey-${data.journey}` : ''} ${data.hop ? 'hop' : ''}`}
          style={{ transform: `translate(-50%, -50%) translate(${lx}px, ${ly}px)` }}
          onClick={() => select({ kind: 'edge', id })}
        >
          {v.violation ? '⚠ ' : data.undeclared ? '≠ ' : data.planned ? '◇ ' : ''}
          {v.label}
          {data.runtime ? <span className={`rt-edge ${data.runtime.errors ? 'bad' : ''}`}> ⚡{data.runtime.count}</span> : null}
        </div>
      </EdgeLabelRenderer>
    </>
  )
})
