import { lspReferences } from './lsp'
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import type { CodeSymbol } from '@shared/model'
import type { Workspace } from './workspace'
import type { ScanFile } from './engine/scan'
import { keywords, stem } from './contextPack'
import { git } from './git'
import { normPath, pathsMatch } from './engine/detect'

// Targeting: get an agent to the right lines fast.
//  - whereToChange: rank likely edit sites for a task (symbols + line ranges, with reasons).
//  - findUsages:   every definition and use of a route or symbol, across boxes and languages.
// Signals: names, signatures, docstrings, paths, routes, HTTP call sites, the import graph and
// git co-change history ("when this file changes, that one usually changes too").

export type CoChange = Map<string, Map<string, number>>

/** Files that changed together in recent history (commits touching ≤ 25 files). */
export async function buildCoChange(root: string, commits = 400): Promise<CoChange> {
  const r = await git(root, ['log', `-n${commits}`, '--name-only', '--no-merges', '--format=%x1e'])
  const map: CoChange = new Map()
  if (r.code !== 0) return map
  for (const chunk of r.stdout.split('\x1e')) {
    const files = chunk.split('\n').map((s) => s.trim()).filter(Boolean)
    if (files.length < 2 || files.length > 25) continue
    for (const a of files) {
      const m = map.get(a) ?? new Map<string, number>()
      for (const b of files) if (a !== b) m.set(b, (m.get(b) ?? 0) + 1)
      map.set(a, m)
    }
  }
  return map
}

/** Name of the function a diff hunk is in, from its header context ("def foo(", "function bar(", "func (r) Baz("). */
export function hunkSymbol(context: string): string | null {
  const m =
    context.match(/\b(?:def|class|function|func|fn|interface|struct|enum|trait|impl|type)\s+(?:\([^)]*\)\s*)?([A-Za-z_$][\w$]*)/) ??
    context.match(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\(|function|[A-Za-z_$][\w$]*\s*=>)/) ??
    context.match(/^\s*(?:(?:public|private|protected|static|async|override|export)\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::[^{]*)?\{?\s*$/)
  const name = m?.[1]
  return name && !['if', 'for', 'while', 'switch', 'catch', 'return'].includes(name) ? name : null
}

/** Functions that changed together in recent commits, keyed "file#name" (commits touching ≤ 40 symbols). */
export async function buildSymbolCoChange(root: string, commits = 300): Promise<CoChange> {
  const map: CoChange = new Map()
  // Git's built-in function-name drivers give better hunk headers (indented Python methods, Go receivers…).
  const attrs = path.join(os.tmpdir(), 'viber-diff-attributes')
  await fs.writeFile(attrs, ['*.py diff=python', '*.go diff=golang', '*.rs diff=rust', '*.java diff=java', '*.kt diff=java', '*.rb diff=ruby', '*.php diff=php', '*.cs diff=csharp'].join('\n')).catch(() => {})
  const r = await git(root, ['-c', `core.attributesFile=${attrs}`, 'log', `-n${commits}`, '--no-merges', '-p', '-U0', '--no-color', '--format=%x1e'])
  if (r.code !== 0) return map
  for (const chunk of r.stdout.split('\x1e')) {
    const touched = new Set<string>()
    let file = ''
    for (const line of chunk.split('\n')) {
      if (line.startsWith('+++ ')) file = line.startsWith('+++ b/') ? line.slice(6) : ''
      else if (file && line.startsWith('@@')) {
        const name = hunkSymbol(line.replace(/^@@[^@]*@@\s?/, ''))
        if (name) touched.add(`${file}#${name}`)
      } else if (file && /^\+\s*(?:export\s+)?(?:async\s+)?(?:def|function|func|fn|class)\s/.test(line)) {
        const name = hunkSymbol(line.slice(1))
        if (name) touched.add(`${file}#${name}`)
      }
    }
    if (touched.size < 2 || touched.size > 40) continue
    for (const a of touched) {
      const m = map.get(a) ?? new Map<string, number>()
      for (const b of touched) if (a !== b) m.set(b, (m.get(b) ?? 0) + 1)
      map.set(a, m)
    }
  }
  return map
}

const ROUTE_IN_TEXT = /(?:^|[\s"'`(])((?:GET|POST|PUT|PATCH|DELETE)\s+)?(\/[A-Za-z0-9_\-/{}:.]+)/g

export function symbolAt(f: ScanFile | undefined, line: number): CodeSymbol | undefined {
  if (!f) return undefined
  const containing = f.symbols.filter((s) => s.line && s.endLine && s.line <= line && line <= s.endLine).sort((a, b) => a.endLine! - a.line! - (b.endLine! - b.line!))[0]
  if (containing) return containing
  // Decorators sit just above the definition (e.g. @app.get(...) then def handler()).
  return f.symbols.filter((s) => s.line && s.line > line && s.line <= line + 3).sort((a, b) => a.line! - b.line!)[0]
}

const range = (s: CodeSymbol): string => `${s.file}:${s.line}${s.endLine && s.endLine !== s.line ? '-' + s.endLine : ''}`

interface Candidate {
  file: string
  score: number
  reasons: Set<string>
  symbols: Map<string, { s: CodeSymbol; score: number }>
  lines: Set<string>
}

export interface Prediction {
  file: string
  box: string | null
  score: number
  reasons: string[]
  symbols: { name: string; signature: string; range: string; doc?: string }[]
  sites: string[]
  /** Functions that usually change with this one's symbols (git history). */
  alsoChanges?: string[]
}

/** Weight of body-text evidence relative to names (×3) and docstrings (×1.5); tuned on real commit history. */
export let BODY_WEIGHT = 0.5
export const setBodyWeight = (w: number): void => {
  BODY_WEIGHT = w
}

export function whereToChange(ws: Workspace, task: string, opts: { scope?: string[]; limit?: number } = {}): Prediction[] {
  const kws = keywords(task)
  const routesInTask = [...task.matchAll(ROUTE_IN_TEXT)].map((m) => m[2]).filter((r) => r.length > 2)
  // Where the user says the change goes: "to the weather module", "in Dashboard.jsx", a box name.
  const LOCATION = /\b(?:to|in|into|inside|on|of)\s+(?:the\s+)?([\w.-]+)\s+(?:module|file|page|component|service|class|box|router|screen|view|layer|package|store|hook|helper|endpoint|api|app)s?\b/gi
  const hinted = new Set([...task.matchAll(LOCATION)].map((m) => m[1].toLowerCase()))
  // Identifier style hints at the language: is_frost_risk → Python/Ruby/Rust, isFrostRisk → JS/TS/Java.
  const snake = /[a-z]+_[a-z_]+/.test(task.replace(ROUTE_IN_TEXT, ''))
  const camel = /[a-z]+[A-Z][a-zA-Z]+/.test(task)
  const langHint = snake && !camel ? /\.(py|rb|rs)$/ : camel && !snake ? /\.(tsx?|jsx?|java|kt|go|cs)$/ : null
  const fileNames = new Set([...task.matchAll(/\b[\w-]+\.(?:tsx?|jsx?|py|go|rs|java|kt|cs|php|rb|vue|svelte)\b/g)].map((m) => m[0].toLowerCase()))
  const boxHints = new Set(
    (ws.built?.model.nodes ?? [])
      .filter((n) => n.kind === 'box' && n.label.length > 3 && new RegExp(`\\b${n.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(task))
      .map((n) => n.id)
  )
  const files = ws.allFiles().filter((f) => !f.flags.includes('test'))
  const scope = new Set(opts.scope ?? [])
  const model = ws.built?.model
  const inScope = (file: string): boolean => {
    if (!scope.size || !model) return false
    const owner = ws.ownerOfFile(file)
    let cur = model.nodes.find((n) => n.id === owner)
    while (cur) {
      if (scope.has(cur.id)) return true
      cur = cur.parent ? model.nodes.find((n) => n.id === cur!.parent) : undefined
    }
    return false
  }
  const tokensOf = (s: string): string[] => keywords(s)
  const cands = new Map<string, Candidate>()
  const cand = (file: string): Candidate => {
    let c = cands.get(file)
    if (!c) cands.set(file, (c = { file, score: 0, reasons: new Set(), symbols: new Map(), lines: new Set() }))
    return c
  }

  // Body text: how often each task word appears in a file, weighted by how rare the word is (IDF).
  const stems = [...new Set(kws.map(stem))]
  const df = new Map(stems.map((k) => [k, files.filter((f) => f.terms?.[k]).length]))
  const idf = (k: string): number => Math.log((files.length + 1) / ((df.get(k) ?? 0) + 0.5))

  for (const f of files) {
    if (f.terms) {
      let body = 0
      const hits: string[] = []
      for (const k of stems) {
        const tf = f.terms[k]
        if (!tf || !df.get(k)) continue
        body += idf(k) * Math.log2(1 + tf)
        hits.push(k)
      }
      if (body > 0) {
        const c = cand(f.path)
        c.score += body * BODY_WEIGHT
        if (hits.length) c.reasons.add(`mentions ${hits.slice(0, 3).join(', ')}`)
      }
    }
    const base = path.posix.basename(f.path).toLowerCase()
    const stem = base.replace(/\.\w+$/, '')
    // Explicit location: a named file or "the X module" is the strongest signal there is.
    if (fileNames.has(base)) {
      const c = cand(f.path)
      c.score += 20
      c.reasons.add('named in the task')
    } else if (hinted.has(stem)) {
      const c = cand(f.path)
      c.score += 12
      c.reasons.add(`the task points at "${stem}"`)
    } else if (hinted.has(stem.replace(/(page|view|screen|service|module)$/, ''))) {
      const c = cand(f.path)
      c.score += 8
      c.reasons.add(`the task points at "${stem}"`)
    }
    if (langHint && langHint.test(base)) cand(f.path).score += 3
    const owner = ws.ownerOfFile(f.path)
    if (owner && boxHints.has(owner)) {
      const c = cand(f.path)
      c.score += 3
      c.reasons.add('in a box the task names')
    }
    // Path words.
    const pathHits = tokensOf(f.path).filter((t) => kws.includes(t))
    if (pathHits.length) {
      const c = cand(f.path)
      c.score += pathHits.length * 2
      c.reasons.add(`path mentions ${pathHits.join(', ')}`)
    }
    // Symbols: name ×3, docstring ×1.5, signature ×0.5, with diminishing returns per file so
    // ten weak matches don't beat one strong one.
    const symScores: number[] = []
    for (const s of f.symbols) {
      const nameHits = tokensOf(s.name).filter((t) => kws.includes(t)).length
      const docHits = s.doc ? tokensOf(s.doc).filter((t) => kws.includes(t)).length : 0
      const sigHits = tokensOf(s.signature).filter((t) => kws.includes(t)).length
      const sc = nameHits * 3 + docHits * 1.5 + sigHits * 0.5
      if (sc <= 0) continue
      symScores.push(sc)
      const c = cand(f.path)
      const prev = c.symbols.get(s.name + s.line)
      c.symbols.set(s.name + s.line, { s, score: (prev?.score ?? 0) + sc })
    }
    if (symScores.length) {
      symScores.sort((a, b) => b - a)
      cand(f.path).score += symScores.slice(0, 2).reduce((a, b) => a + b, 0) + symScores.slice(2).reduce((a, b) => a + b, 0) * 0.15
    }
    // Routes named in the task: the server handler and every client call site.
    for (const rt of routesInTask) {
      for (const r of f.routes) {
        if (!pathsMatch(rt, r.path) && normPath(r.path) !== normPath(rt)) continue
        const c = cand(f.path)
        c.score += 12
        c.reasons.add(`serves ${r.method} ${r.path}`)
        c.lines.add(`${f.path}:${r.line} route ${r.method} ${r.path}`)
        const h = symbolAt(f, r.line)
        if (h) c.symbols.set(h.name + h.line, { s: h, score: 12 })
      }
      for (const call of f.calls) {
        if (!pathsMatch(call.url, rt) && !call.url.includes(rt)) continue
        const c = cand(f.path)
        c.score += 10
        c.reasons.add(`calls ${call.url}`)
        c.lines.add(`${f.path}:${call.line} call ${call.method} ${call.url}`)
        const h = symbolAt(f, call.line)
        if (h) c.symbols.set(h.name + h.line, { s: h, score: 10 })
      }
    }
    // Route words (no literal path in the task): e.g. "health endpoint" ↔ GET /api/health.
    for (const r of f.routes) {
      const hits = tokensOf(r.path).filter((t) => kws.includes(t)).length
      if (!hits) continue
      const c = cand(f.path)
      c.score += hits * 2
      c.reasons.add(`route ${r.method} ${r.path}`)
    }
  }

  // Scope boost, then spread a share of each score to graph and co-change neighbours. Neighbour
  // bonuses are kept apart and capped, so a file with direct evidence always outranks one that is
  // merely next to a hit.
  for (const c of cands.values()) if (inScope(c.file)) (c.score *= 1.6), c.reasons.add('in scope')
  const direct = new Map([...cands.values()].map((c) => [c.file, c.score]))
  const bonus = new Map<string, number>()
  const addBonus = (file: string, v: number, why: string): void => {
    bonus.set(file, (bonus.get(file) ?? 0) + v)
    cand(file).reasons.add(why)
  }
  const seeds = [...cands.values()].sort((a, b) => b.score - a.score).slice(0, 10)
  const deps = ws.res?.deps ?? []
  for (const c of seeds) {
    for (const d of deps) {
      const other = d.from === c.file ? d.to : d.to === c.file ? d.from : null
      if (!other || ws.fileInfo(other)?.flags.includes('test')) continue
      addBonus(other, c.score * 0.15, `${d.from === c.file ? 'used by' : 'uses'} ${path.posix.basename(c.file)}`)
    }
    const co = ws.coChange?.get(c.file)
    if (co) {
      const max = Math.max(...co.values())
      for (const [other, n] of co) {
        if (!ws.fileInfo(other) || n < 2) continue
        addBonus(other, c.score * 0.35 * (n / max), `changes with ${path.posix.basename(c.file)} (${n}×)`)
      }
    }
  }
  const directScores = [...direct.values()].filter((v) => v > 0).sort((a, b) => b - a)
  const floor = directScores[Math.min(4, directScores.length - 1)] ?? 1
  for (const c of cands.values()) {
    const d = direct.get(c.file) ?? 0
    const b = bonus.get(c.file) ?? 0
    // With evidence: the bonus can at most double it. Without: rank below the top direct hits.
    c.score = d > 0 ? d + Math.min(b, d) : Math.min(b, floor * 0.6)
  }

  return [...cands.values()]
    .filter((c) => c.score > 0.5)
    .sort((a, b) => b.score - a.score)
    .slice(0, opts.limit ?? 8)
    .map((c) => {
      // A precise site line beats a huge enclosing function (e.g. routes inside create_app()).
      const hasSites = c.lines.size > 0
      const syms = [...c.symbols.values()]
        .filter(({ s }) => !(hasSites && s.line && s.endLine && s.endLine - s.line > 150))
        .sort((a, b) => b.score - a.score)
        .slice(0, 4)
      return {
        file: c.file,
        box: ws.ownerOfFile(c.file),
        score: Math.round(c.score * 10) / 10,
        reasons: [...c.reasons].slice(0, 4),
        symbols: syms.map(({ s }) => ({ name: s.name, signature: s.signature, range: range(s), doc: s.doc })),
        sites: [...c.lines].slice(0, 6),
        alsoChanges: alsoChanges(ws, c.file, syms.map(({ s }) => s.name))
      }
    })
}

/** Functions that usually change together with these ones (from git history), still present in the code. */
function alsoChanges(ws: Workspace, file: string, names: string[]): string[] {
  const out = new Map<string, number>()
  for (const n of names) {
    for (const [other, count] of ws.symbolCoChange?.get(`${file}#${n}`) ?? []) {
      if (count < 2) continue
      const [f, name] = other.split('#')
      if (!ws.fileInfo(f)?.symbols.some((s) => s.name === name)) continue
      out.set(other, Math.max(out.get(other) ?? 0, count))
    }
  }
  return [...out.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, n]) => `${k} (${n}×)`)
}

export function predictionsText(preds: Prediction[]): string {
  if (!preds.length) return 'No confident prediction. Use code_find with other keywords, or arch_box.'
  return preds
    .map((p, i) => {
      const head = `${i + 1}. ${p.file}${p.box ? `  [box ${p.box}]` : ''}  — ${p.reasons.join('; ')}`
      const syms = p.symbols.map((s) => `   - ${s.signature}  @${s.range}${s.doc ? `  // ${s.doc.slice(0, 90)}` : ''}`)
      const sites = p.sites.map((x) => `   * ${x}`)
      const also = p.alsoChanges?.length ? [`   ↔ usually changes with: ${p.alsoChanges.join(', ')}`] : []
      return [head, ...syms, ...sites, ...also].join('\n')
    })
    .join('\n')
}

/** Definitions and uses of a route ("/api/x", "POST /api/x") or a symbol name, across the repo. */
export async function findUsages(ws: Workspace, cwd: string, target: string): Promise<string> {
  const t = target.trim()
  const files = ws.allFiles()
  const lines: string[] = []
  const routeMatch = t.match(/^(?:(GET|POST|PUT|PATCH|DELETE)\s+)?(\/\S*)$/i)
  if (routeMatch) {
    const p = routeMatch[2]
    const defs: string[] = []
    const calls: string[] = []
    for (const f of files) {
      for (const r of f.routes) {
        if (!pathsMatch(p, r.path)) continue
        const h = symbolAt(f, r.line)
        defs.push(`${f.path}:${r.line}  ${r.method} ${r.path}${h ? `  → handler ${h.name} @${range(h)}` : ''}  [box ${ws.ownerOfFile(f.path) ?? '?'}]`)
      }
      for (const c of f.calls) {
        if (!pathsMatch(c.url, p)) continue
        const h = symbolAt(f, c.line)
        calls.push(`${f.path}:${c.line}  ${c.method} ${c.url}${h ? `  in ${h.name}` : ''}  [box ${ws.ownerOfFile(f.path) ?? '?'}]`)
      }
    }
    // Literal mentions the detectors may have missed (tests, configs, strings built by hand).
    const literal: string[] = []
    for (const f of files) {
      const text = await fs.readFile(path.join(cwd, f.path), 'utf8').catch(() => '')
      if (!text.includes(p)) continue
      text.split('\n').forEach((l, i) => {
        const loc = `${f.path}:${i + 1}`
        if (l.includes(p) && !defs.some((d) => d.startsWith(loc + ' ')) && !calls.some((c) => c.startsWith(loc + ' '))) literal.push(`${loc}  ${l.trim().slice(0, 120)}`)
      })
    }
    lines.push(`Server definitions (${defs.length}):`, ...defs, `Client calls (${calls.length}):`, ...calls)
    if (literal.length) lines.push(`Other mentions (${literal.length}):`, ...literal.slice(0, 20))
    return lines.join('\n')
  }

  // Symbol: definitions, importers, and the exact lines that use it.
  const name = t.replace(/\(\)$/, '')
  const defs = files.flatMap((f) => f.symbols.filter((s) => s.name === name || s.name.endsWith('.' + name)).map((s) => `${range(s)}  ${s.signature}  [box ${ws.ownerOfFile(f.path) ?? '?'}]`))
  const importers = files.filter((f) => Object.values(f.importNames).some((ns) => ns.includes(name)))
  const defFiles = new Set(files.filter((f) => f.symbols.some((s) => s.name === name)).map((f) => f.path))

  // Exact references from a language server, when one can answer for the defining file.
  const defSyms = files.flatMap((f) => f.symbols.filter((s) => s.name === name && s.line)).slice(0, 3)
  const exact: string[] = []
  let answered = false
  const candidates: string[] = []
  if (defSyms.length)
    for (const f of files.slice(0, 3000)) {
      const text = await fs.readFile(path.join(cwd, f.path), 'utf8').catch(() => '')
      if (text.includes(name)) candidates.push(f.path)
    }
  for (const s of defSyms) {
    const text = await fs.readFile(path.join(cwd, s.file), 'utf8').catch(() => '')
    const lineText = text.split('\n')[s.line! - 1] ?? ''
    const col = lineText.search(new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`)) + 1
    if (col < 1) continue
    const refs = await lspReferences(cwd, s.file, s.line!, col, candidates)
    if (!refs) continue
    answered = true
    const cache = new Map<string, string[]>()
    for (const r of refs) {
      if (!cache.has(r.file)) cache.set(r.file, (await fs.readFile(path.join(cwd, r.file), 'utf8').catch(() => '')).split('\n'))
      const loc = `${r.file}:${r.line}`
      if (!exact.some((e) => e.startsWith(loc + ' ')) && exact.length < 80) exact.push(`${loc}  ${(cache.get(r.file)![r.line - 1] ?? '').trim().slice(0, 120)}  [box ${ws.ownerOfFile(r.file) ?? '?'}]`)
    }
  }
  if (answered) return [`Definitions (${defs.length}):`, ...defs, `References (${exact.length}, exact, from the language server):`, ...exact].join('\n')

  const re =new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`)
  const uses: string[] = []
  for (const f of [...importers, ...files.filter((f) => defFiles.has(f.path))]) {
    const text = await fs.readFile(path.join(cwd, f.path), 'utf8').catch(() => '')
    text.split('\n').forEach((l, i) => {
      if (re.test(l) && !/^\s*(import|from|export \{)/.test(l) && uses.length < 60) uses.push(`${f.path}:${i + 1}  ${l.trim().slice(0, 120)}`)
    })
  }
  return [`Definitions (${defs.length}):`, ...defs, `Imported by (${importers.length}): ${importers.map((f) => f.path).join(', ') || '—'}`, `Uses (${uses.length}):`, ...uses].join('\n')
}
