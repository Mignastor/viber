import { memo } from 'react'
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react'
import { Check, Code, FlaskConical, Layers, Plus, X } from 'lucide-react'
import type { NodeView } from '../graph/view'
import { basename, Delta, KindIcon, STATE_LABEL } from './common'
import { useStore } from '../store'

export type ArchNodeData = {
  view: NodeView
  activeFile: string | null
  inScope: boolean
  /** Colours of the actors this node is front-facing to. */
  facingColors: string[]
  /** Actor nodes: their colour. */
  color?: string
  highlighted: boolean
  /** While picking boxes for a dialog: whether this one is picked. */
  picked?: boolean
  runtime?: { count: number; errors: number; avgMs: number }
  thumb?: string
  /** History mode: share of commits in the window touching this node (0..1). */
  heat: number
  /** Explain mode: position in the walk, or -1. */
  step: number
  /** Added by the diagram diff being previewed. */
  isNew?: boolean
  /** Journey / Explain playback role. */
  journey?: 'current' | 'visited' | 'pending' | 'off'
  /** A contract change on this box awaits the human. */
  acp?: boolean
}

export type ArchFlowNode = Node<ArchNodeData, 'arch'>
export type ContainerFlowNode = Node<ArchNodeData, 'container'>

// Edges are drawn border-to-border (floating), so handles only need to exist, centred and invisible.
const hidden = { opacity: 0, left: '50%', top: '50%', pointerEvents: 'none' as const }

function Handles() {
  return (
    <>
      <Handle type="target" position={Position.Left} style={hidden} isConnectable={false} />
      <Handle type="source" position={Position.Right} style={hidden} isConnectable={false} />
    </>
  )
}

export const ArchNodeCard = memo(function ArchNodeCard({ data, selected }: NodeProps<ArchFlowNode>) {
  const { view, activeFile, inScope, facingColors, color, highlighted, picked, runtime, thumb, heat, step, isNew, journey, acp } = data
  const n = view.node
  const status = n.kind === 'box' ? n.spec?.status : undefined
  const openCode = useStore((s) => s.openCode)
  const tag = view.state === 'active' && activeFile ? `editing ${basename(activeFile)}` : STATE_LABEL[view.state]
  const cls = [
    'arch-node',
    `kind-${n.kind}`,
    `state-${view.state}`,
    view.dimmed && 'dimmed',
    selected && 'selected',
    inScope && 'in-scope',
    view.review && `review-${view.review}`,
    view.proposed && 'proposed',
    view.focus && `focus-${view.focus}`,
    highlighted && 'highlighted',
    picked === true && 'picked',
    picked === false && 'pickable',
    heat > 0 && 'heated',
    isNew && 'is-new',
    status === 'planned' && 'planned-box',
    journey && `journey-${journey}`,
    acp && 'acp-pending'
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div className={cls} style={{ ...(color ? { '--actor': color } : {}), ...(heat > 0 ? { '--heat': heat.toFixed(2) } : {}) } as React.CSSProperties}>
      <Handles />
      {thumb && <img className="node-thumb" src={thumb} alt="" />}
      {step >= 0 && <span className="step-badge">{step + 1}</span>}
      {facingColors.length > 0 && (
        <div className="facing-dots" title="Front-facing to these actors">
          {facingColors.slice(0, 5).map((c, i) => (
            <i key={i} style={{ background: c }} />
          ))}
        </div>
      )}
      <div className="node-head">
        <span className="node-icon">
          <KindIcon node={n} />
        </span>
        <span className="node-label">{n.label}</span>
        {view.review === 'approved' && <Check size={14} className="review-mark ok" />}
        {view.review === 'rejected' && <X size={14} className="review-mark bad" />}
        {n.files.length > 0 && n.kind !== 'actor' && (
          <button
            className="code-btn nodrag"
            title="Show code"
            onClick={(e) => {
              e.stopPropagation()
              openCode(n.id)
            }}
          >
            <Code size={13} />
          </button>
        )}
      </div>
      <div className="node-sub">{n.tech ?? n.purpose}</div>
      <div className="node-foot">
        {tag && <span className={`state-tag tag-${view.state}`}>{tag}</span>}
        {acp && <span className="state-tag tag-acp">contract change</span>}
        {!tag && isNew && <span className="state-tag tag-new">new</span>}
        {!tag && !isNew && status && <span className={`status-tag st-${status}`}>{status}</span>}
        {!tag && !status && view.proposed && <span className="state-tag tag-proposed">proposed</span>}
        {!tag && !status && !view.proposed && view.node.stats && view.node.kind === 'box' && (
          <span className="node-stat">
            {view.node.stats.files} file{view.node.stats.files === 1 ? '' : 's'}
            {view.node.routes?.length ? ` · ${view.node.routes.length} routes` : ''}
          </span>
        )}
        <Delta added={view.added} removed={view.removed} />
        {runtime && (
          <span className={`rt-badge ${runtime.errors ? 'bad' : ''}`} title={`${runtime.count} requests, ${runtime.errors} errors, avg ${runtime.avgMs.toFixed(0)} ms`}>
            ⚡{runtime.count}
            {runtime.avgMs ? ` · ${runtime.avgMs.toFixed(0)}ms` : ''}
            {runtime.errors ? ` · ${runtime.errors}✗` : ''}
          </span>
        )}
        {view.tests && (
          <span className={`tests ${view.tests.failed ? 'bad' : 'ok'}`}>
            <FlaskConical size={11} />
            {view.tests.failed ? `${view.tests.failed} failing` : view.tests.passed}
          </span>
        )}
        {view.plannedInside > 0 && (
          <span className="planned-inside">
            <Plus size={11} />
            {view.plannedInside} planned
          </span>
        )}
        {view.hiddenChildren > 0 && (
          <span className="hidden-children" title="Double-click to zoom in">
            <Layers size={11} />
            {view.hiddenChildren}
          </span>
        )}
      </div>
    </div>
  )
})

export const ContainerNode = memo(function ContainerNode({ data, selected }: NodeProps<ContainerFlowNode>) {
  const { view, inScope, highlighted, picked, isNew } = data
  const n = view.node
  const cls = ['container-node', selected && 'selected', inScope && 'in-scope', view.dimmed && 'dimmed', view.proposed && 'proposed', view.focus && `focus-${view.focus}`, highlighted && 'highlighted', picked && 'picked', isNew && 'is-new']
    .filter(Boolean)
    .join(' ')
  return (
    <div className={cls}>
      <Handles />
      <div className="container-head">
        <KindIcon node={n} container size={14} />
        <span className="container-label">{n.label}</span>
        {n.tech && <span className="container-tech">{n.tech}</span>}
      </div>
    </div>
  )
})
