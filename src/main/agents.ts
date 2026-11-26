import { spawn, execFile } from 'child_process'
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import { z } from 'zod'
import type { StartSessionInput } from '@shared/api'
import { ctx } from './context'
import { buildContextPack, estimateTokens } from './contextPack'
import { TOOLS, agentInstructions, forgetSession, runTool, toolByName, type ToolContext } from './tools'
import { mcpUrl } from './mcp'
import { getSettings } from './settings'
import { createAgentProvider } from './llm'
import { runImpactedTests } from './runner'
import { whereToChange } from './targeting'
import { resolveExecutable, runCodex, runGemini, signInFailed } from './cliAgents'
import { cliStatuses } from './agentStatus'

// Starting and driving agent sessions.

export async function startSession(input: StartSessionInput): Promise<string> {
  const ws = ctx.requireWs()
  const sm = ctx.sessions!
  const title = input.prompt.split('\n')[0].slice(0, 70) || 'Untitled task'
  // No scope given: scope to the boxes of the most likely edit sites (hand-typed scopes go stale
  // when the model evolves; predictions don't).
  if (!input.baseline && !input.scope.length) {
    const boxes = [...new Set(whereToChange(ws, input.prompt, { limit: 3 }).map((p) => p.box).filter((b): b is string => !!b))]
    input = { ...input, scope: boxes.slice(0, 3) }
  }
  const s = await sm.create({ ...input, title })
  const pack = await buildContextPack(ws, input.scope, input.prompt)
  sm.push(s.id, { t: 'task', prompt: input.prompt, scope: input.scope, tokens: estimateTokens(input.prompt), naive: estimateTokens(input.prompt) })
  if (!input.baseline) sm.push(s.id, { t: 'context', items: pack.items, naiveNote: pack.naiveNote, tokens: 0, naive: pack.naive })

  const instructions = input.baseline ? BASELINE_INSTRUCTIONS : agentInstructions(ws, input.scope)
  const finish = async (summary: string, status: 'done' | 'error' | 'stopped'): Promise<void> => {
    if (status !== 'stopped') await runImpactedTests(s.id).catch(() => {})
    sm.closeGates(s.id, { approved: false, feedback: 'The session ended.' })
    sm.push(s.id, { t: 'done', summary, tokens: 0, naive: 0 })
    sm.setStatus(s.id, status)
  }

  if (input.agent === 'external') {
    sm.push(s.id, {
      t: 'message',
      role: 'system',
      text: `Waiting for your agent. Point it at ${mcpUrl(s.id)} (or the .mcp.json in the repo) and give it the prompt; Viber shows its intent, plan and every file it touches.`,
      tokens: 0,
      naive: 0
    })
    sm.setStatus(s.id, 'running')
    return s.id
  }

  const runner = input.agent === 'claude-code' ? runClaudeCode : input.agent === 'codex' ? runCodex : input.agent === 'gemini' ? runGemini : runBuiltin
  const run: typeof runner = async (...args) => {
    // Fail fast (with the way out) instead of starting a CLI that is missing or signed out.
    if (input.agent === 'claude-code' || input.agent === 'codex' || input.agent === 'gemini') {
      const st = (await cliStatuses()).find((c) => c.id === input.agent)
      if (st && !st.installed) throw new Error(`NO_AGENT: ${st.label} is not installed. Open "Connect agents" (plug icon) and press Install next to it.`)
      if (st && st.signedIn === false) throw new Error(`NO_AGENT: ${st.label} is not signed in. Open "Connect agents" (plug icon) and press Sign in next to it, then run this again.`)
    }
    return runner(...args)
  }
  void run(s.id, input, pack, instructions)
    .then((summary) => finish(summary, 'done'))
    .catch((err) => {
      const stopped = sm.get(s.id)?.info.status === 'stopped'
      sm.push(s.id, { t: 'error', text: stopped ? 'Stopped by you.' : String((err as Error)?.message ?? err), tokens: 0, naive: 0 })
      return finish(stopped ? 'Stopped.' : 'The agent stopped with an error.', stopped ? 'stopped' : 'error')
    })
  return s.id
}

/** Sessions driven by the user's own agent end when the user says so. */
export async function finishSession(id: string): Promise<void> {
  forgetSession(id)
  const sm = ctx.sessions
  const s = sm?.get(id)
  if (!sm || !s || s.info.ambient) return
  await runImpactedTests(id).catch(() => {})
  const files = new Set(s.events.flatMap((e) => (e.t === 'edit' ? [e.file] : [])))
  sm.push(id, { t: 'done', summary: `Finished: ${files.size} file${files.size === 1 ? '' : 's'} changed.`, tokens: 0, naive: 0 })
  sm.setStatus(id, 'done')
}

export function stopSession(id: string): void {
  const s = ctx.sessions?.get(id)
  if (!s) return
  s.info.status = 'stopped'
  ctx.sessions!.closeGates(id, { approved: false, feedback: 'The user stopped the session.' })
  s.stop?.()
  ctx.sessions!.emitList()
}

/** What a plain coding agent gets in a benchmark baseline: no map, no Viber tools, no context pack. */
const BASELINE_INSTRUCTIONS =
  'You are a coding agent working in this repository. Find the relevant code yourself, make the change, keep the code working, and finish with a short summary of what you changed.'

// ── Claude Code (headless) ──────────────────────────────────────────────────────────────

async function runClaudeCode(sessionId: string, input: StartSessionInput, pack: Awaited<ReturnType<typeof buildContextPack>>, instructions: string): Promise<string> {
  const sm = ctx.sessions!
  const s = sm.get(sessionId)!
  const settings = await getSettings()
  const exe = await resolveExecutable(settings.claudePath)
  const cfgFile = path.join(os.tmpdir(), `viber-mcp-${sessionId}.json`)
  await fs.writeFile(cfgFile, JSON.stringify({ mcpServers: { viber: { type: 'http', url: mcpUrl(sessionId) } } }))

  const prompt = input.baseline
    ? input.prompt
    : [instructions, '', '<architecture>', pack.overview, '</architecture>', pack.text ? `\n<scope>\n${pack.text}\n</scope>` : '', '', `Task: ${input.prompt}`].join('\n')

  const allowed = [...(input.baseline ? [] : ['mcp__viber']), ...settings.allowedCommands.map((c) => `Bash(${c}:*)`)]
  const args = ['-p', '--output-format', 'stream-json', '--verbose', ...(input.baseline ? [] : ['--mcp-config', cfgFile]), '--permission-mode', 'acceptEdits', ...(allowed.length ? ['--allowedTools', ...allowed] : [])]
  if (input.model) args.push('--model', input.model)
  const useShell = process.platform === 'win32' && !exe.toLowerCase().endsWith('.exe')
  const child = spawn(useShell ? `"${exe}"` : exe, useShell ? args.map((a) => (/[\s()*]/.test(a) ? `"${a}"` : a)) : args, {
    cwd: s.root,
    shell: useShell,
    windowsHide: true,
    env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: 'viber' }
  })
  s.stop = () => child.kill()
  child.stdin.write(prompt)
  child.stdin.end()

  let buf = ''
  let summary = ''
  let failed = ''
  let stderr = ''
  // stream-json can emit one event per content block of the same message: count usage once per message.
  const seenMessages = new Set<string>()
  child.stderr.on('data', (d) => (stderr += d))
  child.stdout.on('data', (d: Buffer) => {
    buf += d.toString('utf8')
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line) continue
      let ev: any
      try {
        ev = JSON.parse(line)
      } catch {
        continue
      }
      if (ev.type === 'system' && ev.subtype === 'init' && ev.model) {
        s.info.model = ev.model
        sm.emitList()
      } else if (ev.type === 'assistant' && ev.message?.content) {
        const fresh = !ev.message.id || !seenMessages.has(ev.message.id)
        if (ev.message.id) seenMessages.add(ev.message.id)
        const u = fresh ? ev.message.usage : undefined
        const tokens = u ? (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.output_tokens ?? 0) : 0
        if (u) sm.addUsage(sessionId, { input: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0), output: u.output_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0 })
        let first = true
        for (const b of ev.message.content) {
          if (b.type === 'text' && b.text?.trim()) sm.push(sessionId, { t: 'message', role: 'agent', text: b.text.trim(), tokens: first ? tokens : 0, naive: 0 })
          else if (b.type === 'tool_use' && !String(b.name).startsWith('mcp__viber')) sm.push(sessionId, { t: 'tool', name: b.name, detail: toolDetail(b.input), tokens: first ? tokens : 0, naive: 0 })
          else continue
          first = false
        }
      } else if (ev.type === 'result') {
        summary = typeof ev.result === 'string' ? ev.result : ''
        // Some failures (expired sign-in) come back as a normal-looking result.
        if (!ev.is_error && /failed to authenticate|oauth session expired|invalid api key|please run \/login/i.test(summary)) failed = summary
        if (ev.is_error) failed = summary || `Claude Code stopped with an error (${String(ev.subtype ?? 'unknown')}).`
        if (typeof ev.total_cost_usd === 'number') sm.addUsage(sessionId, { costUsd: ev.total_cost_usd })
      }
    }
  })
  const code: number = await new Promise((resolve) => {
    child.on('error', (e) => {
      stderr += String(e)
      resolve(-1)
    })
    child.on('close', (c) => resolve(c ?? -1))
  })
  await fs.rm(cfgFile, { force: true }).catch(() => {})
  if (s.info.status === 'stopped') throw new Error('stopped')
  if (failed && /authenticat|oauth|log ?in|api key/i.test(failed)) signInFailed.add('claude-code')
  if (failed) throw new Error(/authenticat|oauth|log ?in|api key/i.test(failed) ? `NO_AGENT: Claude Code is not signed in (${failed.replace(/[.\s]*$/, '')}). Open "Connect agents" (plug icon) and press Sign in next to Claude Code, then run this again.` : failed)
  if (code !== 0 && !summary) throw new Error(`Claude Code exited with code ${code}. ${stderr.slice(-400) || 'Is it installed and logged in? (claude --version)'}`)
  return summary.split('\n').slice(0, 6).join('\n') || 'Claude Code finished.'
}

function toolDetail(input: Record<string, unknown> | undefined): string {
  if (!input) return ''
  const p = input.file_path ?? input.path ?? input.pattern ?? input.command ?? input.url
  return typeof p === 'string' ? p.slice(0, 120) : JSON.stringify(input).slice(0, 120)
}

// ── Built-in agent (Claude via the API, or a local model via Ollama/OpenAI-compatible) ───

async function runBuiltin(sessionId: string, input: StartSessionInput, pack: Awaited<ReturnType<typeof buildContextPack>>, instructions: string): Promise<string> {
  const sm = ctx.sessions!
  const ws = ctx.requireWs()
  const s = sm.get(sessionId)!
  const settings = await getSettings()
  let stopped = false
  s.stop = () => (stopped = true)

  // Every tool definition is resent each turn: give the built-in agent only the ones that pay off.
  const LEAN = new Set(['where_to_change', 'find_usages', 'read_symbols', 'replace_symbol', 'arch_box', 'propose_plan', 'propose_contract_change', 'ask_human', 'wait_for_human', 'record_decision', 'read_file', 'edit_file', 'write_file', 'grep', 'run_command'])
  const tools = input.baseline ? TOOLS.filter((t) => t.builtinOnly) : TOOLS.filter((t) => LEAN.has(t.name))
  const caching = settings.roles.edit === 'anthropic'
  const provider = await createAgentProvider('edit', {
    // Providers without prompt caching (Ollama, vLLM, LM Studio) pay for the system prompt on every
    // turn: give them the targets and specs only; the overview stays one tool call away.
    stableSystem: input.baseline ? instructions : caching ? pack.overview : instructions,
    taskSystem: input.baseline ? '' : (caching ? instructions : '') + (pack.text ? `\n\n<scope>\n${pack.text}\n</scope>` : ''),
    tools: tools.map((t) => ({ name: t.name, description: t.description, shape: t.shape })),
    user: input.prompt,
    modelOverride: input.model
  })
  s.info.model = provider.model
  sm.emitList()
  const tc: ToolContext = { ws, sessions: sm, sessionId, allowedCommands: settings.allowedCommands }
  let spent = 0
  let lastText = ''
  let nudges = 0

  for (let turn = 0; turn < 80; turn++) {
    if (stopped) throw new Error('stopped')
    const r = await provider.step()
    const tokens = r.usage.input + r.usage.cacheRead + r.usage.output
    spent += tokens
    sm.addUsage(sessionId, r.usage)
    if (r.text.trim()) {
      lastText = r.text.trim()
      sm.push(sessionId, { t: 'message', role: 'agent', text: lastText, tokens, naive: 0 })
    } else sm.push(sessionId, { t: 'tool', name: 'thinking', detail: `${r.calls.length} tool call(s)`, tokens, naive: 0 })
    if (r.stop === 'refusal') throw new Error('The model declined this request.')
    if (r.stop === 'max_tokens') throw new Error('The model hit its output limit mid-answer.')
    if (r.stop !== 'tools') {
      // Smaller (local) models often stop to *describe* instead of acting. Nudge them twice.
      const planned = input.baseline || s.events.some((e) => e.t === 'plan')
      const edited = s.events.some((e) => e.t === 'edit')
      if (!edited && nudges < 2) {
        nudges++
        provider.addUserText(
          planned
            ? 'The plan is approved. Now make the edits with edit_file or write_file. Do not describe them; do them, then reply with a one-paragraph summary.'
            : 'Do not describe the code. Call propose_plan now with your steps and the boxes you will change, then make the edits with edit_file or write_file.'
        )
        sm.push(sessionId, { t: 'message', role: 'system', text: 'Nudged the agent to plan and act instead of describing.', tokens: 0, naive: 0 })
        continue
      }
      break
    }
    if (settings.budgetTokens && spent > settings.budgetTokens) {
      sm.push(sessionId, { t: 'error', text: `Token budget reached (${spent.toLocaleString()} > ${settings.budgetTokens.toLocaleString()}). Stopping.`, tokens: 0, naive: 0 })
      break
    }
    const results: { id: string; content: string; isError?: boolean }[] = []
    for (const call of r.calls) {
      const tool = toolByName.get(call.name)
      if (!tool) {
        results.push({ id: call.id, content: `Unknown tool ${call.name}`, isError: true })
        continue
      }
      // Streamed tool inputs are not validated server-side: check them before running.
      const parsed = z.object(tool.shape).safeParse(call.input)
      if (!parsed.success) {
        results.push({ id: call.id, content: `INVALID_INPUT: ${parsed.error.message.slice(0, 400)}`, isError: true })
        continue
      }
      if (!['announce_intent', 'propose_plan'].includes(call.name)) sm.push(sessionId, { t: 'tool', name: call.name, detail: toolDetail(parsed.data as Record<string, unknown>), tokens: 0, naive: 0 })
      try {
        results.push({ id: call.id, content: await runTool(tool, parsed.data, tc) })
      } catch (err) {
        results.push({ id: call.id, content: String((err as Error).message ?? err), isError: true })
      }
    }
    provider.addToolResults(results)
  }
  return lastText.split('\n').slice(0, 6).join('\n') || 'Done.'
}
