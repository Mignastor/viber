import { spawn, type ChildProcess } from 'child_process'
import path from 'path'
import type { ArchNode } from '@shared/model'
import { ctx } from './context'
import { getSettings } from './settings'
import { recordRuntimeHit } from './runtime'

// Running the app and its tests. Output is streamed to the UI; stack traces are mapped to boxes
// (they turn red on the map) and request log lines light up the route boxes.

export interface RunConfig {
  id: string
  label: string
  command: string
  cwd: string
  kind: 'dev' | 'test' | 'build' | 'other'
}

const procs = new Map<string, ChildProcess>()

export function detectRunConfigs(): RunConfig[] {
  const ws = ctx.ws
  if (!ws?.scan) return []
  const out: RunConfig[] = []
  for (const [p, txt] of Object.entries(ws.scan.manifests)) {
    const dir = path.posix.dirname(p) === '.' ? '' : path.posix.dirname(p)
    const where = dir ? ` (${dir})` : ''
    if (p.endsWith('package.json')) {
      try {
        const scripts = JSON.parse(txt).scripts ?? {}
        for (const name of ['dev', 'start', 'test', 'build', 'lint', 'typecheck']) {
          if (scripts[name]) out.push({ id: `npm:${dir}:${name}`, label: `npm run ${name}${where}`, command: `npm run ${name}`, cwd: dir, kind: name === 'test' ? 'test' : name === 'dev' || name === 'start' ? 'dev' : name === 'build' ? 'build' : 'other' })
        }
      } catch {
        /* skip */
      }
    } else if (/pyproject\.toml$|requirements[^/]*\.txt$/.test(p) && !out.some((c) => c.id === `py:${dir}:test`)) {
      out.push({ id: `py:${dir}:test`, label: `pytest${where}`, command: 'python -m pytest -q -rA', cwd: dir, kind: 'test' })
    } else if (p.endsWith('manage.py')) {
      out.push({ id: `dj:${dir}`, label: `Django runserver${where}`, command: 'python manage.py runserver', cwd: dir, kind: 'dev' })
    } else if (p.endsWith('go.mod')) {
      out.push({ id: `go:${dir}:test`, label: `go test${where}`, command: 'go test ./...', cwd: dir, kind: 'test' })
      out.push({ id: `go:${dir}:run`, label: `go run${where}`, command: 'go run .', cwd: dir, kind: 'dev' })
    } else if (p.endsWith('Cargo.toml')) {
      out.push({ id: `cargo:${dir}:test`, label: `cargo test${where}`, command: 'cargo test', cwd: dir, kind: 'test' })
      out.push({ id: `cargo:${dir}:run`, label: `cargo run${where}`, command: 'cargo run', cwd: dir, kind: 'dev' })
    } else if (/docker-compose\.ya?ml$|compose\.ya?ml$/.test(p)) {
      out.push({ id: `compose:${dir}`, label: `docker compose up${where}`, command: 'docker compose up', cwd: dir, kind: 'dev' })
    }
  }
  return out
}

const TRACE_LINE = /([\w@./\\-]+\.(?:tsx?|jsx?|mjs|cjs|py|go|rs|java|kt|cs|php|rb))(?:"?,? line |:|\()(\d+)/
const HTTP_LINE = /\b(GET|POST|PUT|PATCH|DELETE)\s+(\/[\w/.:{}?=&%-]*)\s+(?:HTTP\/[\d.]+"?\s+)?(\d{3})(?:\s+(?:in\s+)?(\d+(?:\.\d+)?)\s*ms)?/

export function startRun(cfg: RunConfig): void {
  const ws = ctx.requireWs()
  stopRun(cfg.id)
  const cwd = path.join(ws.root, cfg.cwd)
  const child = spawn(cfg.command, { cwd, shell: true, windowsHide: true, env: { ...process.env, FORCE_COLOR: '0', OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json' } })
  procs.set(cfg.id, child)
  ctx.emit('run:status', { id: cfg.id, running: true })
  let errorBlock: string[] = []
  let flushTimer: ReturnType<typeof setTimeout> | null = null
  const flushError = async (): Promise<void> => {
    const text = errorBlock.join('\n')
    errorBlock = []
    if (!ctx.ws || !text) return
    const r = await ctx.ws.locate(text)
    const boxes = [...new Set(r.hits.filter((h) => h.score >= 8).map((h) => h.nodeId))].slice(0, 4)
    if (boxes.length) ctx.sessions?.push(ctx.sessions.watching.id, { t: 'runtime', boxes, text: `${cfg.label}: ${text.split('\n')[0].slice(0, 160)}`, level: 'error', tokens: 0, naive: 0 })
  }
  const onLine = (line: string, stream: 'out' | 'err'): void => {
    ctx.emit('run:output', { id: cfg.id, line, stream })
    const url = line.match(/https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):\d+\/?/)
    if (url) ctx.emit('run:url', { id: cfg.id, url: url[0].replace('0.0.0.0', 'localhost') })
    const http = line.match(HTTP_LINE)
    if (http) recordRuntimeHit({ method: http[1], path: http[2], status: Number(http[3]), ms: http[4] ? Number(http[4]) : undefined })
    if (/\b(Error|Exception|Traceback|panic:|FAIL)\b/.test(line) || (errorBlock.length && TRACE_LINE.test(line))) {
      errorBlock.push(line)
      if (flushTimer) clearTimeout(flushTimer)
      flushTimer = setTimeout(() => void flushError(), 400)
    }
  }
  const pipe = (s: NodeJS.ReadableStream | null, stream: 'out' | 'err'): void => {
    let buf = ''
    s?.on('data', (d: Buffer) => {
      buf += d.toString('utf8')
      const lines = buf.split(/\r?\n/)
      buf = lines.pop() ?? ''
      for (const l of lines) onLine(l, stream)
    })
  }
  pipe(child.stdout, 'out')
  pipe(child.stderr, 'err')
  child.on('close', (code) => {
    procs.delete(cfg.id)
    ctx.emit('run:status', { id: cfg.id, running: false, code })
  })
}

export function stopRun(id: string): void {
  const p = procs.get(id)
  if (!p) return
  if (process.platform === 'win32' && p.pid) spawn('taskkill', ['/pid', String(p.pid), '/T', '/F'], { windowsHide: true })
  else p.kill('SIGTERM')
  procs.delete(id)
}

export function stopAllRuns(): void {
  for (const id of [...procs.keys()]) stopRun(id)
}

// ── Impacted tests ────────────────────────────────────────────────────────────────────────

/** After an agent session: find tests affected by the files it changed, run them if allowed, map results to boxes. */
export async function runImpactedTests(sessionId: string): Promise<void> {
  const ws = ctx.ws
  const sm = ctx.sessions
  const s = sm?.get(sessionId)
  if (!ws || !sm || !s) return
  const changed = [...new Set(s.events.flatMap((e) => (e.t === 'edit' && !e.deleted ? [e.file] : [])))]
  if (!changed.length) return
  const tests = new Set<string>()
  for (const f of changed) {
    if (ws.fileInfo(f)?.flags.includes('test')) tests.add(f)
    for (const t of ws.impact(f).tests) tests.add(t)
  }
  // Tests mapped to touched boxes count too.
  const touchedBoxes = new Set(changed.map((f) => ws.ownerOfFile(f)).filter(Boolean) as string[])
  for (const n of ws.built?.model.nodes ?? []) if (touchedBoxes.has(n.id)) for (const t of n.tests ?? []) tests.add(t)
  const list = [...tests]
  const total = ws.allFiles().filter((f) => f.flags.includes('test')).length
  if (!list.length) {
    sm.push(sessionId, { t: 'message', role: 'system', text: `No tests cover the ${changed.length} changed file(s).`, tokens: 0, naive: 0 })
    return
  }
  const cmd = testCommand(list)
  const settings = await getSettings()
  if (!cmd || !settings.allowedCommands.some((p) => p && cmd.command.startsWith(p))) {
    sm.push(sessionId, {
      t: 'message',
      role: 'system',
      text: `${list.length} of ${total} tests are affected${cmd ? `. Run them with: ${cmd.command}` : ''}. Allow "${cmd?.command.split(' ').slice(0, 2).join(' ') ?? 'your test runner'}" in Settings to run them automatically.`,
      tokens: 0,
      naive: 0
    })
    return
  }
  const result = await new Promise<{ code: number; out: string }>((resolve) => {
    const child = spawn(cmd.command, { cwd: path.join(s.root, cmd.cwd), shell: true, windowsHide: true, env: { ...process.env, FORCE_COLOR: '0', CI: '1' } })
    let out = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (out += d))
    child.on('close', (code) => resolve({ code: code ?? 1, out }))
  })
  const perFile = parseTestOutput(result.out, list)
  const results: Record<string, { passed: number; failed: number }> = {}
  const boxOfTest = (t: string): string | undefined => (ws.built?.model.nodes as ArchNode[] | undefined)?.find((n) => n.tests?.includes(t))?.id
  for (const t of list) {
    const box = boxOfTest(t)
    if (!box) continue
    const r = perFile[t] ?? (result.code === 0 ? { passed: 1, failed: 0 } : { passed: 0, failed: 1 })
    results[box] = { passed: (results[box]?.passed ?? 0) + r.passed, failed: (results[box]?.failed ?? 0) + r.failed }
  }
  const failures = result.out
    .split('\n')
    .filter((l) => /FAIL|FAILED|✗|×|Error:/.test(l))
    .slice(0, 6)
    .map((l) => l.trim().slice(0, 160))
  sm.push(sessionId, { t: 'tests', selected: list.length, total, results, failures: result.code === 0 ? [] : failures, tokens: 0, naive: 0 })
}

function testCommand(files: string[]): { command: string; cwd: string } | null {
  const ws = ctx.ws!
  const manifests = ws.scan?.manifests ?? {}
  const py = files.filter((f) => f.endsWith('.py'))
  if (py.length) return { command: `python -m pytest -q -rA ${py.join(' ')}`, cwd: '' }
  const go = [...new Set(files.filter((f) => f.endsWith('.go')).map((f) => './' + path.posix.dirname(f)))]
  if (go.length) return { command: `go test ${go.join(' ')}`, cwd: '' }
  const js = files.filter((f) => /\.(test|spec)\.[jt]sx?$/.test(f))
  if (js.length) {
    const pkg = Object.entries(manifests).find(([p]) => p === 'package.json')?.[1] ?? ''
    if (/"vitest"/.test(pkg)) return { command: `npx vitest run ${js.join(' ')}`, cwd: '' }
    if (/"jest"/.test(pkg)) return { command: `npx jest ${js.join(' ')}`, cwd: '' }
    return { command: `npm test -- ${js.join(' ')}`, cwd: '' }
  }
  return null
}

function parseTestOutput(out: string, files: string[]): Record<string, { passed: number; failed: number }> {
  const res: Record<string, { passed: number; failed: number }> = {}
  const bump = (file: string, ok: boolean): void => {
    const f = files.find((x) => file.endsWith(x) || x.endsWith(file))
    if (!f) return
    res[f] = res[f] ?? { passed: 0, failed: 0 }
    if (ok) res[f].passed++
    else res[f].failed++
  }
  // pytest -rA: "PASSED tests/test_x.py::test_a"
  for (const m of out.matchAll(/^(PASSED|FAILED|ERROR)\s+([^\s:]+\.py)::/gm)) bump(m[2], m[1] === 'PASSED')
  // vitest/jest summary per file: "✓ src/a.test.ts (3 tests)" / "❯ src/a.test.ts (3 tests | 1 failed)"
  for (const m of out.matchAll(/^\s*[✓❯×✗]\s+(\S+\.(?:test|spec)\.[jt]sx?)\s+\((\d+) tests?(?:\s*\|\s*(\d+) failed)?/gm)) {
    const failed = Number(m[3] ?? 0)
    const total = Number(m[2])
    const f = files.find((x) => m[1].endsWith(x) || x.endsWith(m[1]))
    if (f) res[f] = { passed: total - failed, failed }
  }
  // go test: "ok  	pkg/path" / "FAIL	pkg/path"
  return res
}
