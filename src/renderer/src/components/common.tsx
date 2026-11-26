import { Box, Boxes, Clock, Cloud, Database, Terminal, User, Webhook } from 'lucide-react'
import type { ArchNode } from '@shared/model'
import type { VisualState } from '../graph/view'

export function KindIcon({ node, container, size = 15 }: { node: ArchNode; container?: boolean; size?: number }) {
  if (node.kind === 'actor') {
    if (node.actorType === 'cron') return <Clock size={size} />
    if (node.actorType === 'cli') return <Terminal size={size} />
    if (node.actorType === 'webhook') return <Webhook size={size} />
    return <User size={size} />
  }
  if (node.kind === 'external') return <Cloud size={size} />
  if (node.kind === 'datastore') return <Database size={size} />
  return container ? <Boxes size={size} /> : <Box size={size} />
}

export const fmtK = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))

export const basename = (p: string): string => p.slice(p.lastIndexOf('/') + 1)

export const STATE_LABEL: Record<VisualState, string> = {
  idle: '',
  warning: 'outside fence',
  active: 'editing',
  failing: 'tests failing',
  intent: 'about to change',
  candidate: 'new box?',
  ghost: 'planned',
  changed: 'changed'
}

export function Delta({ added, removed }: { added: number; removed: number }) {
  if (!added && !removed) return null
  return (
    <span className="delta">
      {added > 0 && <span className="add">+{added}</span>}
      {removed > 0 && <span className="del">−{removed}</span>}
    </span>
  )
}
