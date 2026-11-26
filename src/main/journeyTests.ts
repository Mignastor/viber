import { promises as fs } from 'fs'
import path from 'path'
import type { AgentKind } from '@shared/api'
import type { JourneyTestResult } from '@shared/model'
import { ctx } from './context'
import { commandAllowed, execTests, failureLines, testCommand } from './runner'
import { isJourneyTest, journeyBoxes, journeyTestPath, journeyTestTask } from './journeyPlan'

// Journeys drive tests for the real code. Once every box a journey passes through is built, an agent
// writes one end-to-end test that plays the journey through those boxes' contracts, step by step.
// Viber runs it during builds, after every agent session that touches one of its boxes, and on
// demand, so a journey that worked as a design keeps working as code.

// ── Results ───────────────────────────────────────────────────────────────────────────────

let results: Record<string, JourneyTestResult> = {}
let loadedFor: string | null = null

const resultsFile = (root: string): string => path.join(root, '.arch', 'cache', 'journey-tests.json')

async function load(): Promise<void> {
  const ws = ctx.ws
  if (!ws || loadedFor === ws.root) return
  loadedFor = ws.root
  try {
    results = JSON.parse(await fs.readFile(resultsFile(ws.root), 'utf8'))
    // A test being written when Viber closed is no longer being written.
    for (const [id, r] of Object.entries(results)) if (r.status === 'writing') delete results[id]
  } catch {
    results = {}
  }
}

async function save(): Promise<void> {
  const ws = ctx.ws
  if (!ws) return
  await fs.mkdir(path.dirname(resultsFile(ws.root)), { recursive: true }).catch(() => {})
  await fs.writeFile(resultsFile(ws.root), JSON.stringify(results, null, 1)).catch(() => {})
  ctx.emit('journeys:results', await journeyResults())
}

/** The last result of every journey, with "missing" for journeys that have no test file yet. */
export async function journeyResults(): Promise<Record<string, JourneyTestResult>> {
  await load()
  const ws = ctx.ws
  const out: Record<string, JourneyTestResult> = {}
  for (const j of ws?.built?.model.journeys ?? []) {
    const exists = j.test ? await fs.stat(path.join(ws!.root, j.test)).then(() => true, () => false) : false
    const r = results[j.id]
    if (r?.status === 'writing') out[j.id] = r
    else if (!exists) out[j.id] = { id: j.id, status: 'missing' }
    else if (r && r.file === j.test) out[j.id] = r
    else out[j.id] = { id: j.id, status: 'notrun', file: j.test }
  }
  return out
}

/**
 * Run the end-to-end tests of these journeys (all journeys with a test when ids is empty).
 * `gated`: only run commands allowed in Settings (automatic runs); a click runs them regardless.
 */
export async function runJourneyTests(ids?: string[], opts: { gated?: boolean; root?: string } = {}): Promise<Record<string, JourneyTestResult>> {
  await load()
  const ws = ctx.requireWs()
  const root = opts.root ?? ws.root
  const journeys = (ws.built?.model.journeys ?? []).filter((j) => (!ids?.length || ids.includes(j.id)) && j.test)
  const out: Record<string, JourneyTestResult> = {}
  for (const j of journeys) {
    const file = j.test!
    if (!(await fs.stat(path.join(root, file)).then(() => true, () => false))) {
      out[j.id] = { id: j.id, status: 'missing' }
      continue
    }
    const cmd = testCommand([file])
    if (!cmd) {
      out[j.id] = { id: j.id, status: 'blocked', file, failures: ['No test runner found for this file.'], at: Date.now() }
      continue
    }
    if (opts.gated && !(await commandAllowed(cmd.command))) {
      out[j.id] = { id: j.id, status: 'blocked', file, command: cmd.command, failures: [`Allow "${cmd.command.split(' ').slice(0, 2).join(' ')}" in Settings to run journey tests automatically.`], at: Date.now() }
      continue
    }
    const r = await execTests(cmd, root)
    out[j.id] = { id: j.id, status: r.code === 0 ? 'pass' : 'fail', file, command: cmd.command, failures: r.code === 0 ? [] : failureLines(r.out), at: Date.now() }
  }
  // Results describe the main repo; a worktree's results are reported to its session only.
  if (root === ws.root) {
    Object.assign(results, out)
    await save()
  }
  return out
}

/** After an agent session: replay the journeys through the boxes it touched. */
export async function runJourneyTestsAfterSession(sessionId: string): Promise<void> {
  const ws = ctx.ws
  const sm = ctx.sessions
  const s = sm?.get(sessionId)
  if (!ws?.built || !sm || !s) return
  const changed = s.events.flatMap((e) => (e.t === 'edit' ? [e.file] : []))
  const touched = new Set(changed.map((f) => ws.ownerOfFile(f)).filter(Boolean) as string[])
  const writtenTests = new Set(changed.filter((f) => isJourneyTest(f, ws.built!.model)))
  // A journey whose test is being written is run when that session ends, not here.
  const ids = (ws.built.model.journeys ?? []).filter((j) => j.test && results[j.id]?.status !== 'writing' && (journeyBoxes(j).some((b) => touched.has(b)) || writtenTests.has(j.test))).map((j) => j.id)
  if (!ids.length) return
  const r = await runJourneyTests(ids, { gated: true, root: s.root })
  const name = (id: string): string => ws.built?.model.journeys?.find((j) => j.id === id)?.name ?? id
  const lines = Object.values(r)
    .filter((x) => x.status !== 'missing')
    .map((x) => `${x.status === 'pass' ? '✓' : x.status === 'fail' ? '✗' : '·'} ${name(x.id)}${x.status === 'blocked' ? `: ${x.failures?.[0] ?? 'not run'}` : x.status === 'fail' && x.failures?.[0] ? `: ${x.failures[0]}` : ''}`)
  if (lines.length) sm.push(sessionId, { t: 'message', role: 'system', text: `Journey tests:\n${lines.join('\n')}`, tokens: 0, naive: 0 })
}

/**
 * Ask an agent to write a journey's end-to-end test. Records the file on the journey, waits for the
 * session to end, then runs the test. Resolves with the session id once it has started; `done`
 * settles when the test has run.
 */
export async function writeJourneyTest(id: string, agent: AgentKind, opts: { autoApprove?: boolean; gated?: boolean } = {}): Promise<{ sessionId: string; done: Promise<JourneyTestResult> }> {
  await load()
  const ws = ctx.requireWs()
  const model = ws.built?.model
  const j = model?.journeys?.find((x) => x.id === id)
  if (!model || !j) throw new Error('No such journey.')
  const file = journeyTestPath(model, j)
  if (!file) throw new Error(`Can't tell which language "${j.name}" is written in: build its boxes first.`)
  if (!j.test) await ws.apply({ op: 'upsertJourney', journey: { ...j, test: file } })
  const { startSession } = await import('./agents')
  const sessionId = await startSession({ prompt: journeyTestTask(model, { ...j, test: file }, file), scope: journeyBoxes(j), agent, autoApprove: opts.autoApprove })
  results[id] = { id, status: 'writing', file, at: Date.now() }
  await save()
  const done = (async (): Promise<JourneyTestResult> => {
    const sm = ctx.sessions!
    let s = sm.get(sessionId)
    while (s && !['done', 'error', 'stopped'].includes(s.info.status)) {
      await new Promise((r) => setTimeout(r, 1000))
      s = sm.get(sessionId)
    }
    delete results[id]
    try {
      return (await runJourneyTests([id], { gated: opts.gated }))[id] ?? { id, status: 'missing' as const }
    } catch {
      await save()
      return { id, status: 'missing' as const }
    }
  })()
  return { sessionId, done }
}
