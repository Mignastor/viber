import type { ArchEdge, ArchModel, ArchNode } from './model'

// Is the design complete enough to build? People, components, the contracts between them and the
// journeys that use them. Checked before Build and shown in the Design tab.

export interface CheckItem {
  id: string
  ok: boolean
  title: string
  /** What is missing, in words (shown under a failing item). */
  detail?: string
  /** Node ids to highlight. */
  ids?: string[]
}

const isBox = (n: ArchNode): boolean => n.kind === 'box' && !n.proposed
const isActor = (n: ArchNode): boolean => n.kind === 'actor' && !n.proposed

/** The edge between two nodes in either direction (a reply travels against the arrow). */
export function edgeBetween(m: ArchModel, a: string, b: string): ArchEdge | undefined {
  return m.edges.find((e) => (e.source === a && e.target === b) || (e.source === b && e.target === a))
}

export function designCheck(m: ArchModel): CheckItem[] {
  const label = (id: string): string => m.nodes.find((n) => n.id === id)?.label ?? id
  const boxes = m.nodes.filter(isBox)
  const actors = m.nodes.filter(isActor)
  // Containers (boxes with sub-boxes) are judged through their children.
  const leaves = boxes.filter((b) => !boxes.some((c) => c.parent === b.id))
  const within = (id: string, root: string): boolean => {
    for (let cur: string | undefined = id; cur; cur = m.nodes.find((n) => n.id === cur)?.parent) if (cur === root) return true
    return false
  }
  const touches = (b: ArchNode): boolean => m.edges.some((e) => within(e.source, b.id) || within(e.target, b.id))
  const items: CheckItem[] = []

  items.push({ id: 'actors', ok: actors.length > 0, title: 'Who uses it: at least one actor', detail: actors.length ? undefined : 'No actors yet: say who uses the system (players, an admin, another system, a schedule).' })

  const lonelyActors = actors.filter((a) => !m.edges.some((e) => e.source === a.id && e.kind === 'uses'))
  items.push({ id: 'actors-reach', ok: actors.length > 0 && !lonelyActors.length, title: 'Every actor reaches a component', detail: lonelyActors.length ? `${lonelyActors.map((a) => a.label).join(', ')} ${lonelyActors.length > 1 ? "don't" : "doesn't"} use any component yet.` : undefined, ids: lonelyActors.map((a) => a.id) })

  const isolated = leaves.filter((b) => !touches(b))
  items.push({ id: 'connected', ok: boxes.length > 0 && !isolated.length, title: 'Every component is connected', detail: !boxes.length ? 'No components yet.' : isolated.length ? `Isolated: ${isolated.map((b) => b.label).join(', ')}. A component nobody talks to can't take part in anything.` : undefined, ids: isolated.map((b) => b.id) })

  const between = m.edges.filter((e) => e.kind !== 'uses' && boxes.some((b) => b.id === e.source) && boxes.some((b) => b.id === e.target))
  const unnamed = between.filter((e) => !e.contract.length || e.contract.every((c) => !c.trim() || c === 'imports'))
  items.push({ id: 'contracts', ok: between.length > 0 && !unnamed.length, title: 'Every connection names its contract', detail: !between.length ? 'No connections between components yet.' : unnamed.length ? `No contract on: ${unnamed.map((e) => `${label(e.source)} → ${label(e.target)}`).join(', ')}. Say what crosses it (an endpoint, an event, a function).` : undefined, ids: unnamed.flatMap((e) => [e.source, e.target]) })

  const planned = leaves.filter((b) => b.spec?.status === 'planned' || !b.files.length)
  const vague = planned.filter((b) => !b.spec?.responsibility?.trim())
  items.push({ id: 'responsibility', ok: !vague.length, title: 'Every component says what it is responsible for', detail: vague.length ? `No responsibility: ${vague.map((b) => b.label).join(', ')}.` : undefined, ids: vague.map((b) => b.id) })

  const journeys = m.journeys ?? []
  const noJourney = actors.filter((a) => !journeys.some((j) => j.actor === a.id))
  items.push({ id: 'journeys', ok: actors.length > 0 && !noJourney.length, title: 'Every actor has a journey', detail: noJourney.length ? `No journey for ${noJourney.map((a) => a.label).join(', ')}: describe what they do, step by step.` : undefined, ids: noJourney.map((a) => a.id) })

  const gaps: string[] = []
  for (const j of journeys) {
    const path = [j.actor, ...j.steps.map((s) => s.box)]
    for (let i = 1; i < path.length; i++) if (path[i] !== path[i - 1] && !edgeBetween(m, path[i - 1], path[i])) gaps.push(`${j.name}: ${label(path[i - 1])} → ${label(path[i])}`)
  }
  items.push({ id: 'journeys-play', ok: journeys.length > 0 && !gaps.length, title: 'Every journey step crosses a contract', detail: !journeys.length ? 'No journeys yet.' : gaps.length ? `Missing contracts: ${gaps.slice(0, 6).join('; ')}.` : undefined })

  return items
}

/** The failing items as a request to the architect. */
export function gapsAsRequest(items: CheckItem[]): string {
  const bad = items.filter((i) => !i.ok)
  return `Complete the design so it can be built. Fix these gaps:\n${bad.map((i) => `- ${i.title}: ${i.detail ?? ''}`).join('\n')}\nKeep what is already there; add actors, contracts (with their items) and journeys as needed.`
}
