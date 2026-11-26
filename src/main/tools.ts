import { promises as fs } from 'fs'
import path from 'path'
import { exec } from 'child_process'
import { z } from 'zod'
import type { ArchEdge, ArchNode, CodeSymbol } from '@shared/model'
import type { ContractChange } from '@shared/events'
import type { Workspace } from './workspace'
import type { SessionManager } from './sessions'
import { boxText, overviewText, resolveNode, isDescendant, estimateTokens } from './contextPack'
import { humanize } from './engine/group'
import { findUsages, predictionsText, whereToChange } from './targeting'
import { askQuestion } from './questions'
import { proposeAcp } from './acp'
import { syntaxErrors } from './engine/scan'
import { lspNewErrors } from './lsp'

// The tool surface agents get. External agents reach it over MCP; the built-in agent calls it
// directly. Every tool answers with the *smallest useful text*, and says how to get more.

export interface ToolContext {
  ws: Workspace
  sessions: SessionManager
  sessionId: string
  /** Shell commands the user allows agents to run (prefix match). */
  allowedCommands: string[]
}

export interface ToolDef<S extends z.ZodRawShape = z.ZodRawShape> {
  name: string
  description: string
  shape: S
  /** Only offered to the built-in agent (external agents have their own file tools). */
  builtinOnly?: boolean
  run: (args: z.infer<z.ZodObject<S>>, ctx: ToolContext) => Promise<string>
}

const def = <S extends z.ZodRawShape>(t: ToolDef<S>): ToolDef => t as unknown as ToolDef

function findSymbols(ws: Workspace, name: string, file?: string): CodeSymbol[] {
  const out: CodeSymbol[] = []
  for (const f of ws.allFiles()) {
    if (file && f.path !== file && !f.path.endsWith(file)) continue
    for (const s of f.symbols) if (s.name === name || s.name.endsWith('.' + name)) out.push(s)
  }
  return out.sort((a, b) => Number(b.exported) - Number(a.exported))
}

// ── Stale context: what each session has read, so it hears when someone else changes it ──
const seen = new Map<string, Map<string, number>>() // sessionId → absolute path → mtime when read/written

/** Remember the file's current version for this session (after a read, or after its own write). */
export async function track(sessionId: string, abs: string): Promise<void> {
  const m = await fs.stat(abs).then((s) => s.mtimeMs, () => 0)
  if (!seen.has(sessionId)) seen.set(sessionId, new Map())
  seen.get(sessionId)!.set(abs, m)
}

/** Files this session read that changed since (each reported once). */
export async function staleFor(sessionId: string, cwd: string): Promise<string[]> {
  const files = seen.get(sessionId)
  if (!files) return []
  const out: string[] = []
  for (const [abs, m] of files) {
    const now = await fs.stat(abs).then((s) => s.mtimeMs, () => -1)
    if (now !== m) {
      out.push(path.relative(cwd, abs).split(path.sep).join('/'))
      files.set(abs, now)
    }
  }
  return out
}

export function forgetSession(sessionId: string): void {
  seen.delete(sessionId)
  checkedEdits.delete(sessionId)
}

/** Run a tool and append a notice when files the agent read were changed by someone else meanwhile. */
/** The type errors an edit introduced, as a note for the agent ('' when none or no language server). */
async function typeNote(cwd: string, rel: string, before: string | null, after: string): Promise<string> {
  const errs = await lspNewErrors(cwd, rel, before, after)
  return errs?.length ? `\nType errors this edit introduced in ${rel} (fix them before moving on):\n${errs.map((e) => `- ${e}`).join('\n')}` : ''
}

// Edits made with the agent's own tools (Claude Code, Codex, Gemini): checked at its next Viber tool call.
const checkedEdits = new Map<string, number>() // sessionId → number of edit events already checked

async function typeNotesForOwnEdits(ctx: ToolContext, cwd: string): Promise<string> {
  const s = ctx.sessions.get(ctx.sessionId)
  if (!s) return ''
  const edits = s.events.filter((e) => e.t === 'edit')
  const from = checkedEdits.get(ctx.sessionId) ?? 0
  checkedEdits.set(ctx.sessionId, edits.length)
  const files = [...new Set(edits.slice(from).flatMap((e) => (e.t === 'edit' ? [e.file] : [])))].slice(0, 5)
  const notes: string[] = []
  for (const rel of files) {
    const now = await fs.readFile(path.join(cwd, rel), 'utf8').catch(() => null)
    if (now === null) continue
    const base = await ctx.sessions.baseContent(ctx.sessionId, rel).catch(() => '')
    notes.push(await typeNote(cwd, rel, base ? base.replace(/\r\n/g, '\n') : null, now.replace(/\r\n/g, '\n')))
  }
  return notes.join('')
}

/** Run a tool, then tell the agent about stale reads and type errors its own edits introduced. */
export async function runTool(t: ToolDef, args: unknown, ctx: ToolContext): Promise<string> {
  const out = await t.run(args as never, ctx)
  const cwd = ctx.sessions.get(ctx.sessionId)?.root ?? ctx.ws.root
  const stale = await staleFor(ctx.sessionId, cwd)
  // Viber's own edit tools report type errors themselves; skip their edits here.
  const own = t.builtinOnly || t.name === 'replace_symbol' ? (checkedEdits.set(ctx.sessionId, ctx.sessions.get(ctx.sessionId)?.events.filter((e) => e.t === 'edit').length ?? 0), '') : await typeNotesForOwnEdits(ctx, cwd)
  return `${out}${own ? `\n${own}` : ''}${stale.length ? `\n\n[Viber] Changed by someone else since you read them: ${stale.join(', ')}. Re-read them before editing.` : ''}`
}

async function lines(ws: Workspace, cwd: string, rel: string, from: number, to: number, sessionId?: string): Promise<string[]> {
  const abs = path.join(cwd, rel)
  const text = await fs.readFile(abs, 'utf8').catch(() => ws.readFile(rel))
  if (sessionId) await track(sessionId, abs)
  return text.split('\n').slice(from - 1, to)
}

/** Wait one round for whatever the session is waiting on, and say what the human decided. */
async function waitRound(ctx: ToolContext): Promise<string> {
  const open = ctx.sessions.openGates(ctx.sessionId)
  if (!open.length) return 'Nothing is waiting for the human.'
  const results = await Promise.race(open.map((g) => ctx.sessions.waitGate<unknown>(ctx.sessionId, g.key).then((v) => (v === undefined ? null : { key: g.key, v }))))
  if (!results) {
    const still = ctx.sessions.openGates(ctx.sessionId).map((g) => g.label)
    return `The human has not decided yet on ${still.join(', ')}. Call wait_for_human to keep waiting. Do not edit code until then.`
  }
  const { key, v } = results
  if (key === 'plan') {
    const d = v as { approved: boolean; feedback?: string }
    const fence = ctx.sessions.get(ctx.sessionId)?.fence ?? []
    return d.approved ? `approved. Stay within these boxes: ${fence.join(', ')}. Edits elsewhere will be flagged to the user.` : `rejected${d.feedback ? `: ${d.feedback}` : ''}. Revise the plan and call propose_plan again.`
  }
  if (key.startsWith('question:')) return `The human answered: ${String(v)}`
  if (key.startsWith('acp:')) {
    const d = v as { approved: boolean; feedback?: string }
    return d.approved ? 'Contract change approved. Implement it; consumers will be updated separately.' : `Contract change rejected${d.feedback ? `: ${d.feedback}` : ''}. Keep the current contract and find another way.`
  }
  return String(v)
}

/** Refuse a write that would leave a file unparseable (when it parsed before). Returns the refusal, or null. */
export async function syntaxGuard(rel: string, before: string | null, after: string): Promise<string | null> {
  const errs = await syntaxErrors(rel, after)
  if (!errs?.length) return null
  if (before !== null && ((await syntaxErrors(rel, before))?.length ?? 0) > 0) return null // already broken: don't block repairs
  const lines = after.split('\n')
  const where = errs.map((e) => `line ${e.line}:${e.col} ${e.what}\n    ${(lines[e.line - 1] ?? '').trim().slice(0, 120)}`).join('\n')
  return `Not written: ${rel} would not parse after this change. The file is unchanged.\n${where}\nFix the code (check brackets, indentation, quotes) and try again.`
}

function safePath(cwd: string, rel: string): string {
  const abs = path.resolve(cwd, rel)
  if (!abs.startsWith(path.resolve(cwd))) throw new Error(`Path is outside the workspace: ${rel}`)
  return abs
}

/** Small local models sometimes double-escape code in tool JSON (a literal backslash-n instead of a newline). */
function unescapeIfDoubleEscaped(code: string): string {
  if (code.includes('\n') || !code.includes('\\n')) return code
  return code.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"')
}

const inFence = (ctx: ToolContext, nodeId: string | null): boolean => {
  const s = ctx.sessions.get(ctx.sessionId)
  const m = ctx.ws.built?.model
  if (!s || !m || !s.fence.length || !nodeId) return true
  return s.fence.some((f) => f === nodeId || isDescendant(m, nodeId, f) || isDescendant(m, f, nodeId))
}

export const TOOLS: ToolDef[] = [
  def({
    name: 'arch_overview',
    description:
      'Start here. The architecture of this repo as a compact map: actors (who uses it), boxes (modules) with their purpose, external services, dependencies between boxes and guardrails. Much cheaper than exploring files. zoom 1=system, 2=services (default), 3=components.',
    shape: { zoom: z.number().int().min(1).max(3).optional() },
    run: async ({ zoom }, ctx) => (ctx.ws.built ? overviewText(ctx.ws.built.model, zoom ?? 2) : 'Model not loaded yet.')
  }),
  def({
    name: 'arch_box',
    description:
      'Everything about one box: purpose, rules you must follow, files, routes, public symbols (signatures only), who uses it and what it depends on (with contracts), tests. Accepts a box id or label.',
    shape: { id: z.string().describe('Box id or label, e.g. "server/auth" or "Auth"') },
    run: async ({ id }, ctx) => boxText(ctx.ws, id)
  }),
  def({
    name: 'code_symbol',
    description:
      'Read one function/class/type instead of a whole file. detail: "signature" (default, cheapest), "body" (its source), or "body_with_deps" (source plus signatures of what it calls).',
    shape: {
      name: z.string(),
      file: z.string().optional().describe('Disambiguate when several symbols share a name'),
      detail: z.enum(['signature', 'body', 'body_with_deps']).optional()
    },
    run: async ({ name, file, detail }, ctx) => {
      const hits = findSymbols(ctx.ws, name, file)
      if (!hits.length) return `No symbol "${name}"${file ? ` in ${file}` : ''}. Try code_find.`
      const cwd = ctx.sessions.get(ctx.sessionId)?.root ?? ctx.ws.root
      const d = detail ?? 'signature'
      if (d === 'signature' || hits.length > 1) {
        const list = hits.slice(0, 8).map((s) => `${s.signature}  [${s.file}:${s.line}${s.endLine ? '-' + s.endLine : ''}]${s.exported ? '' : ' (internal)'}`)
        return (hits.length > 1 && d !== 'signature' ? `${hits.length} symbols named "${name}"; pass file to pick one:\n` : '') + list.join('\n')
      }
      const s = hits[0]
      const start = s.line ?? 1
      const end = s.endLine ?? start + 40
      let body = await lines(ctx.ws, cwd, s.file, start, end, ctx.sessionId)
      let note = ''
      if (body.length > 120) {
        // Long bodies: head + an outline of nested definitions with line numbers, instead of everything.
        const nested = body
          .map((l, i) => ({ l, n: start + i }))
          .filter(({ l }, i) => i > 0 && /^\s+(async\s+)?(def|function|class|const \w+ = (async )?\(|@\w+\.(get|post|put|patch|delete|route))/.test(l))
          .map(({ l, n }) => `//   ${n}: ${l.trim().slice(0, 100)}`)
        note = `\n// … ${body.length - 60} more lines (${start + 60}-${end}). Inside:\n${nested.slice(0, 40).join('\n')}\n// Use read_file with start_line/end_line for a part, or edit by anchoring on a unique nearby line.`
        body = body.slice(0, 60)
      }
      let out = `// ${s.file}:${start}-${end}\n${body.join('\n')}${note}`
      if (d === 'body_with_deps') {
        const idents = new Set(body.join('\n').match(/\b[A-Za-z_$][\w$]{2,}\b/g) ?? [])
        const deps: string[] = []
        for (const f of ctx.ws.allFiles()) {
          for (const x of f.symbols) {
            if (x.name !== s.name && x.exported && idents.has(x.name) && deps.length < 15) deps.push(`${x.signature}  [${x.file}:${x.line}]`)
          }
        }
        if (deps.length) out += `\n\n// Uses:\n${deps.map((x) => '// ' + x).join('\n')}`
      }
      return out
    }
  }),
  def({
    name: 'code_find',
    description: 'Search boxes, routes, symbols and file paths by keywords. Returns ids and locations, not file contents.',
    shape: { query: z.string() },
    run: async ({ query }, ctx) => {
      const hits = ctx.ws.search(query, 25)
      if (!hits.length) return 'No matches. Try other keywords, or arch_overview.'
      return hits.map((h) => `${h.kind}: ${h.title}${h.detail ? ` — ${h.detail.slice(0, 120)}` : ''}${h.file ? `  [${h.file}${h.line ? ':' + h.line : ''}]` : ''}${h.nodeId ? `  (box ${h.nodeId})` : ''}`).join('\n')
    }
  }),
  def({
    name: 'where_to_change',
    description:
      'Best first call for a task: ranks the files and functions most likely to need editing (with line ranges and reasons: names, docstrings, routes, HTTP call sites, imports, files that usually change together). Read those, then edit.',
    shape: { task: z.string().describe('The change you want to make, in plain words; include routes or names if you know them'), scope: z.array(z.string()).optional() },
    run: async ({ task, scope }, ctx) => predictionsText(whereToChange(ctx.ws, task, { scope: scope ?? ctx.sessions.get(ctx.sessionId)?.info.scope }))
  }),
  def({
    name: 'find_usages',
    description:
      'Every definition and use of a route (e.g. "/api/voice/tts" or "POST /api/orders") or a symbol name, across all boxes and languages: server handlers, client call sites, importers, exact lines. Use it before renaming or changing a contract so no side is missed.',
    shape: { target: z.string() },
    run: async ({ target }, ctx) => findUsages(ctx.ws, ctx.sessions.get(ctx.sessionId)?.root ?? ctx.ws.root, target)
  }),
  def({
    name: 'read_symbols',
    description: 'Read several functions/classes in one call (bodies, long ones outlined). Cheaper than one call per symbol. Pass names, optionally as "file#name".',
    shape: { names: z.array(z.string()).max(8) },
    run: async ({ names }, ctx) => {
      const tool = TOOLS.find((t) => t.name === 'code_symbol')!
      const parts: string[] = []
      for (const n of names) {
        const [file, name] = n.includes('#') ? n.split('#') : [undefined, n]
        parts.push(await tool.run({ name, file, detail: 'body' } as never, ctx))
      }
      return parts.join('\n\n')
    }
  }),
  def({
    name: 'replace_symbol',
    description:
      'Replace a whole function/class/method by name with new code (no exact-string matching needed). The new code must be the complete definition, including its signature and decorators if any.',
    shape: { name: z.string(), file: z.string().optional(), code: z.string() },
    run: async ({ name, file, code }, ctx) => {
      const hits = findSymbols(ctx.ws, name, file)
      if (hits.length !== 1) return hits.length ? `${hits.length} symbols named ${name}; pass file.` : `No symbol ${name}.`
      const s = hits[0]
      if (!s.line || !s.endLine) return `No line range known for ${name}; use edit_file.`
      const cwd = ctx.sessions.get(ctx.sessionId)?.root ?? ctx.ws.root
      const abs = safePath(cwd, s.file)
      const raw = await fs.readFile(abs, 'utf8')
      const crlf = raw.includes('\r\n')
      const lines = raw.replace(/\r\n/g, '\n').split('\n')
      // Include decorators directly above (Python @route, TS decorators) in the replaced range.
      let start = s.line - 1
      while (start > 0 && /^\s*@/.test(lines[start - 1])) start--
      const body = unescapeIfDoubleEscaped(code).replace(/\r\n/g, '\n').replace(/\n$/, '')
      lines.splice(start, s.endLine - start, ...body.split('\n'))
      const next = lines.join('\n')
      const refused = await syntaxGuard(s.file, raw.replace(/\r\n/g, '\n'), next)
      if (refused) return refused
      await fs.writeFile(abs, crlf ? next.replace(/\n/g, '\r\n') : next)
      await track(ctx.sessionId, abs)
      const owner = ctx.ws.ownerOfFile(s.file)
      return `Replaced ${name} in ${s.file} (lines ${start + 1}-${s.endLine} → ${body.split('\n').length} lines).${owner && !inFence(ctx, owner) ? ' Warning: outside the approved fence.' : ''}${await typeNote(cwd, s.file, raw.replace(/\r\n/g, '\n'), next)}`
    }
  }),
  def({
    name: 'code_impact',
    description: 'What would be affected by changing a file, symbol or box: dependent files, boxes and the tests to run.',
    shape: { target: z.string().describe('File path, symbol name or box id') },
    run: async ({ target }, ctx) => {
      const r = ctx.ws.impact(target)
      return [
        `Affected boxes (${r.boxes.length}): ${r.boxes.join(', ') || '—'}`,
        `Dependent files (${r.files.length}): ${r.files.slice(0, 30).join(', ') || '—'}`,
        `Tests to run (${r.tests.length}): ${r.tests.slice(0, 30).join(', ') || '—'}`
      ].join('\n')
    }
  }),
  def({
    name: 'announce_intent',
    description: 'Call before editing: say which boxes you are about to change and why. The user sees them light up on the map.',
    shape: { boxes: z.array(z.string()).describe('Box ids or labels'), summary: z.string() },
    run: async ({ boxes, summary }, ctx) => {
      const m = ctx.ws.built?.model
      const ids = boxes.map((b) => (m ? resolveNode(m, b)?.id : undefined) ?? b)
      ctx.sessions.push(ctx.sessionId, { t: 'intent', agent: ctx.sessions.get(ctx.sessionId)?.info.agent === 'builtin' ? 'Viber agent' : 'Agent', nodes: ids, summary, tokens: 0, naive: 0 })
      return `Noted. Boxes highlighted: ${ids.join(', ')}. Next: propose_plan before editing.`
    }
  }),
  def({
    name: 'propose_plan',
    description:
      'Propose your plan as a diagram diff and WAIT for the user to approve it before editing. List the steps, the existing boxes you will change, new boxes you will create (with their folder), and contract changes between boxes. Returns "approved" or the user\'s feedback.',
    shape: {
      steps: z.array(z.string()),
      boxes: z.array(z.string()).describe('Existing box ids you will edit'),
      new_boxes: z.array(z.object({ label: z.string(), path: z.string().describe('Folder or file the new box owns'), parent: z.string().optional(), purpose: z.string().optional() })).optional(),
      contract_changes: z
        .array(z.object({ from: z.string(), to: z.string(), added: z.array(z.string()).optional(), removed: z.array(z.string()).optional() }))
        .optional()
    },
    run: async ({ steps, boxes, new_boxes, contract_changes }, ctx) => {
      const m = ctx.ws.built?.model
      const resolve = (b: string): string => (m ? resolveNode(m, b)?.id : undefined) ?? b
      const addNodes: ArchNode[] = (new_boxes ?? []).map((b) => ({
        id: b.path.replace(/\/$/, ''),
        label: b.label || humanize(path.posix.basename(b.path)),
        kind: 'box',
        parent: b.parent ? resolve(b.parent) : (ctx.ws.ownerOfFile(b.path + '/x') ?? undefined),
        purpose: b.purpose ?? 'Planned by the agent.',
        files: [],
        paths: [b.path.replace(/\/$/, '')],
        symbols: []
      }))
      const addEdges: ArchEdge[] = []
      const edgeChanges: Record<string, ContractChange> = {}
      for (const c of contract_changes ?? []) {
        const from = resolve(c.from)
        const to = resolve(c.to)
        const id = `${from}->${to}`
        if (!m?.edges.some((e) => e.id === id)) addEdges.push({ id, source: from, target: to, kind: 'call', label: (c.added ?? [])[0]?.slice(0, 28) ?? 'new', contract: c.added ?? [] })
        edgeChanges[id] = { added: c.added ?? [], removed: c.removed ?? [] }
      }
      // New components that nobody talks to aren't an architecture: send the plan back before the human sees it.
      if (addNodes.length >= 2) {
        const linked = new Set((contract_changes ?? []).flatMap((c) => [resolve(c.from), resolve(c.to)]))
        const lonely = addNodes.filter((n) => !linked.has(n.id) && !m?.edges.some((e) => e.source === n.id || e.target === n.id))
        if (lonely.length)
          return `Plan not shown to the human yet: these new boxes are not connected to anything: ${lonely.map((n) => n.label).join(', ')}. Add contract_changes saying how they talk (from, to, and the contract items that cross: endpoints, events, functions, with their data), then call propose_plan again.`
      }
      const fence = [...new Set([...boxes.map(resolve), ...addNodes.map((n) => n.id)])]
      const text = JSON.stringify({ steps, boxes, new_boxes, contract_changes })
      // The plan is also the intent: light up the boxes without a separate call.
      if (!ctx.sessions.get(ctx.sessionId)?.events.some((e) => e.t === 'intent'))
        ctx.sessions.push(ctx.sessionId, { t: 'intent', agent: 'Agent', nodes: boxes.map(resolve), summary: steps[0] ?? 'Planned change', tokens: 0, naive: 0 })
      ctx.sessions.push(ctx.sessionId, { t: 'plan', steps, addNodes, addEdges, edgeChanges, fence, tokens: estimateTokens(text), naive: 0 })
      ctx.sessions.push(ctx.sessionId, { t: 'approval', tokens: 0, naive: 0 })
      if (ctx.sessions.get(ctx.sessionId)?.autoApprove) return `approved. Stay within these boxes: ${fence.join(', ')}. Edits elsewhere will be flagged to the user.`
      ctx.sessions.get(ctx.sessionId)!.fence = fence
      ctx.sessions.openGate(ctx.sessionId, 'plan', 'your plan')
      return await waitRound(ctx)
    }
  }),
  def({
    name: 'wait_for_human',
    description: 'Keep waiting for the human to decide on your pending plan, question or contract change (call it when a tool said the human has not decided yet). Do not edit code while waiting.',
    shape: {},
    run: async (_args, ctx) => waitRound(ctx)
  }),
  def({
    name: 'check_fence',
    description: 'Check whether editing a path is inside the approved plan (fence) before touching it.',
    shape: { path: z.string() },
    run: async ({ path: p }, ctx) => {
      const owner = ctx.ws.ownerOfFile(p)
      if (!owner) return `${p} belongs to no box yet; it will be shown as a new box candidate.`
      return inFence(ctx, owner) ? `OK: ${p} is in box ${owner}, inside the fence.` : `OUTSIDE the fence: ${p} is in box ${owner}. Do not edit it unless the user agrees.`
    }
  }),
  def({
    name: 'ask_human',
    description:
      'Ask the human a question about direction (not code): a product choice, a contract, an ambiguity in the spec. Pin it on a box id. Blocks until answered (up to 15 min). Do not ask what you can find in the code or the spec.',
    shape: { question: z.string(), box: z.string().optional(), options: z.array(z.string()).max(5).optional() },
    run: async ({ question, box, options }, ctx) => {
      const s = ctx.sessions.get(ctx.sessionId)
      const m = ctx.ws.built?.model
      const anchor = box && m ? (resolveNode(m, box)?.id ?? box) : undefined
      // Fully autonomous sessions (benchmarks, autonomy "auto") don't wait on a human.
      if (s?.autoApprove) {
        await askQuestion({ text: question, anchor, options, sessionId: ctx.sessionId })
        return 'No human is waiting on this session: make the most reasonable choice, then call record_decision so the human can review it.'
      }
      const r = await askQuestion({ text: question, anchor, options, sessionId: ctx.sessionId })
      ctx.sessions.openGate(ctx.sessionId, `question:${r.question.id}`, `your question "${question.slice(0, 60)}"`)
      return await waitRound(ctx)
    }
  }),
  def({
    name: 'propose_contract_change',
    description:
      'Contracts belong to the human. If you cannot do the task without changing what a box offers (add/remove an endpoint, event, function or field), propose it here and WAIT for approval. Do not change a contract any other way. box = the provider whose contract changes; consumer = the box that needs it.',
    shape: {
      box: z.string(),
      consumer: z.string().optional(),
      add: z.array(z.string()).optional().describe('New contract items, e.g. "POST /api/irrigation/skip", "event: irrigation.skipped", "skip_day(zone, reason)"'),
      remove: z.array(z.string()).optional(),
      reason: z.string()
    },
    run: async ({ box, consumer, add, remove, reason }, ctx) => {
      const m = ctx.ws.built?.model
      const resolve = (b: string): string => (m ? (resolveNode(m, b)?.id ?? b) : b)
      const s = ctx.sessions.get(ctx.sessionId)
      const r = await proposeAcp({ box: resolve(box), consumer: consumer ? resolve(consumer) : undefined, add: add ?? [], remove: remove ?? [], reason, sessionId: ctx.sessionId, wait: false })
      if (s?.autoApprove) return 'Proposal recorded for the human; nobody is reviewing this session live, so do NOT change the contract: work within the current one, or stop and explain.'
      ctx.sessions.openGate(ctx.sessionId, `acp:${r.acp.id}`, `your contract change on ${resolve(box)}`)
      return await waitRound(ctx)
    }
  }),
  def({
    name: 'record_decision',
    description: 'Record a design decision you made on a box (what and why, one or two sentences). It is shown to the human on the map and kept with the box spec.',
    shape: { box: z.string(), decision: z.string() },
    run: async ({ box, decision }, ctx) => {
      const m = ctx.ws.built?.model
      const id = m ? (resolveNode(m, box)?.id ?? box) : box
      const def = ctx.ws.defs.boxes.find((b) => b.id === id)
      if (!def) return `Unknown box ${box}.`
      const decisions = [...(def.spec?.decisions ?? []), { date: new Date().toISOString().slice(0, 10), text: decision }]
      await ctx.ws.apply({ op: 'setSpec', id, spec: { decisions } })
      ctx.sessions.push(ctx.sessionId, { t: 'message', role: 'system', text: `Decision on ${def.label}: ${decision}`, tokens: 0, naive: 0 })
      return 'Recorded.'
    }
  }),
  def({
    name: 'locate_bug',
    description: 'Map a stack trace, error message or failing test output to the boxes, files and symbols involved.',
    shape: { text: z.string() },
    run: async ({ text }, ctx) => {
      const r = await ctx.ws.locate(text)
      return [r.summary, ...r.hits.slice(0, 10).map((h) => `- ${h.nodeId}: ${h.file}${h.line ? ':' + h.line : ''}${h.symbol ? ` (${h.symbol})` : ''} — ${h.reason}`)].join('\n')
    }
  }),

  // ── File tools for the built-in agent ─────────────────────────────────────────────────
  def({
    name: 'read_file',
    description: 'Read part of a file by line range (max 400 lines per call). Prefer code_symbol for single functions.',
    builtinOnly: true,
    shape: { path: z.string(), start_line: z.number().int().optional(), end_line: z.number().int().optional() },
    run: async ({ path: p, start_line, end_line }, ctx) => {
      const cwd = ctx.sessions.get(ctx.sessionId)?.root ?? ctx.ws.root
      const text = (await fs.readFile(safePath(cwd, p), 'utf8')).replace(/\r\n/g, '\n')
      await track(ctx.sessionId, safePath(cwd, p))
      const all = text.split('\n')
      const from = Math.max(1, start_line ?? 1)
      const to = Math.min(all.length, end_line ?? from + 399, from + 399)
      const body = all.slice(from - 1, to).map((l, i) => `${String(from + i).padStart(4)}| ${l}`).join('\n')
      return `${p} (lines ${from}-${to} of ${all.length})\n${body}`
    }
  }),
  def({
    name: 'list_dir',
    description: 'List a directory (non-recursive).',
    builtinOnly: true,
    shape: { path: z.string() },
    run: async ({ path: p }, ctx) => {
      const cwd = ctx.sessions.get(ctx.sessionId)?.root ?? ctx.ws.root
      const entries = await fs.readdir(safePath(cwd, p || '.'), { withFileTypes: true })
      return entries
        .filter((e) => !['node_modules', '.git'].includes(e.name))
        .map((e) => (e.isDirectory() ? e.name + '/' : e.name))
        .join('\n')
    }
  }),
  def({
    name: 'write_file',
    description: 'Create or overwrite a file with the given content.',
    builtinOnly: true,
    shape: { path: z.string(), content: z.string() },
    run: async ({ path: p, content }, ctx) => {
      const cwd = ctx.sessions.get(ctx.sessionId)?.root ?? ctx.ws.root
      const abs = safePath(cwd, p)
      await fs.mkdir(path.dirname(abs), { recursive: true })
      content = unescapeIfDoubleEscaped(content)
      const before = await fs.readFile(abs, 'utf8').then((t) => t.replace(/\r\n/g, '\n'), () => null)
      const refused = await syntaxGuard(p, before, content.replace(/\r\n/g, '\n'))
      if (refused) return refused
      await fs.writeFile(abs, content)
      await track(ctx.sessionId, abs)
      const owner = ctx.ws.ownerOfFile(p)
      return `Wrote ${p} (${content.split('\n').length} lines).${owner && !inFence(ctx, owner) ? ' Warning: this is outside the approved fence.' : ''}${await typeNote(cwd, p, before, content.replace(/\r\n/g, '\n'))}`
    }
  }),
  def({
    name: 'edit_file',
    description: 'Replace one exact, unique occurrence of old_string with new_string in a file.',
    builtinOnly: true,
    shape: { path: z.string(), old_string: z.string(), new_string: z.string() },
    run: async ({ path: p, old_string, new_string }, ctx) => {
      const cwd = ctx.sessions.get(ctx.sessionId)?.root ?? ctx.ws.root
      const abs = safePath(cwd, p)
      // Match on LF-normalised text and keep the file's own line endings when writing back.
      const raw = await fs.readFile(abs, 'utf8')
      const crlf = raw.includes('\r\n')
      const text = raw.replace(/\r\n/g, '\n')
      const oldS = unescapeIfDoubleEscaped(old_string).replace(/\r\n/g, '\n')
      const count = text.split(oldS).length - 1
      if (count === 0) return `old_string not found in ${p}. Read the exact text first (code_symbol or read_file).`
      if (count > 1) return `old_string appears ${count} times in ${p}; include more context to make it unique.`
      const next = text.replace(oldS, () => unescapeIfDoubleEscaped(new_string).replace(/\r\n/g, '\n'))
      const refused = await syntaxGuard(p, text, next)
      if (refused) return refused
      await fs.writeFile(abs, crlf ? next.replace(/\n/g, '\r\n') : next)
      await track(ctx.sessionId, abs)
      const owner = ctx.ws.ownerOfFile(p)
      return `Edited ${p}.${owner && !inFence(ctx, owner) ? ' Warning: this is outside the approved fence.' : ''}${await typeNote(cwd, p, text, next)}`
    }
  }),
  def({
    name: 'grep',
    description: 'Search file contents in the repo for a regular expression. Returns matching lines as path:line: text (max 80).',
    builtinOnly: true,
    shape: { pattern: z.string(), path: z.string().optional().describe('Limit to files under this folder') },
    run: async ({ pattern, path: under }, ctx) => {
      const cwd = ctx.sessions.get(ctx.sessionId)?.root ?? ctx.ws.root
      let re: RegExp
      try {
        re = new RegExp(pattern, 'i')
      } catch {
        return `Invalid regular expression: ${pattern}`
      }
      const hits: string[] = []
      for (const f of ctx.ws.allFiles()) {
        if (under && !f.path.startsWith(under.replace(/^\.\//, ''))) continue
        const text = await fs.readFile(path.join(cwd, f.path), 'utf8').catch(() => '')
        const lines = text.split('\n')
        for (let i = 0; i < lines.length && hits.length < 80; i++) if (re.test(lines[i])) hits.push(`${f.path}:${i + 1}: ${lines[i].trim().slice(0, 160)}`)
        if (hits.length >= 80) break
      }
      return hits.length ? hits.join('\n') : 'No matches.'
    }
  }),
  def({
    name: 'run_command',
    description: 'Run a shell command in the repo (only commands the user allowed in Settings, e.g. the test runner). Returns the last 4000 characters of output.',
    builtinOnly: true,
    shape: { command: z.string() },
    run: async ({ command }, ctx) => {
      if (!ctx.allowedCommands.some((p) => p && command.trim().startsWith(p))) {
        return `Not allowed: "${command}". Allowed prefixes: ${ctx.allowedCommands.join(', ') || 'none'}. Ask the user to allow it in Settings.`
      }
      const cwd = ctx.sessions.get(ctx.sessionId)?.root ?? ctx.ws.root
      ctx.sessions.push(ctx.sessionId, { t: 'tool', name: 'run_command', detail: command, tokens: 0, naive: 0 })
      return new Promise((resolve) =>
        exec(command, { cwd, timeout: 5 * 60_000, maxBuffer: 20 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
          const out = (stdout + '\n' + stderr).trim()
          resolve(`exit ${err ? (err.code ?? 1) : 0}\n${out.slice(-4000)}`)
        })
      )
    }
  })
]

export const toolByName = new Map(TOOLS.map((t) => [t.name, t]))

/** Instructions given to any agent working through Viber. */
export function agentInstructions(ws: Workspace, scope: string[]): string {
  const m = ws.built?.model
  const rules = scope.flatMap((id) => {
    const n = m ? resolveNode(m, id) : undefined
    return n?.rules?.map((r) => `- [${n.label}] ${r}`) ?? []
  })
  const guard = (m?.guardrails ?? []).map((g) => `- ${g.from} must never depend on ${g.to}${g.reason ? ` (${g.reason})` : ''}`)
  return [
    'You are working inside Viber, a visual IDE that shows the user an architecture map of this repo and lights up boxes as files change.',
    'Workflow:',
    '1. The likely edit sites are listed under <targets>: start there. Need more? where_to_change (ranked edit sites), find_usages (every caller of a route/symbol, before changing a contract), read_symbols (several bodies in one call). Avoid reading whole files.',
    '2. Call propose_plan (steps, boxes to change, new boxes with their folder, contract changes) and WAIT for approval before editing. If it says the human has not decided yet, call wait_for_human (repeat as needed). Keep it short for small changes.',
    '3. Edit only inside the approved boxes (replace_symbol rewrites a whole function by name). If you must go outside, say so and propose an updated plan. Never change what a box offers (its contract) without propose_contract_change.',
    '4. Run the tests code_impact suggests, then summarise what changed per box.',
    scope.length ? `The user scoped this task to: ${scope.join(', ')}.` : '',
    rules.length ? 'Rules for boxes in scope (must follow):\n' + rules.join('\n') : '',
    guard.length ? 'Guardrails (never add these dependencies):\n' + guard.join('\n') : ''
  ]
    .filter(Boolean)
    .join('\n')
}
