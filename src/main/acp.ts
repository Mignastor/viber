import { promises as fs } from 'fs'
import path from 'path'
import type { Acp, ContractItem } from '@shared/model'
import type { AgentKind } from '@shared/api'
import { ctx } from './context'
import { archDir } from './engine/store'
import { subtreeRoutes } from './engine/build'

// Architectural Change Proposals: contracts belong to the human. When an agent cannot do its job
// without changing a box's contract, it proposes the change and waits. On approval the contract
// (and the designed edge) are updated and every consumer of that contract gets a follow-up task.

const file = (root: string): string => path.join(archDir(root), 'acps.json')
const waiters = new Map<string, (d: { approved: boolean; feedback?: string }) => void>()

export async function listAcps(): Promise<Acp[]> {
  const ws = ctx.ws
  if (!ws) return []
  try {
    return JSON.parse(await fs.readFile(file(ws.root), 'utf8'))
  } catch {
    return []
  }
}

async function save(list: Acp[]): Promise<void> {
  const ws = ctx.requireWs()
  await fs.mkdir(archDir(ws.root), { recursive: true })
  await fs.writeFile(file(ws.root), JSON.stringify(list, null, 1))
  ctx.emit('acp:list', list)
}

/** Parse "POST /api/x", "event: order.paid", "fn(a, b)" into a contract item. */
export function toItem(s: string): ContractItem {
  const t = s.trim()
  if (/^(GET|POST|PUT|PATCH|DELETE)\s+\//i.test(t)) return { kind: 'http', name: t.replace(/^(\w+)/, (m) => m.toUpperCase()) }
  const m = t.match(/^(event|queue|data|function)\s*:\s*(.+)$/i)
  if (m) return { kind: m[1].toLowerCase() as ContractItem['kind'], name: m[2].trim() }
  return { kind: /\(/.test(t) ? 'function' : 'data', name: t }
}

/** Consumers of a box: boxes whose (designed or actual) edges point at it. */
function consumersOf(box: string): string[] {
  const m = ctx.ws?.built?.model
  if (!m) return []
  return [...new Set(m.edges.filter((e) => e.target === box && e.kind !== 'uses' && m.nodes.find((n) => n.id === e.source)?.kind === 'box').map((e) => e.source))]
}

export async function proposeAcp(input: {
  box: string
  consumer?: string
  add: string[]
  remove: string[]
  reason: string
  sessionId?: string
  wait: boolean
}): Promise<{ acp: Acp; approved?: boolean; feedback?: string }> {
  const ws = ctx.requireWs()
  const current = ws.built?.model.nodes.find((n) => n.id === input.box)?.spec?.contract?.map((c) => c.name) ?? []
  const acp: Acp = {
    id: Math.random().toString(36).slice(2, 9),
    box: input.box,
    consumer: input.consumer,
    add: input.add.filter((a) => a.trim()),
    remove: input.remove.filter((r) => current.includes(r) || r.trim()),
    reason: input.reason,
    sessionId: input.sessionId,
    status: 'pending',
    consumers: consumersOf(input.box).filter((c) => c !== input.consumer),
    createdAt: Date.now()
  }
  const list = await listAcps()
  list.push(acp)
  await save(list)
  if (input.sessionId)
    ctx.sessions?.push(input.sessionId, {
      t: 'message',
      role: 'system',
      text: `Contract change proposed on ${input.box}: ${[...acp.add.map((a) => '+ ' + a), ...acp.remove.map((r) => '− ' + r)].join(', ')}. Waiting for your approval.`,
      tokens: 0,
      naive: 0
    })
  if (!input.wait) return { acp }
  if (input.sessionId) ctx.sessions?.setStatus(input.sessionId, 'waiting')
  const d = await new Promise<{ approved: boolean; feedback?: string } | undefined>((resolve) => {
    const t = setTimeout(() => {
      waiters.delete(acp.id)
      resolve(undefined)
    }, 20 * 60_000)
    waiters.set(acp.id, (x) => {
      clearTimeout(t)
      resolve(x)
    })
  })
  if (input.sessionId) ctx.sessions?.setStatus(input.sessionId, 'running')
  return { acp, approved: d?.approved, feedback: d?.feedback }
}

export async function decideAcp(id: string, approved: boolean, feedback?: string): Promise<void> {
  const ws = ctx.requireWs()
  const list = await listAcps()
  const acp = list.find((a) => a.id === id)
  if (!acp || acp.status !== 'pending') return
  acp.status = approved ? 'approved' : 'rejected'
  acp.feedback = feedback
  acp.decidedAt = Date.now()
  if (approved) {
    // Apply to the provider's contract, and to the designed edge from the requesting consumer.
    const def = ws.defs.boxes.find((b) => b.id === acp.box)
    const model = ws.built?.model
    // First declaration on an undesigned box: adopt today's reality as the design, so approving one
    // change does not turn every existing route or dependency into drift.
    const base: ContractItem[] = def?.spec?.contract?.length
      ? def.spec.contract
      : model
        ? subtreeRoutes(model.nodes, acp.box).filter((r) => !r.startsWith('PAGE ')).map((r) => ({ kind: 'http', name: r }))
        : []
    const contract = base.filter((c, i, a) => !acp.remove.includes(c.name) && a.findIndex((x) => x.name === c.name) === i)
    for (const a of acp.add) if (!contract.some((c) => c.name === toItem(a).name)) contract.push(toItem(a))
    const decisions = [...(def?.spec?.decisions ?? []), { date: new Date().toISOString().slice(0, 10), text: `Contract change approved: ${[...acp.add.map((a) => '+' + a), ...acp.remove.map((r) => '−' + r)].join(', ')}. ${acp.reason}` }]
    const ops: import('@shared/api').DefsOp[] = []
    if (def) ops.push({ op: 'setSpec', id: acp.box, spec: { contract, decisions } })
    if (acp.consumer) {
      const designedOut = (ws.defs.edges ?? []).some((e) => e.from === acp.consumer)
      if (!designedOut && model)
        for (const e of model.edges)
          if (e.source === acp.consumer && e.target !== acp.box && e.kind !== 'uses' && model.nodes.find((n) => n.id === e.target)?.kind !== 'actor')
            ops.push({ op: 'upsertEdge', edge: { id: `${e.source}->${e.target}`, from: e.source, to: e.target, kind: e.kind, uses: e.contract.slice(0, 8) } })
      const existing = (ws.defs.edges ?? []).find((e) => e.from === acp.consumer && e.to === acp.box)
      const uses = [...new Set([...(existing?.uses ?? []).filter((u) => !acp.remove.includes(u)), ...acp.add.map((a) => toItem(a).name)])]
      ops.push({ op: 'upsertEdge', edge: { id: existing?.id ?? `${acp.consumer}->${acp.box}`, from: acp.consumer, to: acp.box, kind: existing?.kind ?? (acp.add.some((a) => /^(GET|POST|PUT|PATCH|DELETE)\s/i.test(a)) ? 'http' : 'call'), uses } })
    }
    if (ops.length) await ws.apply({ op: 'batch', ops })
  }
  await save(list)
  waiters.get(id)?.({ approved, feedback })
  waiters.delete(id)
  if (acp.sessionId) ctx.sessions?.settleGate(acp.sessionId, `acp:${id}`, { approved, feedback })
  if (approved) await startFollowUps(acp, 'auto-only')
}

/** The task a consumer gets when a contract it depends on changed. */
export function followUpTask(acp: Acp, consumer: string): string {
  const label = (id: string): string => ctx.ws?.built?.model.nodes.find((n) => n.id === id)?.label ?? id
  return [
    `The contract of "${label(acp.box)}" (${acp.box}) changed. Update "${label(consumer)}" (${consumer}) so it uses the new contract correctly.`,
    acp.add.length ? `Added: ${acp.add.join('; ')}` : '',
    acp.remove.length ? `Removed: ${acp.remove.join('; ')}. Stop using these.` : '',
    `Why: ${acp.reason}`,
    'Use find_usages on the changed items to find every call site in this box. Stay inside this box.'
  ]
    .filter(Boolean)
    .join('\n')
}

/** Start follow-up sessions for consumers ("all"), or only for those whose autonomy is not "ask". */
export async function startFollowUps(acp: Acp, which: 'all' | 'auto-only', agent?: AgentKind): Promise<string[]> {
  const { startSession } = await import('./agents')
  const { getSettings } = await import('./settings')
  const ws = ctx.requireWs()
  const settings = await getSettings()
  const started: string[] = []
  for (const c of acp.consumers ?? []) {
    const autonomy = ws.built?.model.nodes.find((n) => n.id === c)?.spec?.autonomy ?? 'ask'
    if (which === 'auto-only' && autonomy === 'ask') continue
    const a = agent ?? (settings.agent === 'external' ? 'claude-code' : settings.agent)
    started.push(await startSession({ prompt: followUpTask(acp, c), scope: [c], agent: a, autoApprove: autonomy !== 'ask' }))
  }
  if (started.length) {
    const list = await listAcps()
    const x = list.find((y) => y.id === acp.id)
    if (x) x.followUps = [...(x.followUps ?? []), ...started]
    await save(list)
  }
  return started
}
