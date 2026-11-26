import { execFile, spawn, type ChildProcess } from 'child_process'
import os from 'os'
import { promises as fs } from 'fs'
import path from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import { langOf, type LangId } from './engine/languages'

// A small Language Server Protocol client. Viber bundles typescript-language-server and pyright, so
// exact references work out of the box; anything that fails falls back to the import/regex index.

type ServerId = 'typescript' | 'python' | 'rust' | 'go'

const SERVER_OF: Partial<Record<LangId, ServerId>> = { typescript: 'typescript', tsx: 'typescript', javascript: 'typescript', python: 'python', rust: 'rust', go: 'go' }
const LANGUAGE_ID: Partial<Record<LangId, string>> = { typescript: 'typescript', tsx: 'typescriptreact', javascript: 'javascript', python: 'python', rust: 'rust', go: 'go' }

export interface Diagnostic {
  line: number
  message: string
  code?: string
  severity: number
}

/** How long a server may take to report diagnostics after a change. */
const DIAG_WAIT: Record<ServerId, number> = { typescript: 8000, python: 10000, rust: 20000, go: 10000 }

/** A native server on PATH (or in its usual install folder): rust-analyzer via rustup, gopls via go install. */
async function nativeServer(server: 'rust' | 'go'): Promise<string | null> {
  const name = server === 'rust' ? 'rust-analyzer' : 'gopls'
  const exe = process.platform === 'win32' ? `${name}.exe` : name
  const onPath = await new Promise<string | null>((resolve) =>
    execFile(process.platform === 'win32' ? 'where' : 'which', [name], { windowsHide: true }, (err, out) => resolve(err ? null : (out.split(/\r?\n/).map((s) => s.trim()).find((s) => s.toLowerCase().endsWith('.exe')) ?? out.split(/\r?\n/)[0]?.trim()) || null))
  )
  if (onPath) return onPath
  const home = os.homedir()
  const guesses = server === 'rust' ? [path.join(home, '.cargo', 'bin', exe)] : [path.join(process.env.GOPATH ?? path.join(home, 'go'), 'bin', exe)]
  for (const g of guesses) if (await fs.stat(g).then(() => true, () => false)) return g
  return null
}

/** Normalised key for a file URI or path (servers spell drive letters and escapes differently). */
const keyOf = (uriOrPath: string): string => {
  const p = uriOrPath.startsWith('file:') ? fileURLToPath(uriOrPath) : uriOrPath
  return process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p)
}

export interface Location {
  file: string
  line: number
  col: number
}

const unpacked = (p: string): string => p.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`)

function binOf(pkg: string, bin: string): string | null {
  try {
    const dir = path.dirname(require.resolve(`${pkg}/package.json`))
    const rel = require(`${pkg}/package.json`).bin?.[bin]
    return rel ? unpacked(path.join(dir, rel)) : null
  } catch {
    return null
  }
}

async function tsserverFor(root: string): Promise<string | null> {
  const own = path.join(root, 'node_modules', 'typescript', 'lib', 'tsserver.js')
  if (await fs.stat(own).then(() => true, () => false)) return own
  try {
    return unpacked(require.resolve('typescript/lib/tsserver.js'))
  } catch {
    return null
  }
}

class LspClient {
  private proc: ChildProcess | null = null
  private buf = Buffer.alloc(0)
  private seq = 0
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  private docs = new Map<string, { version: number; text: string }>()
  /** Latest diagnostics per file, with a counter so callers can wait for a fresh report. */
  private diags = new Map<string, { list: Diagnostic[]; seq: number }>()
  private diagSeq = 0
  ready: Promise<void>
  dead = false

  constructor(
    readonly root: string,
    readonly server: ServerId
  ) {
    this.ready = this.start()
  }

  private async start(): Promise<void> {
    if (this.server === 'rust' || this.server === 'go') {
      const exe = await nativeServer(this.server)
      if (!exe) throw new Error(`${this.server} language server not installed`)
      this.proc = spawn(exe, [], { cwd: this.root, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
    } else {
      const script = this.server === 'typescript' ? binOf('typescript-language-server', 'typescript-language-server') : binOf('pyright', 'pyright-langserver')
      if (!script) throw new Error(`${this.server} language server not found`)
      this.proc = spawn(process.execPath, [script, '--stdio'], { cwd: this.root, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
    }
    this.proc.stdout!.on('data', (d: Buffer) => this.onData(d))
    this.proc.on('exit', () => {
      this.dead = true
      for (const p of this.pending.values()) p.reject(new Error('language server exited'))
      this.pending.clear()
    })
    this.proc.on('error', () => (this.dead = true))
    const rootUri = pathToFileURL(this.root).href
    const tsserver = this.server === 'typescript' ? await tsserverFor(this.root) : null
    await this.request(
      'initialize',
      {
        processId: process.pid,
        rootUri,
        workspaceFolders: [{ uri: rootUri, name: path.basename(this.root) }],
        capabilities: {
          textDocument: { references: {}, definition: {}, synchronization: { didSave: false }, hover: { contentFormat: ['plaintext'] }, publishDiagnostics: { relatedInformation: false } },
          workspace: { workspaceFolders: true, configuration: true }
        },
        initializationOptions: tsserver ? { tsserver: { path: tsserver } } : {}
      },
      60_000
    )
    this.notify('initialized', {})
  }

  private onData(d: Buffer): void {
    this.buf = Buffer.concat([this.buf, d])
    for (;;) {
      const sep = this.buf.indexOf('\r\n\r\n')
      if (sep < 0) return
      const len = Number(this.buf.subarray(0, sep).toString().match(/Content-Length:\s*(\d+)/i)?.[1] ?? -1)
      if (len < 0 || this.buf.length < sep + 4 + len) return
      const body = this.buf.subarray(sep + 4, sep + 4 + len).toString('utf8')
      if (process.env.VIBER_LSP_DEBUG) console.error('[lsp]', body.slice(0, 400))
      this.buf = this.buf.subarray(sep + 4 + len)
      let msg: { id?: number; method?: string; params?: { items?: unknown[]; uri?: string; diagnostics?: { range: { start: { line: number } }; message: string; code?: string | number; severity?: number }[] }; result?: unknown; error?: { message: string } }
      try {
        msg = JSON.parse(body)
      } catch {
        continue
      }
      if (msg.method === 'textDocument/publishDiagnostics' && msg.params?.uri) {
        const list = (msg.params.diagnostics ?? []).map((d) => ({ line: d.range.start.line + 1, message: d.message, code: d.code === undefined ? undefined : String(d.code), severity: d.severity ?? 1 }))
        this.diags.set(keyOf(msg.params.uri), { list, seq: ++this.diagSeq })
      } else if (msg.method && msg.id !== undefined) {
        // Server → client requests: answer the few servers need, with neutral values.
        const result = msg.method === 'workspace/configuration' ? (msg.params?.items ?? []).map(() => null) : msg.method === 'workspace/workspaceFolders' ? [{ uri: pathToFileURL(this.root).href, name: path.basename(this.root) }] : null
        this.send({ jsonrpc: '2.0', id: msg.id, result })
      } else if (msg.id !== undefined && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!
        this.pending.delete(msg.id)
        if (msg.error) p.reject(new Error(msg.error.message))
        else p.resolve(msg.result)
      }
    }
  }

  private send(o: object): void {
    const body = Buffer.from(JSON.stringify(o), 'utf8')
    this.proc?.stdin?.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]))
  }

  request<T>(method: string, params: unknown, timeoutMs = 20_000): Promise<T> {
    if (this.dead) return Promise.reject(new Error('language server not running'))
    const id = ++this.seq
    return new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} timed out`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (v) => (clearTimeout(t), resolve(v as T)),
        reject: (e) => (clearTimeout(t), reject(e))
      })
      this.send({ jsonrpc: '2.0', id, method, params })
    })
  }

  notify(method: string, params: unknown): void {
    this.send({ jsonrpc: '2.0', method, params })
  }

  /** Open (or refresh) a document so the server sees the current text on disk. */
  async sync(abs: string): Promise<string> {
    const uri = pathToFileURL(abs).href
    const text = await fs.readFile(abs, 'utf8')
    const doc = this.docs.get(uri)
    if (!doc) {
      this.notify('textDocument/didOpen', { textDocument: { uri, languageId: LANGUAGE_ID[langOf(abs)!] ?? 'plaintext', version: 1, text } })
      this.docs.set(uri, { version: 1, text })
    } else if (doc.text !== text) {
      doc.version++
      doc.text = text
      this.notify('textDocument/didChange', { textDocument: { uri, version: doc.version }, contentChanges: [{ text }] })
    }
    return uri
  }

  /** Set a document's text (without touching the disk) and wait for the server's fresh diagnostics. */
  async diagnose(abs: string, text: string): Promise<Diagnostic[] | null> {
    const uri = pathToFileURL(abs).href
    const key = keyOf(abs)
    const since = this.diagSeq
    const doc = this.docs.get(uri)
    if (!doc) {
      this.notify('textDocument/didOpen', { textDocument: { uri, languageId: LANGUAGE_ID[langOf(abs)!] ?? 'plaintext', version: 1, text } })
      this.docs.set(uri, { version: 1, text })
    } else {
      doc.version++
      doc.text = text
      this.notify('textDocument/didChange', { textDocument: { uri, version: doc.version }, contentChanges: [{ text }] })
    }
    const deadline = Date.now() + DIAG_WAIT[this.server]
    while (Date.now() < deadline && !this.dead) {
      const d = this.diags.get(key)
      if (d && d.seq > since) {
        // Servers may report in steps (syntax, then types): give a later report a moment to arrive.
        await new Promise((r) => setTimeout(r, 400))
        return this.diags.get(key)!.list
      }
      await new Promise((r) => setTimeout(r, 50))
    }
    return null
  }

  stop(): void {
    if (this.dead) return
    this.request('shutdown', null, 2000)
      .catch(() => undefined)
      .finally(() => {
        this.notify('exit', null)
        setTimeout(() => this.proc?.kill(), 500)
      })
    this.dead = true
  }
}

const clients = new Map<string, LspClient>()
let enabled = true

export function setLspEnabled(on: boolean): void {
  enabled = on
  if (!on) stopAllLsp()
}

export function stopAllLsp(): void {
  for (const c of clients.values()) c.stop()
  clients.clear()
}

async function clientFor(root: string, rel: string): Promise<LspClient | null> {
  if (!enabled) return null
  const lang = langOf(rel)
  const server = lang ? SERVER_OF[lang] : undefined
  if (!server) return null
  const key = `${root}::${server}`
  let c = clients.get(key)
  if (c?.dead) (clients.delete(key), (c = undefined))
  if (!c) clients.set(key, (c = new LspClient(root, server)))
  try {
    await c.ready
    return c
  } catch {
    clients.delete(key)
    c.stop()
    return null
  }
}

type LspLocation = { uri: string; range: { start: { line: number; character: number } } }

const toLocations = (root: string, r: LspLocation[] | LspLocation | null): Location[] =>
  (Array.isArray(r) ? r : r ? [r] : [])
    .filter((l) => l.uri.startsWith('file:'))
    .map((l) => ({ file: path.relative(root, fileURLToPath(l.uri)).split(path.sep).join('/'), line: l.range.start.line + 1, col: l.range.start.character + 1 }))
    .filter((l) => !l.file.startsWith('..') && !l.file.includes('node_modules/'))

/**
 * Exact references to the symbol at (line, col) of a file (1-based), or null when no server could answer.
 * `candidates` are files that may use it (from the text index): opening them lets servers without a
 * project config (no tsconfig, no pyproject) see them.
 */
export async function lspReferences(root: string, rel: string, line: number, col: number, candidates: string[] = []): Promise<Location[] | null> {
  const c = await clientFor(root, rel)
  if (!c) return null
  try {
    const server = SERVER_OF[langOf(rel)!]
    for (const f of candidates.slice(0, 200)) if (f !== rel && SERVER_OF[langOf(f) ?? ('' as LangId)] === server) await c.sync(path.join(root, f)).catch(() => undefined)
    const uri = await c.sync(path.join(root, rel))
    const r = await c.request<LspLocation[] | null>('textDocument/references', { textDocument: { uri }, position: { line: line - 1, character: col - 1 }, context: { includeDeclaration: false } }, 45_000)
    return toLocations(root, r)
  } catch {
    return null
  }
}

// Missing packages are an environment problem (no venv, no npm install), not something the edit did.
const ENVIRONMENT_NOISE = /^(2307|2792|7016|reportMissingImports|reportMissingModuleSource|unresolved-import|E0432|E0433|BrokenImport|UndeclaredImportedName)$/
const IMPORT_TEXT = /cannot find module|could not be resolved|unresolved import|no required module provides|could not import/i

/**
 * Type errors an edit introduced: errors in `after` that `before` did not have (matched by code and message,
 * not line, since lines move). `before` null means "new file": every error counts. Null when no server answered.
 */
export async function lspNewErrors(root: string, rel: string, before: string | null, after: string): Promise<string[] | null> {
  const c = await clientFor(root, rel)
  if (!c) return null
  const abs = path.join(root, rel)
  try {
    const keyFor = (d: Diagnostic): string => `${d.code ?? ''}|${d.message}`
    const errors = (l: Diagnostic[]): Diagnostic[] => l.filter((d) => d.severity === 1 && !ENVIRONMENT_NOISE.test(d.code ?? '') && !IMPORT_TEXT.test(d.message))
    const was = before === null ? [] : await c.diagnose(abs, before)
    if (was === null) return null
    const now = await c.diagnose(abs, after)
    if (now === null) return null
    const left = new Map<string, number>()
    for (const d of errors(was)) left.set(keyFor(d), (left.get(keyFor(d)) ?? 0) + 1)
    const fresh: string[] = []
    for (const d of errors(now)) {
      const n = left.get(keyFor(d)) ?? 0
      if (n > 0) left.set(keyFor(d), n - 1)
      else fresh.push(`line ${d.line}: ${d.message.split('\n')[0].slice(0, 200)}`)
    }
    return fresh.slice(0, 8)
  } catch {
    return null
  }
}

/** Where the symbol at (line, col) is defined, or null when no server could answer. */
export async function lspDefinition(root: string, rel: string, line: number, col: number): Promise<Location[] | null> {
  const c = await clientFor(root, rel)
  if (!c) return null
  try {
    const uri = await c.sync(path.join(root, rel))
    return toLocations(root, await c.request<LspLocation[] | LspLocation | null>('textDocument/definition', { textDocument: { uri }, position: { line: line - 1, character: col - 1 } }))
  } catch {
    return null
  }
}
