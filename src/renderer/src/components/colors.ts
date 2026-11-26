import type { ArchModel } from '@shared/model'

// One stable colour per actor, so "who faces this box" reads at a glance on the map.
const ACTOR_COLORS = ['#7c9cff', '#f472b6', '#4ade80', '#fb923c', '#38bdf8', '#c084fc', '#facc15', '#2dd4bf']

export function actorColor(model: ArchModel, actorId: string): string {
  const actors = model.nodes.filter((n) => n.kind === 'actor')
  const i = actors.findIndex((a) => a.id === actorId)
  return ACTOR_COLORS[(i < 0 ? 0 : i) % ACTOR_COLORS.length]
}
