import type { ArchModel } from '@shared/model'
import { edgeBetween } from '@shared/designCheck'
import { ctx } from './context'
import { designComplete, designText } from './architect'

// Dry run: play a journey (or a scenario in words) through the design before any code exists. The AI
// imagines what crosses each contract and what changes; Viber then checks every step against the real
// design, so a missing contract or component can't be glossed over.

export interface DryRunStep {
  box: string
  action: string
  /** The contract item the step uses to reach this box. */
  message?: string
  /** Example data crossing the contract. */
  payload?: string
  /** What changes: stored data, state, what someone sees. */
  effect?: string
  /** What the design is missing for this step. */
  problem?: string
}

export interface DryRun {
  name: string
  actor: string
  steps: DryRunStep[]
  gaps: string[]
}

const FORMAT = `Reply with only a JSON block:
\`\`\`json
{"name": "<short scenario name>", "actor": "<actor id>", "steps": [
  {"box": "<box id>", "action": "<what this component does at this step>",
   "message": "<the exact contract item used to reach it, from the design, or null>",
   "payload": "<example data that crosses it, short JSON>",
   "effect": "<what changes: stored data, game state, what someone sees>",
   "problem": "<what the design is missing or leaves unclear for this step, or null>"}
]}
\`\`\`
Rules: use only actor ids, box ids and contract items that exist in the design. Walk the scenario step by step through the components, including replies (a reply travels back over the same contract). If a step needs a component, contract or field the design does not have, keep going but say so in "problem". Be concrete: real names, real numbers.`

function parse(text: string): { name?: string; actor?: string; steps?: DryRunStep[] } | null {
  const raw = text.match(/```json\s*([\s\S]*?)```/)?.[1] ?? text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/** Check each step against the design: unknown components and missing contracts are problems. */
export function checkSteps(m: ArchModel, actor: string, steps: DryRunStep[]): { steps: DryRunStep[]; gaps: string[] } {
  const label = (id: string): string => m.nodes.find((n) => n.id === id)?.label ?? id
  const gaps: string[] = []
  let prev = actor
  const out = steps.map((st) => {
    const s = { ...st }
    // Models return example data as objects as often as strings: everything shown is text.
    for (const k of ['action', 'message', 'payload', 'effect', 'problem'] as const) {
      const v = s[k] as unknown
      if (v === null || v === undefined || v === 'null' || v === '') delete s[k]
      else if (typeof v !== 'string') s[k] = k === 'payload' ? JSON.stringify(v, null, 1) : JSON.stringify(v)
    }
    s.action ??= ''
    if (!m.nodes.some((n) => n.id === s.box)) {
      s.problem = `There is no component "${s.box}" in the design.${s.problem ? ` ${s.problem}` : ''}`
    } else if (prev !== s.box && !edgeBetween(m, prev, s.box)) {
      s.problem = `No contract between ${label(prev)} and ${label(s.box)}: nothing can carry this step.${s.problem ? ` ${s.problem}` : ''}`
    }
    if (s.problem) gaps.push(`${label(s.box)}: ${s.problem}`)
    if (m.nodes.some((n) => n.id === s.box)) prev = s.box
    return s
  })
  return { steps: out, gaps }
}

export async function dryRun(input: { journeyId?: string; scenario?: string }): Promise<DryRun> {
  const ws = ctx.requireWs()
  const m = ws.built?.model
  if (!m) throw new Error('Open a project first.')
  const j = input.journeyId ? (m.journeys ?? []).find((x) => x.id === input.journeyId) : undefined
  const ask = j
    ? `Dry-run this journey through the design:\nActor: ${j.actor}\nName: ${j.name}\n${j.steps.map((s, i) => `${i + 1}. ${s.box}: ${s.action}`).join('\n')}`
    : `Dry-run this scenario through the design (pick the actor and the components it goes through): ${input.scenario}`
  const system = ['You test software designs before any code exists by walking concrete scenarios through them.', FORMAT, '## The design', designText()].join('\n\n')
  const r = parse(await designComplete(system, ask, 'dry-run'))
  if (!r?.steps?.length) throw new Error('The dry run came back empty. Try again, or describe the scenario in more detail.')
  const actor = r.actor && m.nodes.some((n) => n.id === r.actor) ? r.actor : (j?.actor ?? m.nodes.find((n) => n.kind === 'actor')?.id ?? '')
  const checked = checkSteps(m, actor, r.steps.filter((s) => s && typeof s.box === 'string'))
  return { name: r.name ?? j?.name ?? 'Scenario', actor, ...checked }
}
