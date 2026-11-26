import { recommendTech } from '@shared/techAdvice'
import type { AgentKind } from '@shared/api'
import type { ArchModel, ArchNode } from '@shared/model'
import { ctx } from './context'
import { startSession, stopSession } from './agents'
import { git, isRepo } from './git'
import { specText } from './contextPack'

// Build from the spec: every box that is planned (or chosen) becomes an agent task generated from
// its spec. Providers are built before their consumers; boxes in the same wave run in parallel in
// their own worktrees. A box is "built" when its session ends cleanly and "verified" when its tests
// pass.

export interface BuildBoxState {
  id: string
  label: string
  wave: number
  state: 'waiting' | 'running' | 'built' | 'verified' | 'failed' | 'review'
  sessionId?: string
  note?: string
}

export interface BuildState {
  running: boolean
  waves: string[][]
  boxes: Record<string, BuildBoxState>
}

let state: BuildState = { running: false, waves: [], boxes: {} }
let cancelled = false
const emit = (): void => ctx.emit('build:state', state)

/** Waves of boxes: each box comes after the boxes it depends on (designed or actual edges). */
export function buildOrder(model: ArchModel, ids: string[]): string[][] {
  const set = new Set(ids)
  const nodeIds = new Set(model.nodes.map((n) => n.id))
  const ancestorsIn = (id: string): string[] => {
    const out: string[] = []
    let cur = model.nodes.find((n) => n.id === id)
    while (cur) {
      if (set.has(cur.id)) out.push(cur.id)
      cur = cur.parent ? model.nodes.find((n) => n.id === cur!.parent) : undefined
    }
    return out
  }
  const deps = new Map<string, Set<string>>(ids.map((id) => [id, new Set()]))
  for (const e of model.edges) {
    if (!nodeIds.has(e.source) || !nodeIds.has(e.target) || e.kind === 'uses') continue
    for (const consumer of ancestorsIn(e.source)) for (const provider of ancestorsIn(e.target)) if (consumer !== provider) deps.get(consumer)!.add(provider)
  }
  const waves: string[][] = []
  const done = new Set<string>()
  while (done.size < ids.length) {
    const ready = ids.filter((id) => !done.has(id) && [...deps.get(id)!].every((d) => done.has(d)))
    // A cycle: build its members together rather than stall.
    const wave = ready.length ? ready : ids.filter((id) => !done.has(id))
    waves.push(wave)
    wave.forEach((id) => done.add(id))
  }
  return waves
}

/** The task an agent gets for one box, generated from the spec and its neighbours' contracts. */
export function boxTask(model: ArchModel, n: ArchNode): string {
  const label = (id: string): string => model.nodes.find((x) => x.id === id)?.label ?? id
  const provides = model.edges.filter((e) => e.target === n.id && e.kind !== 'uses')
  const uses = model.edges.filter((e) => e.source === n.id && e.kind !== 'uses')
  const actors = model.edges.filter((e) => e.target === n.id && e.kind === 'uses').map((e) => label(e.source))
  const journeys = (model.journeys ?? []).filter((j) => j.steps.some((s) => s.box === n.id))
  const providerSpecs = uses
    .map((e) => model.nodes.find((x) => x.id === e.target))
    .filter((x): x is ArchNode => !!x?.spec?.contract?.length)
    .map((x) => `${x.label}: ${x.spec!.contract!.map((c) => c.name).join(', ')}`)
  const where = n.paths?.length ? `Put the code under: ${n.paths.join(', ')}.` : `Create it in a new folder that fits the repo's structure, named after the box.`
  return [
    `Implement the "${n.label}" box (${n.id}) according to its spec. ${n.files.length ? 'It already has code: extend it rather than starting over.' : 'It does not exist yet.'}`,
    specText(n) || n.purpose,
    actors.length ? `Front-facing to: ${actors.join(', ')}.` : '',
    provides.length ? `Other boxes rely on it: ${provides.map((e) => `${label(e.source)} uses ${e.contract.join(', ') || e.kind}`).join('; ')}.` : '',
    uses.length ? `It may only depend on: ${uses.map((e) => `${label(e.target)} (${e.contract.join(', ') || e.kind})`).join('; ')}.` : 'It should not depend on other boxes.',
    providerSpecs.length ? `Their contracts: ${providerSpecs.join(' | ')}.` : '',
    journeys.length ? `Journeys through this box:\n${journeys.map((j) => `- ${label(j.actor)}: ${j.name} — ${j.steps.map((s) => `${label(s.box)} (${s.action})`).join(' → ')}`).join('\n')}` : '',
    where,
    'Write tests that check the acceptance criteria and the contract. Stay inside this box; if the spec is ambiguous, ask_human; record notable choices with record_decision.'
  ]
    .filter(Boolean)
    .join('\n\n')
}

const slugify = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'box'

/** Where a new box's code goes: under its parent's folder when it has one, else at the top level. */
export function folderFor(model: ArchModel, n: ArchNode): string {
  const parent = n.parent ? model.nodes.find((x) => x.id === n.parent) : undefined
  const base = parent?.paths?.find((p) => !/\.\w+$/.test(p))
  const leaf = slugify(n.id.split('/').pop() ?? n.label)
  const taken = new Set(model.nodes.flatMap((x) => (x.id === n.id ? [] : (x.paths ?? []))))
  // "backend/todo" with no "backend" box still means backend/todo/.
  let folder = base ? `${base}/${leaf}` : parent ? leaf : n.id.split('/').map(slugify).join('/')
  while (taken.has(folder)) folder += '-box'
  return folder
}

export function planBuild(ids?: string[]): string[][] {
  const m = ctx.requireWs().built?.model
  if (!m) return []
  const targets = ids?.length ? ids : m.nodes.filter((n) => n.kind === 'box' && (n.spec?.status === 'planned' || n.spec?.status === 'building')).map((n) => n.id)
  return buildOrder(m, targets)
}

export function getBuildState(): BuildState {
  return state
}

export function stopBuild(): void {
  cancelled = true
  for (const b of Object.values(state.boxes)) if (b.state === 'running' && b.sessionId) stopSession(b.sessionId)
}

export async function startBuild(opts: { ids?: string[]; agent: AgentKind; maxParallel?: number }): Promise<void> {
  const ws = ctx.requireWs()
  if (state.running) throw new Error('A build is already running.')
  const waves = planBuild(opts.ids)
  const model = ws.built!.model
  cancelled = false
  state = {
    running: true,
    waves,
    boxes: Object.fromEntries(waves.flatMap((w, i) => w.map((id) => [id, { id, label: model.nodes.find((n) => n.id === id)?.label ?? id, wave: i, state: 'waiting' as const }])))
  }
  emit()
  const canIsolate = await isRepo(ws.root)
  const maxParallel = Math.max(1, opts.maxParallel ?? 2)
  try {
    for (const wave of waves) {
      if (cancelled) break
      const parallel = canIsolate && wave.length > 1 && maxParallel > 1
      for (let i = 0; i < wave.length && !cancelled; i += parallel ? maxParallel : 1) {
        const batch = wave.slice(i, i + (parallel ? maxParallel : 1))
        await Promise.all(batch.map((id) => buildBox(id, opts.agent, parallel)))
        await ws.fullScan() // later waves see what earlier ones built
      }
    }
  } finally {
    state.running = false
    emit()
  }
}

async function buildBox(id: string, agent: AgentKind, isolate: boolean): Promise<void> {
  const ws = ctx.requireWs()
  const sm = ctx.sessions!
  const n = ws.built!.model.nodes.find((x) => x.id === id)
  const b = state.boxes[id]
  if (!n) {
    b.state = 'failed'
    b.note = 'box no longer exists'
    return emit()
  }
  const autonomy = n.spec?.autonomy ?? 'ask'
  // No tech chosen: use Viber's recommendation for the box's role, and record why.
  if (!n.tech && !n.files.length) {
    const advice = recommendTech(n, ws.built!.model)
    await ws.apply({ op: 'batch', ops: [{ op: 'setTech', id, tech: advice.tech }, { op: 'setSpec', id, spec: { decisions: [...(n.spec?.decisions ?? []), { date: new Date().toISOString().slice(0, 10), text: `Tech: ${advice.tech} (Viber's suggestion for a ${advice.role} box: ${advice.reason})` }] } }] })
  }
  // A new box gets its own folder up front, so whatever the agent writes there belongs to it.
  if (!n.files.length && !n.paths?.length) {
    const folder = folderFor(ws.built!.model, n)
    await ws.apply({ op: 'addPaths', id, paths: [folder] })
  }
  await ws.apply({ op: 'setSpec', id, spec: { status: 'building' } })
  const fresh = ws.built!.model.nodes.find((x) => x.id === id) ?? n
  const sessionId = await startSession({ prompt: boxTask(ws.built!.model, fresh), scope: [id], agent, isolate, autoApprove: autonomy !== 'ask' })
  b.state = 'running'
  b.sessionId = sessionId
  emit()
  let s = sm.get(sessionId)!
  while (!['done', 'error', 'stopped'].includes(s.info.status)) {
    await new Promise((r) => setTimeout(r, 1000))
    s = sm.get(sessionId)!
  }
  // Files the agent created outside any box still belong to this one.
  const stray = [...new Set(s.events.flatMap((e) => (e.t === 'edit' && !ws.ownerOfFile(e.file) ? [e.file.includes('/') ? e.file.split('/')[0] : e.file] : [])))]
  if (stray.length) await ws.apply({ op: 'addPaths', id, paths: stray })
  const tests = [...s.events].reverse().find((e) => e.t === 'tests')
  const passed = tests?.t === 'tests' && tests.failures.length === 0
  const edited = s.events.some((e) => e.t === 'edit')
  if (s.info.status !== 'done' || !edited) {
    b.state = 'failed'
    b.note = s.info.status === 'done' ? 'no changes were made' : s.info.status
    await ws.apply({ op: 'setSpec', id, spec: { status: n.files.length ? 'built' : 'planned' } })
    return emit()
  }
  // Isolated work lands only when the box may act alone and its tests pass; otherwise it waits
  // for review in its worktree.
  if (s.info.worktree) {
    if (autonomy === 'auto' && passed) {
      await git(s.root, ['add', '-A'])
      await git(s.root, ['commit', '-m', `viber: build ${n.label}`])
      const r = await git(ws.root, ['merge', '--no-ff', '-m', `Merge ${s.info.worktree.branch}: ${n.label}`, s.info.worktree.branch])
      b.note = r.code === 0 ? 'merged' : `merge failed: ${(r.stderr || r.stdout).trim().slice(0, 120)}`
    } else {
      b.state = 'review'
      b.note = `review and merge branch ${s.info.worktree.branch}`
    }
  }
  if (b.state !== 'review') b.state = passed ? 'verified' : 'built'
  await ws.apply({ op: 'setSpec', id, spec: { status: passed ? 'verified' : 'built' } })
  emit()
}
