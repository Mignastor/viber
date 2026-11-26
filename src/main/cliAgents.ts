import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'child_process'
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import type { StartSessionInput } from '@shared/api'
import { ctx } from './context'
import type { buildContextPack } from './contextPack'
import { mcpUrl } from './mcp'
import { getSettings } from './settings'
import { TOOLS } from './tools'

// Coding-agent CLIs that sign in with a subscription (ChatGPT for Codex, a Google account for Gemini),
// driven headless like Claude Code: the task goes in on stdin, events come back as JSON lines, and
// Viber's tools are attached over MCP.

type Pack = Awaited<ReturnType<typeof buildContextPack>>

export type CliId = 'claude-code' | 'codex' | 'gemini'

/** CLIs whose last request failed on sign-in (credentials on disk can be expired). */
export const signInFailed = new Set<CliId>()

export async function resolveExecutable(name: string): Promise<string> {
  if (path.isAbsolute(name)) return name
  const finder = process.platform === 'win32' ? 'where' : 'which'
  return new Promise((resolve) =>
    execFile(finder, [name], { windowsHide: true }, (err, stdout) => {
      const hits = stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
      // Prefer a real executable over a .cmd shim on Windows (no shell quoting needed).
      resolve(err || !hits.length ? name : (hits.find((h) => h.endsWith('.exe')) ?? hits.find((h) => h.endsWith('.cmd')) ?? hits[0]))
    })
  )
}

/** Spawn a CLI (npm shims on Windows need a shell, so quote arguments for it). */
export async function spawnCli(name: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = {}): Promise<ChildProcessWithoutNullStreams> {
  const exe = await resolveExecutable(name)
  const useShell = process.platform === 'win32' && !exe.toLowerCase().endsWith('.exe')
  const quote = (a: string): string => (a === '' ? '""' : /[\s()*"&|<>^=]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)
  return spawn(useShell ? `"${exe}"` : exe, useShell ? args.map(quote) : args, { cwd, shell: useShell, windowsHide: true, env: { ...process.env, ...env } })
}

/** The prompt every headless agent gets: Viber's instructions, the map, the scope and the task. */
export function agentPrompt(input: StartSessionInput, pack: Pack, instructions: string): string {
  return input.baseline
    ? input.prompt
    : [instructions, '', '<architecture>', pack.overview, '</architecture>', pack.text ? `\n<scope>\n${pack.text}\n</scope>` : '', '', `Task: ${input.prompt}`].join('\n')
}

/** Read JSON lines from a child process until it exits. */
async function readJsonLines(child: ChildProcessWithoutNullStreams, onEvent: (ev: any) => void): Promise<{ code: number; stderr: string }> {
  let buf = ''
  let stderr = ''
  child.stderr.on('data', (d) => (stderr += d))
  child.stdout.on('data', (d: Buffer) => {
    buf += d.toString('utf8')
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line.startsWith('{')) continue
      try {
        onEvent(JSON.parse(line))
      } catch {
        /* not an event line */
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
  return { code, stderr }
}

// Only the tools Viber serves over MCP (the built-in agent's file tools share names with the CLIs' own).
const VIBER_TOOLS = new Set(TOOLS.filter((t) => !t.builtinOnly).map((t) => t.name))
const isViberTool = (name: string): boolean => VIBER_TOOLS.has(name) || /(^|[_.])viber([_.]|$)/.test(name) || [...VIBER_TOOLS].some((t) => name.endsWith(`__${t}`) || name.endsWith(`.${t}`))
const signInHint = (text: string, cli: string, how: string): string | null =>
  /not (logged|signed) in|login|log in|authenticat|unauthori[sz]ed|401|credentials|api key/i.test(text) ? `${cli} is not signed in. Open "Connect agents" (plug icon) and press Sign in${how ? ` (or run ${how} in a terminal)` : ''}, then try again. (${text.trim().slice(0, 200)})` : null

// ── OpenAI Codex CLI (signs in with a ChatGPT plan or an API key) ─────────────────────────────

export async function runCodex(sessionId: string, input: StartSessionInput, pack: Pack, instructions: string): Promise<string> {
  const sm = ctx.sessions!
  const s = sm.get(sessionId)!
  const settings = await getSettings()
  const args = ['exec', '--json', '--skip-git-repo-check', '-C', s.root, '-s', 'workspace-write', '--color', 'never']
  if (!input.baseline) args.push('-c', `mcp_servers.viber.url="${mcpUrl(sessionId)}"`)
  if (input.model) args.push('-m', input.model)
  args.push('-')
  const child = await spawnCli(settings.codexPath, args, s.root)
  s.stop = () => child.kill()
  child.stdin.write(agentPrompt(input, pack, instructions))
  child.stdin.end()

  let summary = ''
  let failed = ''
  const { code, stderr } = await readJsonLines(child, (ev) => {
    if (ev.type === 'item.completed' && ev.item) {
      const it = ev.item
      if (it.type === 'agent_message' && it.text?.trim()) {
        summary = it.text.trim()
        sm.push(sessionId, { t: 'message', role: 'agent', text: summary, tokens: 0, naive: 0 })
      } else if (it.type === 'command_execution') sm.push(sessionId, { t: 'tool', name: 'shell', detail: String(it.command ?? '').slice(0, 120), tokens: 0, naive: 0 })
      else if (it.type === 'file_change') sm.push(sessionId, { t: 'tool', name: 'edit', detail: (it.changes ?? []).map((c: { path?: string }) => c.path).filter(Boolean).join(', ').slice(0, 120), tokens: 0, naive: 0 })
      else if (it.type === 'mcp_tool_call' && it.server !== 'viber') sm.push(sessionId, { t: 'tool', name: `${it.server}.${it.tool}`, detail: '', tokens: 0, naive: 0 })
      else if (it.type === 'error' && it.message) sm.push(sessionId, { t: 'message', role: 'system', text: String(it.message), tokens: 0, naive: 0 })
    } else if (ev.type === 'turn.completed' && ev.usage) {
      const u = ev.usage
      const cached = u.cached_input_tokens ?? 0
      sm.addUsage(sessionId, { input: Math.max(0, (u.input_tokens ?? 0) - cached), cacheRead: cached, output: (u.output_tokens ?? 0) + (u.reasoning_output_tokens ?? 0) })
    } else if (ev.type === 'turn.failed') failed = ev.error?.message ?? 'Codex stopped with an error.'
    else if (ev.type === 'error' && ev.message) failed = String(ev.message)
    else if (ev.type === 'thread.started' && !s.info.model) {
      s.info.model = input.model ?? 'codex'
      sm.emitList()
    }
  })
  if (s.info.status === 'stopped') throw new Error('stopped')
  if (failed && signInHint(failed, 'Codex', '')) signInFailed.add('codex')
  if (failed) throw new Error(signInHint(failed, 'Codex', '"codex login" (sign in with ChatGPT)') ?? failed)
  if (code !== 0) throw new Error(signInHint(stderr, 'Codex', '"codex login" (sign in with ChatGPT)') ?? `Codex exited with code ${code}. ${stderr.slice(-400) || 'Is it installed? (npm i -g @openai/codex)'}`)
  return summary.split('\n').slice(0, 6).join('\n') || 'Codex finished.'
}

// ── Google Gemini CLI (signs in with a Google account or an API key) ─────────────────────────

export async function runGemini(sessionId: string, input: StartSessionInput, pack: Pack, instructions: string): Promise<string> {
  const sm = ctx.sessions!
  const s = sm.get(sessionId)!
  const settings = await getSettings()
  // Viber's MCP server goes in a throwaway system-settings file, so nothing is written to the repo or ~/.gemini.
  const cfgFile = path.join(os.tmpdir(), `viber-gemini-${sessionId}.json`)
  await fs.writeFile(cfgFile, JSON.stringify(input.baseline ? {} : { mcpServers: { viber: { httpUrl: mcpUrl(sessionId), trust: true } } }))
  // Edits are approved automatically; shell commands are not (Viber runs the impacted tests itself).
  const args = ['-p', 'Do the task described above.', '-o', 'stream-json', '--approval-mode', 'auto_edit', '--skip-trust']
  if (input.model) args.push('-m', input.model)
  const child = await spawnCli(settings.geminiPath, args, s.root, { GEMINI_CLI_SYSTEM_SETTINGS_PATH: cfgFile })
  s.stop = () => child.kill()
  child.stdin.write(agentPrompt(input, pack, instructions))
  child.stdin.end()

  let text = ''
  let summary = ''
  let failed = ''
  const flush = (): void => {
    if (text.trim()) {
      summary = text.trim()
      sm.push(sessionId, { t: 'message', role: 'agent', text: summary, tokens: 0, naive: 0 })
    }
    text = ''
  }
  const { code, stderr } = await readJsonLines(child, (ev) => {
    if (ev.type === 'init' && ev.model) {
      s.info.model = ev.model
      sm.emitList()
    } else if (ev.type === 'message' && ev.role === 'assistant' && typeof ev.content === 'string') text += ev.content
    else if (ev.type === 'tool_use') {
      flush()
      if (!isViberTool(String(ev.tool_name))) sm.push(sessionId, { t: 'tool', name: String(ev.tool_name), detail: JSON.stringify(ev.parameters ?? {}).slice(0, 120), tokens: 0, naive: 0 })
    } else if (ev.type === 'error' && ev.message) sm.push(sessionId, { t: 'message', role: 'system', text: String(ev.message), tokens: 0, naive: 0 })
    else if (ev.type === 'result') {
      flush()
      const st = ev.stats ?? {}
      sm.addUsage(sessionId, { input: Math.max(0, (st.input_tokens ?? 0) - (st.cached ?? 0)), cacheRead: st.cached ?? 0, output: st.output_tokens ?? 0 })
      if (ev.status === 'error') failed = ev.error?.message ?? 'Gemini stopped with an error.'
    }
  })
  flush()
  await fs.rm(cfgFile, { force: true }).catch(() => {})
  if (s.info.status === 'stopped') throw new Error('stopped')
  if (failed && signInHint(failed, 'Gemini CLI', '')) signInFailed.add('gemini')
  if (failed) throw new Error(signInHint(failed, 'Gemini CLI', '"gemini" and sign in with Google') ?? failed)
  if (code !== 0) throw new Error(signInHint(stderr, 'Gemini CLI', '"gemini" and sign in with Google') ?? `Gemini CLI exited with code ${code}. ${stderr.slice(-400) || 'Is it installed? (npm i -g @google/gemini-cli)'}`)
  return summary.split('\n').slice(0, 6).join('\n') || 'Gemini finished.'
}

// ── One-shot answers (architect, descriptions, connection test) through a signed-in CLI ───────

export interface Progress {
  /** A piece of the answer as it is written. */
  text?: string
  /** What the model is doing meanwhile (thinking, a reasoning summary). */
  note?: string
}

/** Ask a CLI for a plain text answer, with no tools and nothing written to disk, streaming as it writes. */
export async function cliComplete(id: CliId, system: string, user: string, cwd: string, onProgress?: (p: Progress) => void): Promise<string> {
  const settings = await getSettings()
  const prompt = `${system}\n\n---\n\n${user}`
  let child: ChildProcessWithoutNullStreams
  if (id === 'claude-code') child = await spawnCli(settings.claudePath, ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--tools', ''], cwd, { CLAUDE_CODE_ENTRYPOINT: 'viber' })
  else if (id === 'codex') child = await spawnCli(settings.codexPath, ['exec', '--json', '--skip-git-repo-check', '--ephemeral', '-s', 'read-only', '-C', cwd, '--color', 'never', '-'], cwd)
  else child = await spawnCli(settings.geminiPath, ['-p', 'Answer the request above.', '-o', 'stream-json', '--approval-mode', 'plan', '--skip-trust'], cwd)
  child.stdin.write(prompt)
  child.stdin.end()
  const name = id === 'claude-code' ? 'Claude Code' : id === 'codex' ? 'Codex' : 'Gemini CLI'
  const how = id === 'claude-code' ? '"claude" and type /login' : id === 'codex' ? '"codex login"' : '"gemini" and sign in with Google'
  const fail = (text: string): Error => {
    const hint = signInHint(text, name, how)
    if (hint) signInFailed.add(id)
    return new Error(hint ? `NO_AGENT: ${hint}` : `${name}: ${text.trim().slice(0, 300)}`)
  }
  let text = ''
  let streamed = ''
  let failure = ''
  let gotResult = false
  const timer = setTimeout(() => child.kill(), 15 * 60_000)
  const { code, stderr } = await readJsonLines(child, (ev) => {
    if (id === 'claude-code') {
      if (ev.type === 'stream_event') {
        const d = ev.event?.delta
        if (d?.type === 'text_delta' && d.text) (streamed += d.text), onProgress?.({ text: d.text })
        else if (d?.type === 'thinking_delta') onProgress?.({ note: 'thinking' })
      } else if (ev.type === 'result') {
        gotResult = true
        text = typeof ev.result === 'string' ? ev.result : streamed
        if (ev.is_error || /failed to authenticate|oauth session expired|invalid api key|please run \/login/i.test(text)) failure = text || `stopped with an error (${String(ev.subtype ?? 'unknown')})`
      }
    } else if (id === 'codex') {
      if (ev.type === 'item.completed' && ev.item?.type === 'reasoning' && ev.item.text) onProgress?.({ note: String(ev.item.text).slice(0, 300) })
      else if (ev.type === 'item.completed' && ev.item?.type === 'agent_message') (text = ev.item.text ?? text), (gotResult = true), onProgress?.({ text })
      else if (ev.type === 'turn.failed') failure = ev.error?.message ?? 'failed'
      else if (ev.type === 'error') failure = String(ev.message ?? 'error')
    } else {
      if (ev.type === 'message' && ev.role === 'assistant' && typeof ev.content === 'string') (streamed += ev.content), onProgress?.({ text: ev.content })
      else if (ev.type === 'result') {
        gotResult = true
        text = streamed
        if (ev.status === 'error') failure = ev.error?.message ?? 'error'
      }
    }
  })
  clearTimeout(timer)
  if (!gotResult && code !== 0 && !failure && !text) {
    if (code === null || code === -1) throw new Error(`${name} could not start. ${stderr.slice(-300)}`)
    throw fail(stderr || `exited with code ${code}`)
  }
  if (failure) throw fail(failure)
  signInFailed.delete(id)
  if (!gotResult) throw new Error(`${name} stopped before answering (it may have taken more than 15 minutes).`)
  return text
}
