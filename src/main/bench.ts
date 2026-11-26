import { app } from 'electron'
import { exec, execFile } from 'child_process'
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import type { AgentKind } from '@shared/api'
import { ctx } from './context'
import { openWorkspace } from './workspaceIpc'
import { startSession, stopSession } from './agents'
import { getSettings, setSettings, type Settings } from './settings'

// Token benchmark: the same tasks, run by the same agent, with and without Viber.
//   VIBER_BENCH=bench/example.json npx electron .      (after `npm run build`)
// Every run gets a fresh local clone of the repo, so neither the repo nor other runs are touched.

export interface BenchTask {
  id: string
  prompt: string
  /** Boxes to scope the Viber run to (the baseline gets no scope). */
  scope?: string[]
  /** Shell command run in the clone afterwards; exit code 0 = success. */
  check?: string
  expect?: { contains?: { file: string; text: string }[]; absent?: { file: string; text: string }[] }
}

export interface BenchSpec {
  name: string
  repo: string
  agents: AgentKind[]
  variants?: ('baseline' | 'viber')[]
  repeat?: number
  timeoutMin?: number
  model?: string
  /** Settings to use for the run (restored afterwards), e.g. roles or the Ollama model. */
  settings?: Partial<Settings>
  tasks: BenchTask[]
}

export interface BenchRun {
  task: string
  agent: AgentKind
  variant: 'baseline' | 'viber'
  rep: number
  ok: boolean
  checks: { name: string; ok: boolean; detail?: string }[]
  tokens: { input: number; output: number; cacheRead: number; total: number; costUsd?: number }
  turns: number
  toolCalls: number
  fileReads: number
  filesChanged: string[]
  seconds: number
  status: string
  error?: string
  model?: string
}

const READ_TOOLS = /^(Read|read_file|Grep|grep|Glob|LS|list_dir|code_symbol|code_find|NotebookRead)$/
const sh = (cmd: string, cwd: string): Promise<{ code: number; out: string }> =>
  new Promise((resolve) => exec(cmd, { cwd, windowsHide: true, timeout: 5 * 60_000, maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, out: (stdout + stderr).slice(-2000) })))
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function cloneRepo(src: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'viber-bench-'))
  const dest = path.join(dir, path.basename(src))
  const isGit = await fs.stat(path.join(src, '.git')).then(() => true, () => false)
  if (isGit) {
    await new Promise<void>((resolve, reject) =>
      execFile('git', ['clone', '--quiet', '--local', '--no-hardlinks', src, dest], { windowsHide: true }, (e) => (e ? reject(e) : resolve()))
    )
  } else {
    await fs.cp(src, dest, { recursive: true, filter: (p) => !/[\\/](node_modules|\.venv|venv|dist|build)([\\/]|$)/.test(p) })
  }
  // The curated model may not be committed: bring the working copy's version along.
  const arch = path.join(src, '.arch')
  if (await fs.stat(arch).then(() => true, () => false)) await fs.cp(arch, path.join(dest, '.arch'), { recursive: true, force: true })
  return dest
}

async function runOne(spec: BenchSpec, task: BenchTask, agent: AgentKind, variant: 'baseline' | 'viber', rep: number): Promise<BenchRun> {
  const t0 = Date.now()
  const base: BenchRun = { task: task.id, agent, variant, rep, ok: false, checks: [], tokens: { input: 0, output: 0, cacheRead: 0, total: 0 }, turns: 0, toolCalls: 0, fileReads: 0, filesChanged: [], seconds: 0, status: 'error' }
  let repo = ''
  try {
    repo = await cloneRepo(path.resolve(spec.repo))
    await openWorkspace(repo)
    const ws = ctx.requireWs()
    // A repo without a model gets Viber's proposal as-is (what a user would see after Initialize).
    if (!ws.initialized) {
      await ws.initialize()
      await ws.save()
    }
    for (let i = 0; i < 200 && !ctx.sessions; i++) await sleep(100)
    if (!ctx.sessions) throw new Error('session manager did not start')

    const id = await startSession({ prompt: task.prompt, scope: variant === 'viber' ? (task.scope ?? []) : [], agent, autoApprove: true, baseline: variant === 'baseline', model: spec.model })
    const deadline = Date.now() + (spec.timeoutMin ?? 15) * 60_000
    let s = ctx.sessions.get(id)!
    while (Date.now() < deadline && !['done', 'error', 'stopped'].includes(s.info.status)) {
      await sleep(500)
      s = ctx.sessions.get(id)!
    }
    if (!['done', 'error', 'stopped'].includes(s.info.status)) {
      stopSession(id)
      base.error = 'timeout'
    }
    // Let the watcher catch the last writes.
    await sleep(1500)

    const ev = s.events
    const t = s.info.tokens
    const run: BenchRun = {
      ...base,
      status: s.info.status,
      model: s.info.model,
      tokens: { input: t.input, output: t.output, cacheRead: t.cacheRead, total: t.input + t.output + t.cacheRead, costUsd: t.costUsd },
      turns: ev.filter((e) => e.t === 'message' && e.role === 'agent').length,
      toolCalls: ev.filter((e) => e.t === 'tool' && e.name !== 'thinking').length,
      fileReads: ev.filter((e) => e.t === 'tool' && READ_TOOLS.test(e.name)).length,
      filesChanged: [...new Set(ev.flatMap((e) => (e.t === 'edit' ? [e.file] : [])))],
      error: base.error ?? ev.find((e) => e.t === 'error')?.text
    }
    // Success checks.
    if (task.check) {
      const r = await sh(task.check, repo)
      run.checks.push({ name: task.check, ok: r.code === 0, detail: r.code === 0 ? undefined : r.out.trim().slice(-300) })
    }
    for (const c of task.expect?.contains ?? []) {
      const text = await fs.readFile(path.join(repo, c.file), 'utf8').catch(() => '')
      run.checks.push({ name: `${c.file} contains "${c.text}"`, ok: text.includes(c.text) })
    }
    for (const c of task.expect?.absent ?? []) {
      const text = await fs.readFile(path.join(repo, c.file), 'utf8').catch(() => '')
      run.checks.push({ name: `${c.file} has no "${c.text}"`, ok: !text.includes(c.text) })
    }
    run.ok = run.status === 'done' && run.filesChanged.length > 0 && run.checks.every((c) => c.ok)
    run.seconds = Math.round((Date.now() - t0) / 1000)
    return run
  } catch (err) {
    return { ...base, error: String((err as Error).message ?? err), seconds: Math.round((Date.now() - t0) / 1000) }
  } finally {
    ctx.setWorkspace(null)
    if (repo) {
      // Windows may hold handles for a moment after processes exit.
      for (let i = 0; i < 5; i++) {
        try {
          await fs.rm(path.dirname(repo), { recursive: true, force: true })
          break
        } catch {
          await sleep(1000)
        }
      }
    }
  }
}

const median = (xs: number[]): number => {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2
}

export function summarize(runs: BenchRun[]): { task: string; agent: string; baseline: Agg; viber: Agg; ratio: number | null }[] {
  const keys = [...new Set(runs.map((r) => `${r.task}|${r.agent}`))]
  return keys.map((k) => {
    const [task, agent] = k.split('|')
    const pick = (v: 'baseline' | 'viber'): Agg => aggregate(runs.filter((r) => r.task === task && r.agent === agent && r.variant === v))
    const baseline = pick('baseline')
    const viber = pick('viber')
    return { task, agent, baseline, viber, ratio: baseline.tokens && viber.tokens ? baseline.tokens / viber.tokens : null }
  })
}

interface Agg {
  n: number
  success: number
  tokens: number
  input: number
  output: number
  cacheRead: number
  costUsd: number | null
  fileReads: number
  toolCalls: number
  seconds: number
}

function aggregate(rs: BenchRun[]): Agg {
  const costs = rs.map((r) => r.tokens.costUsd).filter((c): c is number => typeof c === 'number')
  return {
    n: rs.length,
    success: rs.filter((r) => r.ok).length,
    tokens: median(rs.map((r) => r.tokens.total)),
    input: median(rs.map((r) => r.tokens.input)),
    output: median(rs.map((r) => r.tokens.output)),
    cacheRead: median(rs.map((r) => r.tokens.cacheRead)),
    costUsd: costs.length ? median(costs) : null,
    fileReads: median(rs.map((r) => r.fileReads)),
    toolCalls: median(rs.map((r) => r.toolCalls)),
    seconds: median(rs.map((r) => r.seconds))
  }
}

export function reportHtml(spec: BenchSpec, runs: BenchRun[], startedAt: Date): string {
  const rows = summarize(runs)
  const fmt = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n)))
  const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
  const totalBase = rows.reduce((a, r) => a + r.baseline.tokens, 0)
  const totalViber = rows.reduce((a, r) => a + r.viber.tokens, 0)
  const succ = (v: 'baseline' | 'viber'): string => {
    const rs = runs.filter((r) => r.variant === v)
    return `${rs.filter((r) => r.ok).length}/${rs.length}`
  }
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Viber benchmark</title>
<style>
:root{--bg:#fafbfc;--fg:#1d2330;--muted:#667085;--line:#e1e4ea;--good:#16a34a;--bad:#dc2626;--card:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#0a0e13;--fg:#d8dfe8;--muted:#7f8b9b;--line:#212a35;--good:#4ade80;--bad:#ff6b6b;--card:#10151c}}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:1100px;margin:0 auto;padding:24px 16px}
h1{font-size:22px;margin:0 0 4px}.muted{color:var(--muted)}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin:18px 0}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px}
.card b{display:block;font-size:24px}
.wrap{overflow-x:auto}table{border-collapse:collapse;width:100%;background:var(--card);border:1px solid var(--line);border-radius:12px}
th,td{padding:8px 10px;border-bottom:1px solid var(--line);text-align:right;white-space:nowrap}th:first-child,td:first-child{text-align:left}
.good{color:var(--good)}.bad{color:var(--bad)}code{font-size:12px}
</style></head><body><main>
<h1>${esc(spec.name)}</h1>
<p class="muted">${esc(spec.repo)} · ${startedAt.toISOString().slice(0, 16).replace('T', ' ')} · ${runs.length} runs · median per task</p>
<div class="cards">
<div class="card"><span class="muted">Tokens, baseline (sum of medians)</span><b>${fmt(totalBase)}</b></div>
<div class="card"><span class="muted">Tokens, with Viber</span><b>${fmt(totalViber)}</b></div>
<div class="card"><span class="muted">Ratio</span><b>${totalViber ? (totalBase / totalViber).toFixed(2) + '×' : '–'}</b></div>
<div class="card"><span class="muted">Tasks passed (baseline / Viber)</span><b>${succ('baseline')} · ${succ('viber')}</b></div>
</div>
<div class="wrap"><table><thead><tr><th>Task</th><th>Agent</th><th>Tokens base</th><th>Tokens Viber</th><th>Ratio</th><th>Cost base</th><th>Cost Viber</th><th>File reads</th><th>Tool calls</th><th>Passed</th><th>Seconds</th></tr></thead><tbody>
${rows
  .map(
    (r) => `<tr><td>${esc(r.task)}</td><td>${esc(r.agent)}</td><td>${fmt(r.baseline.tokens)}</td><td>${fmt(r.viber.tokens)}</td>
<td class="${r.ratio && r.ratio >= 1 ? 'good' : 'bad'}">${r.ratio ? r.ratio.toFixed(2) + '×' : '–'}</td>
<td>${r.baseline.costUsd !== null ? '$' + r.baseline.costUsd.toFixed(3) : '–'}</td><td>${r.viber.costUsd !== null ? '$' + r.viber.costUsd.toFixed(3) : '–'}</td>
<td>${r.baseline.fileReads} → ${r.viber.fileReads}</td><td>${r.baseline.toolCalls} → ${r.viber.toolCalls}</td>
<td>${r.baseline.success}/${r.baseline.n} → ${r.viber.success}/${r.viber.n}</td><td>${r.baseline.seconds} → ${r.viber.seconds}</td></tr>`
  )
  .join('\n')}
</tbody></table></div>
<h2>Runs</h2>
<div class="wrap"><table><thead><tr><th>Task</th><th>Agent</th><th>Variant</th><th>Model</th><th>Status</th><th>Tokens (in / cached / out)</th><th>Files changed</th><th>Checks</th></tr></thead><tbody>
${runs
  .map(
    (r) => `<tr><td>${esc(r.task)} #${r.rep + 1}</td><td>${esc(r.agent)}</td><td>${r.variant}</td><td>${esc(r.model ?? '')}</td>
<td class="${r.ok ? 'good' : 'bad'}">${esc(r.error ? `${r.status}: ${r.error.slice(0, 60)}` : r.status)}</td>
<td>${fmt(r.tokens.input)} / ${fmt(r.tokens.cacheRead)} / ${fmt(r.tokens.output)}</td><td><code>${esc(r.filesChanged.slice(0, 4).join(', '))}${r.filesChanged.length > 4 ? '…' : ''}</code></td>
<td>${r.checks.map((c) => `<span class="${c.ok ? 'good' : 'bad'}" title="${esc(c.detail ?? '')}">${c.ok ? '✓' : '✗'} ${esc(c.name)}</span>`).join('<br>')}</td></tr>`
  )
  .join('\n')}
</tbody></table></div>
<p class="muted">Tokens = input (incl. cache writes) + cache reads + output, as reported by the agent. Baseline: the same agent with a plain prompt and no Viber tools, map or context. Viber: map tools over MCP, the context pack and scope; plans auto-approved.</p>
</main></body></html>`
}

export async function runBench(specPath: string): Promise<void> {
  const spec: BenchSpec = JSON.parse(await fs.readFile(specPath, 'utf8'))
  const startedAt = new Date()
  const previous = await getSettings()
  if (spec.settings) await setSettings({ ...previous, ...spec.settings, providers: { ...previous.providers, ...spec.settings.providers }, roles: { ...previous.roles, ...spec.settings.roles } })
  const runs: BenchRun[] = []
  const outDir = path.resolve(path.dirname(specPath), 'results')
  await fs.mkdir(outDir, { recursive: true })
  const stamp = startedAt.toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const base = path.join(outDir, `${spec.name.replace(/\W+/g, '-').toLowerCase()}-${stamp}`)
  try {
    for (const task of spec.tasks) {
      for (const agent of spec.agents) {
        for (let rep = 0; rep < (spec.repeat ?? 1); rep++) {
          for (const variant of spec.variants ?? ['baseline', 'viber']) {
            console.log(`[bench] ${task.id} · ${agent} · ${variant} #${rep + 1}`)
            const r = await runOne(spec, task, agent, variant, rep)
            console.log(`[bench]   → ${r.ok ? 'PASS' : 'FAIL'} ${r.tokens.total} tokens, ${r.fileReads} reads, ${r.seconds}s${r.error ? ' · ' + r.error.slice(0, 120) : ''}`)
            runs.push(r)
            // Write as we go so a crash keeps partial results.
            await fs.writeFile(base + '.json', JSON.stringify({ spec, startedAt, runs, summary: summarize(runs) }, null, 2))
            await fs.writeFile(base + '.html', reportHtml(spec, runs, startedAt))
          }
        }
      }
    }
  } finally {
    if (spec.settings) await setSettings(previous)
  }
  console.log(`[bench] report: ${base}.html`)
}

export function maybeRunBench(): boolean {
  const spec = process.env.VIBER_BENCH
  if (!spec || app.isPackaged) return false
  void runBench(path.resolve(spec))
    .catch((e) => console.error('[bench] failed:', e))
    .finally(() => app.quit())
  return true
}
