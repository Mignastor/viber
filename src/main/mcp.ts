import http from 'http'
import { promises as fs } from 'fs'
import path from 'path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { ctx } from './context'
import { TOOLS, runTool, type ToolContext } from './tools'
import { getSettings } from './settings'

// Local MCP server (Streamable HTTP, stateless) exposing Viber's tools to any MCP client.
// URL: http://127.0.0.1:<port>/mcp[?session=<id>]. Without a session id, calls attach to the
// most recent running agent session, else to the "Changes on disk" watcher session.

let server: http.Server | null = null
let port = 0

export function mcpUrl(sessionId?: string): string {
  return `http://127.0.0.1:${port}/mcp${sessionId ? `?session=${sessionId}` : ''}`
}

export function mcpPort(): number {
  return port
}

function sessionFor(requested: string | null): string {
  const sm = ctx.sessions
  if (!sm) return 'watch'
  if (requested && sm.get(requested)) return requested
  const running = sm.list().filter((s) => !s.ambient && (s.status === 'running' || s.status === 'waiting'))
  return running[running.length - 1]?.id ?? 'watch'
}

function buildServer(sessionId: string): McpServer {
  const mcp = new McpServer({ name: 'viber', version: '0.1.0' })
  for (const t of TOOLS) {
    if (t.builtinOnly) continue
    mcp.registerTool(t.name, { description: t.description, inputSchema: t.shape }, async (args: Record<string, unknown>) => {
      const ws = ctx.ws
      const sessions = ctx.sessions
      if (!ws || !sessions) return { content: [{ type: 'text' as const, text: 'No repository is open in Viber.' }], isError: true }
      const tc: ToolContext = { ws, sessions, sessionId, allowedCommands: (await getSettings()).allowedCommands }
      sessions.push(sessionId, { t: 'tool', name: t.name, detail: summarizeArgs(args), tokens: 0, naive: 0 })
      try {
        const text = await runTool(t, args, tc)
        return { content: [{ type: 'text' as const, text }] }
      } catch (err) {
        return { content: [{ type: 'text' as const, text: String((err as Error).message ?? err) }], isError: true }
      }
    })
  }
  return mcp
}

function summarizeArgs(args: Record<string, unknown>): string {
  return Object.entries(args)
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v.slice(0, 60) : JSON.stringify(v)?.slice(0, 60)}`)
    .join(' ')
}

export async function startMcp(): Promise<number> {
  if (server) return port
  const wanted = (await getSettings()).mcpPort
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    // Local only: reject browser cross-origin requests (DNS rebinding / drive-by pages).
    if (req.headers.origin && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.origin)) {
      res.writeHead(403).end()
      return
    }
    if (url.pathname !== '/mcp') {
      res.writeHead(404).end()
      return
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST' }).end()
      return
    }
    const sessionId = sessionFor(url.searchParams.get('session'))
    const mcp = buildServer(sessionId)
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    res.on('close', () => {
      void transport.close()
      void mcp.close()
    })
    try {
      await mcp.connect(transport)
      await transport.handleRequest(req, res)
    } catch (err) {
      if (!res.headersSent) res.writeHead(500).end(String(err))
    }
  })
  port = await new Promise<number>((resolve) => {
    const tryListen = (p: number): void => {
      server!.once('error', () => tryListen(0)) // port taken: pick any free one
      server!.listen(p, '127.0.0.1', () => resolve((server!.address() as { port: number }).port))
    }
    tryListen(wanted)
  })
  return port
}

/** Write .mcp.json (Claude Code, Cursor, …) so agents launched outside Viber can use it. */
export async function writeMcpConfig(root: string): Promise<string> {
  const file = path.join(root, '.mcp.json')
  let doc: { mcpServers?: Record<string, unknown> } = {}
  try {
    doc = JSON.parse(await fs.readFile(file, 'utf8'))
  } catch {
    /* new file */
  }
  doc.mcpServers = { ...(doc.mcpServers ?? {}), viber: { type: 'http', url: mcpUrl() } }
  await fs.writeFile(file, JSON.stringify(doc, null, 2) + '\n')
  return file
}

const AGENTS_MARK_START = '<!-- viber:start -->'
const AGENTS_MARK_END = '<!-- viber:end -->'

/** Add (or refresh) a short Viber section in CLAUDE.md / AGENTS.md so agents use the map first. */
export async function writeAgentInstructions(root: string, fileName: 'CLAUDE.md' | 'AGENTS.md'): Promise<string> {
  const file = path.join(root, fileName)
  const section = `${AGENTS_MARK_START}
## Viber architecture map

This repo has a curated architecture model in \`.arch/model.yaml\`, served by the \`viber\` MCP server.
- Before exploring files, call \`arch_overview\`, then \`arch_box\` for the boxes you need, and \`code_symbol\` (signature first, body only when needed).
- Before editing, call \`announce_intent\` and \`propose_plan\`, and wait for approval.
- Follow each box's rules (shown by \`arch_box\`) and never add dependencies listed under Guardrails.
${AGENTS_MARK_END}`
  let text = ''
  try {
    text = await fs.readFile(file, 'utf8')
  } catch {
    /* new file */
  }
  const re = new RegExp(`${AGENTS_MARK_START}[\\s\\S]*?${AGENTS_MARK_END}`)
  text = re.test(text) ? text.replace(re, section) : (text ? text.trimEnd() + '\n\n' : '') + section + '\n'
  await fs.writeFile(file, text)
  return file
}
