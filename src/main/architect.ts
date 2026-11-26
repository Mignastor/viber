import { designProvider } from './agentStatus'
import { cliComplete } from './cliAgents'
import { TECH_GUIDE } from '@shared/techAdvice'
import type { DefsOp } from '@shared/api'
import { ctx } from './context'
import { complete } from './llm'
import { overviewText, specText } from './contextPack'

// The architect: design the system by talking. The model answers with a short reply and a
// "diagram diff" — operations on .arch/model.yaml that the UI previews as ghosts and the human
// accepts or rejects. Nothing is written until the human accepts.

export interface ArchitectTurn {
  role: 'user' | 'assistant'
  text: string
}

const ALLOWED = new Set(['addBox', 'setTech', 'setSpec', 'upsertEdge', 'removeEdge', 'upsertActor', 'upsertJourney', 'removeJourney', 'rename', 'setPurpose', 'remove', 'setRules', 'upsertGuardrail'])

const FORMAT = `Reply in two parts:
1. A short answer for the human (what you propose and why, or a question if their intent is unclear). Plain prose, max ~120 words.
2. A JSON block with the diagram changes, exactly:
\`\`\`json
{ "ops": [ ... ] }
\`\`\`
Operations (use only these):
- {"op":"addBox","id":"backend/billing","label":"Billing","parent":"backend","paths":[],"tech":"FastAPI","spec":{"responsibility":"...","outOfScope":["..."],"contract":[{"kind":"http","name":"POST /api/invoices","input":"{orderId}","output":"{invoiceId}"}],"acceptance":["..."],"status":"planned","autonomy":"ask"}}
- {"op":"setSpec","id":"<box id>","spec":{ any spec fields to change }}
- {"op":"setTech","id":"<box id>","tech":"Rust"}
- {"op":"upsertEdge","edge":{"id":"<from>-><to>","from":"<box id>","to":"<box id>","kind":"http|call|event|sql|external","uses":["POST /api/invoices"]}}
- {"op":"upsertActor","actor":{"id":"actor:<slug>","label":"...","type":"user|admin|client|cli|cron|webhook|system","description":"...","reaches":["<box id>"]}}
- {"op":"upsertJourney","journey":{"id":"<slug>","actor":"actor:<slug>","name":"...","steps":[{"box":"<box id>","action":"..."}]}}
- {"op":"rename","id":"...","label":"..."} · {"op":"remove","id":"..."} · {"op":"setRules","id":"...","rules":["..."]}
- {"op":"upsertGuardrail","guardrail":{"id":"<from>!-><to>","from":"<box id>","to":"<box id>","reason":"..."}}
Rules: boxes are components with ONE responsibility that talk to others ONLY through their contract. A complete design has: actors (who uses the system, each reaching the boxes they use via "reaches"), every box connected by upsertEdge whose "uses" names the contract items that cross it, and at least one journey per actor that only steps between connected boxes. When designing a new system, deliver all of that in one proposal; if the request is too vague for that, ask 1-3 short questions first instead of guessing. Prefer few, well-separated boxes. Reuse existing ids. New boxes are "planned". Every box you add needs a responsibility, a contract and acceptance criteria, and a "tech" (language/framework): what the human named or the code already uses, otherwise follow this guide. ${TECH_GUIDE} Return {"ops":[]} when only answering a question.`

export function designText(): string {
  const ws = ctx.requireWs()
  const m = ws.built?.model
  if (!m) return ''
  const specs = m.nodes
    .filter((n) => n.kind === 'box' && n.spec)
    .map((n) => `### ${n.label} (${n.id})\n${specText(n)}`)
    .join('\n\n')
  const edges = (ws.defs.edges ?? []).map((e) => `- ${e.from} → ${e.to} [${e.kind}] ${e.uses.join(', ')}`).join('\n')
  const journeys = (ws.defs.journeys ?? []).map((j) => `- ${j.id}: ${j.actor} — ${j.name}: ${j.steps.map((s) => s.box).join(' → ')}`).join('\n')
  return [overviewText(m, 3), specs && `## Specs\n${specs}`, edges && `## Designed dependencies\n${edges}`, journeys && `## Journeys\n${journeys}`].filter(Boolean).join('\n\n')
}

export function parseOps(text: string): DefsOp[] {
  const block = text.match(/```json\s*([\s\S]*?)```/)?.[1] ?? text.match(/\{[\s\S]*"ops"[\s\S]*\}/)?.[0]
  if (!block) return []
  try {
    const j = JSON.parse(block)
    return (Array.isArray(j.ops) ? j.ops : []).filter((o: { op?: string }) => o && typeof o.op === 'string' && ALLOWED.has(o.op))
  } catch {
    return []
  }
}

export async function architect(history: ArchitectTurn[]): Promise<{ reply: string; ops: DefsOp[] }> {
  const system = [
    'You are the architecture partner in Viber, an IDE where humans own the direction (actors, components, contracts) and agents write the code.',
    'You help the human design or evolve the system as a diagram of boxes (components), edges (contracts between them), actors (who uses the system) and journeys (actor paths through boxes).',
    FORMAT,
    '## Current system',
    designText()
  ].join('\n\n')
  const transcript = history.map((t) => `${t.role === 'user' ? 'Human' : 'You'}: ${t.text}`).join('\n\n')
  const text = await designComplete(system, transcript)
  const reply = text.replace(/```json[\s\S]*?```/g, '').trim()
  return { reply, ops: parseOps(text) }
}

const PROVIDER_NAME: Record<string, string> = { 'claude-code': 'Claude Code', codex: 'Codex', gemini: 'Gemini', anthropic: 'Claude API', openai: 'OpenAI-compatible model', ollama: 'local model' }

/**
 * A design question answered by the configured design provider (a signed-in CLI or an API). Progress is
 * sent to the window as 'design:progress' so people see the answer being written.
 */
export async function designComplete(system: string, user: string, task: 'architect' | 'dry-run' = 'architect'): Promise<string> {
  const via = await designProvider()
  const started = Date.now()
  let written = ''
  let note = ''
  let last = 0
  const emit = (force = false): void => {
    if (!force && Date.now() - last < 250) return
    last = Date.now()
    const ops = [...written.matchAll(/"op"\s*:\s*"(\w+)"/g)].map((m) => m[1])
    const count = (op: string): number => ops.filter((o) => o === op).length
    ctx.emit('design:progress', {
      task,
      via: PROVIDER_NAME[via] ?? via,
      startedAt: started,
      prose: written.split('```')[0].slice(-600),
      writingDiagram: written.includes('```'),
      counts: { boxes: count('addBox'), contracts: count('upsertEdge'), actors: count('upsertActor'), journeys: count('upsertJourney'), steps: (written.match(/"box"\s*:/g) ?? []).length },
      chars: written.length,
      note
    })
  }
  const onProgress = (p: { text?: string; note?: string }): void => {
    if (p.text) written += p.text
    if (p.note) note = p.note
    emit()
  }
  emit(true)
  try {
    return via === 'claude-code' || via === 'codex' || via === 'gemini'
      ? await cliComplete(via, system, user, ctx.requireWs().root, onProgress)
      : (await complete('edit', system, user, via, (d) => onProgress({ text: d }))).text
  } finally {
    ctx.emit('design:progress', null)
  }
}
