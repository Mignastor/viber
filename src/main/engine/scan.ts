import { termCounts } from './words'
import { promises as fs } from 'fs'
import path from 'path'
import ignore, { type Ignore } from 'ignore'
import Parser from 'web-tree-sitter'
import type { CodeSymbol } from '@shared/model'
import { LANGS, REGEX_DEFS, langOf, type LangId } from './languages'
import { detectEffects, detectFlags, detectHttpCalls, detectMessages, detectRouting, detectRoutes, fileRoute, handlerIo, type Effect, type FileFlag, type HttpCall, type Message, type Mount, type Route } from './detect'

// Walks a repository and extracts, per source file: symbols (with line ranges and signatures),
// raw imports, HTTP routes and calls, and entry-point flags. Pure data out — no model decisions here.

export interface ScanFile {
  path: string
  lang: LangId
  lines: number
  imports: string[]
  /** Names imported per import spec (JS named imports, Python from-imports). */
  importNames: Record<string, string[]>
  symbols: CodeSymbol[]
  routes: Route[]
  pageRoute?: string
  calls: HttpCall[]
  flags: FileFlag[]
  effects: Effect[]
  /** Event / queue topics published and listened to. */
  emits?: Message[]
  listens?: Message[]
  /** Routers this file mounts under a prefix. */
  mounts?: Mount[]
  /** Word counts of the file body (for body-text relevance); absent on very large repos. */
  terms?: Record<string, number>
  namespace?: string
}

export interface ScanResult {
  root: string
  files: ScanFile[]
  /** Small config/manifest files keyed by relative path (package.json, go.mod, …). */
  manifests: Record<string, string>
  /** All non-ignored relative paths, including non-source files (for folder structure). */
  allPaths: string[]
  languages: Partial<Record<LangId, number>>
  skipped: number
  durationMs: number
}

export type Progress = (p: { phase: string; done: number; total: number }) => void

const ALWAYS_IGNORE = [
  'node_modules/',
  '.git/',
  '.hg/',
  '.svn/',
  'dist/',
  'build/',
  'out/',
  '.next/',
  '.nuxt/',
  '.svelte-kit/',
  '.output/',
  '.turbo/',
  '.vercel/',
  'target/',
  'vendor/',
  '__pycache__/',
  '.venv/',
  'venv/',
  'env/',
  '.tox/',
  '.mypy_cache/',
  '.pytest_cache/',
  'coverage/',
  '.arch/',
  'bin/',
  'obj/',
  'Pods/',
  'DerivedData/',
  '.gradle/',
  '.idea/',
  '.vscode/',
  '.cache/',
  'cdk.out/',
  '.serverless/',
  '.aws-sam/',
  'storybook-static/',
  '.expo/',
  '.dart_tool/',
  'site-packages/',
  'migrations/versions/',
  '*.min.js',
  '*.bundle.js',
  '*.map',
  '*.d.ts'
]

const MANIFESTS = /(^|\/)(package\.json|tsconfig\.json|jsconfig\.json|pyproject\.toml|requirements[^/]*\.txt|setup\.py|go\.mod|Cargo\.toml|composer\.json|Gemfile|pom\.xml|build\.gradle(\.kts)?|[^/]+\.csproj|\.env\.example|\.env\.sample|docker-compose\.ya?ml|compose\.ya?ml|vercel\.json|Procfile|schema\.prisma|pubspec\.yaml|manage\.py)$/

const MAX_FILES = 25000
const MAX_BYTES = 512 * 1024

const FUNCTION_TYPES = new Set([
  'function_declaration',
  'function_expression',
  'arrow_function',
  'generator_function_declaration',
  'function_definition',
  'function_item',
  'method_declaration',
  'function',
  'method'
])

/** Resolves bundled wasm paths both in dev and inside a packaged (asar-unpacked) app. */
export function wasmDir(): { core: string; grammars: string } {
  const unpack = (p: string): string => p.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`)
  const core = unpack(path.dirname(require.resolve('web-tree-sitter')))
  const grammars = unpack(path.join(path.dirname(require.resolve('tree-sitter-wasms/package.json')), 'out'))
  return { core, grammars }
}

interface LoadedLang {
  parser: Parser
  imports: Parser.Query[]
  defs: { q: Parser.Query; kind: CodeSymbol['kind'] }[]
}

let parserReady: Promise<void> | null = null
const loaded = new Map<LangId, Promise<LoadedLang | null>>()

async function loadLang(id: LangId): Promise<LoadedLang | null> {
  const spec = LANGS[id]
  if (!spec.grammar) return null
  if (!loaded.has(id)) {
    loaded.set(
      id,
      (async () => {
        const dirs = wasmDir()
        parserReady ??= Parser.init({ locateFile: (f: string) => path.join(dirs.core, f) })
        await parserReady
        const lang = await Parser.Language.load(path.join(dirs.grammars, `tree-sitter-${spec.grammar}.wasm`))
        const parser = new Parser()
        parser.setLanguage(lang)
        const compile = (src: string): Parser.Query | null => {
          try {
            return lang.query(src)
          } catch {
            return null // pattern not supported by this grammar version
          }
        }
        return {
          parser,
          imports: spec.imports.map(compile).filter((q): q is Parser.Query => !!q),
          defs: spec.defs.flatMap((d) => {
            const q = compile(d.query)
            return q ? [{ q, kind: d.kind as CodeSymbol['kind'] }] : []
          })
        } satisfies LoadedLang
      })().catch(() => null)
    )
  }
  return loaded.get(id)!
}

const unquote = (s: string): string => s.replace(/^[`'"]|[`'"]$/g, '')
const squash = (s: string): string => s.replace(/\s+/g, ' ').trim()

function signatureOf(node: Parser.SyntaxNode, text: string): string {
  // Everything before the body, e.g. `export async function issue(userId: string): Promise<TokenPair>`.
  let body: Parser.SyntaxNode | null = node.childForFieldName('body')
  if (!body) {
    // const f = (…) => {…}: look one or two levels down for the function's body.
    const queue: [Parser.SyntaxNode, number][] = [[node, 0]]
    while (queue.length && !body) {
      const [n, d] = queue.shift()!
      for (const c of n.namedChildren) {
        const b = c.childForFieldName('body')
        if (b && FUNCTION_TYPES.has(c.type)) {
          body = b
          break
        }
        if (d < 3) queue.push([c, d + 1])
      }
    }
  }
  const end = body ? body.startIndex : Math.min(node.endIndex, node.startIndex + 200)
  const raw = text
    .slice(node.startIndex, end)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)(\/\/|#(?![[!]))[^\n]*/g, '$1')
  let sig = squash(raw)
  sig = sig.replace(/^export\s+(default\s+)?/, '').replace(/\s*(=>|\{|:)\s*$/, '')
  if (!body) sig = sig.split(/[\n;{]/)[0]
  return sig.length > 200 ? sig.slice(0, 197) + '…' : sig
}

/** First sentence of a docstring (Python) or the comment right above a definition (others). */
function docOf(def: Parser.SyntaxNode): string | undefined {
  const clean = (t: string): string =>
    t
      .replace(/^\s*(\/\*\*?|\*\/|\/\/+|#+|\*|"""|''')/gm, '')
      .replace(/(\*\/|"""|''')\s*$/g, '')
      .replace(/\s+/g, ' ')
      .trim()
  const first = (t: string): string | undefined => {
    const s = clean(t).split(/(?<=[.!?])\s/)[0]
    return s ? s.slice(0, 160) : undefined
  }
  // Python: first statement of the body is a string.
  const body = def.childForFieldName('body')
  const firstStmt = body?.namedChildren[0]
  if (firstStmt?.type === 'expression_statement' && firstStmt.namedChildren[0]?.type === 'string') return first(firstStmt.namedChildren[0].text)
  // Others: comment(s) immediately above (above the export/decorator wrapper if any).
  let anchor: Parser.SyntaxNode = def
  if (anchor.parent && ['export_statement', 'decorated_definition'].includes(anchor.parent.type)) anchor = anchor.parent
  const prev = anchor.previousNamedSibling
  if (prev && prev.type.includes('comment') && prev.endPosition.row >= anchor.startPosition.row - 1) return first(prev.text)
  return undefined
}

const CONTROL = /^(if|for|for_in|for_of|foreach|while|do|try|with|switch|match|case|select|loop|enhanced_for|catch)(_statement|_expression|_clause)?$/

/** Deepest nesting of control-flow statements inside a definition (else/elif don't add a level). */
function nestingOf(def: Parser.SyntaxNode): number {
  let max = 0
  const walk = (n: Parser.SyntaxNode, depth: number): void => {
    for (const c of n.namedChildren) {
      if (FUNCTION_TYPES.has(c.type) && c !== def) continue // nested functions count on their own
      const control = CONTROL.test(c.type) && !/^(elif|else)/.test(c.type)
      const d = control ? depth + 1 : depth
      if (d > max) max = d
      walk(c, d)
    }
  }
  walk(def, 0)
  return max
}

function nestedInFunction(node: Parser.SyntaxNode): boolean {
  for (let p = node.parent; p; p = p.parent) if (FUNCTION_TYPES.has(p.type)) return true
  return false
}

function exportedParent(node: Parser.SyntaxNode): string | null {
  // JS: export_statement wraps the declaration; methods inherit their class's exportedness.
  let p = node.parent
  if (node.type === 'method_definition') {
    while (p && p.type !== 'class_declaration' && p.type !== 'abstract_class_declaration') p = p.parent
    return p?.parent?.type ?? null
  }
  if (p?.type === 'decorated_definition') p = p.parent
  return p?.type ?? null
}

async function extract(rel: string, lang: LangId, text: string): Promise<ScanFile> {
  const file: ScanFile = {
    path: rel,
    lang,
    lines: text.split('\n').length,
    imports: [],
    importNames: {},
    symbols: [],
    routes: detectRoutes(text),
    calls: detectHttpCalls(text),
    flags: detectFlags(rel, text),
    effects: []
  }
  const fr = fileRoute(rel)
  if (fr) {
    if (fr.kind === 'api') file.routes.push(fr.route)
    else (file.pageRoute = fr.route.path), file.flags.push('page')
  }
  const ns = text.match(/^\s*(?:package|namespace)\s+([\w.\\]+)\s*[;{]?\s*$/m)
  if (ns) file.namespace = ns[1].replace(/\\/g, '.')

  const L = await loadLang(lang)
  if (L) {
    const tree = L.parser.parse(text)
    try {
      for (const q of L.imports) {
        for (const c of q.captures(tree.rootNode)) {
          if (c.name !== 'src') continue
          const spec = unquote(c.node.text)
          file.imports.push(spec)
          const stmt = c.node.parent?.type === 'arguments' ? null : c.node.parent
          if (stmt) {
            const names = importedNames(stmt.text, lang)
            if (names.length) file.importNames[spec] = [...new Set([...(file.importNames[spec] ?? []), ...names])]
          }
        }
      }
      const seen = new Set<string>()
      for (const d of L.defs) {
        for (const m of d.q.matches(tree.rootNode)) {
          const name = m.captures.find((c) => c.name === 'name')?.node
          const def = m.captures.find((c) => c.name === 'def')?.node
          if (!name || !def) continue
          if (nestedInFunction(def)) continue
          const key = name.text + ':' + def.startPosition.row
          if (seen.has(key)) continue
          seen.add(key)
          let kind = d.kind
          if (kind === 'function' && /^[A-Z]/.test(name.text) && (lang === 'tsx' || lang === 'javascript') && file.flags.includes('component')) kind = 'component'
          file.symbols.push({
            name: name.text,
            signature: signatureOf(def, text),
            file: rel,
            line: def.startPosition.row + 1,
            endLine: def.endPosition.row + 1,
            kind,
            exported: LANGS[lang].exported(def.text.slice(0, 160), name.text, exportedParent(def)),
            doc: docOf(def),
            fields: kind === 'class' || kind === 'interface' || kind === 'type' ? fieldsOf(def.text, lang) : undefined,
            nesting: kind === 'function' || kind === 'method' || kind === 'component' ? nestingOf(def) : undefined
          })
        }
      }
    } finally {
      tree.delete()
    }
  } else {
    const R = REGEX_DEFS[lang]
    if (R) {
      const src =
        lang === 'vue'
          ? (text.match(/<script[^>]*>([\s\S]*?)<\/script>/)?.[1] ?? '')
          : lang === 'html'
            ? // Inline scripts only, with everything else blanked so line numbers still match.
              text.replace(/<script\b[^>]*>([\s\S]*?)<\/script>|[^\n]/g, (m, body: string | undefined) => (body !== undefined ? m.replace(/<script\b[^>]*>|<\/script>/g, (t) => ' '.repeat(t.length)) : ' '))
            : text
      let m: RegExpExecArray | null
      R.imp.lastIndex = 0
      while ((m = R.imp.exec(src))) file.imports.push(m[1])
      R.def.lastIndex = 0
      while ((m = R.def.exec(src))) {
        const line = src.slice(0, m.index).split('\n').length
        file.symbols.push({
          name: m[3],
          signature: squash(m[0]),
          file: rel,
          line,
          kind: R.kindOf(m[2]),
          exported: LANGS[lang].exported(m[0], m[3], null)
        })
      }
      if (lang === 'vue') {
        const comp = path.basename(rel).replace(/\.\w+$/, '')
        file.symbols.unshift({ name: comp, signature: `<${comp} />`, file: rel, line: 1, kind: 'component', exported: true })
      }
    }
  }
  linkHandlers(file, text)
  file.terms = termCounts(text)
  const mounts = detectRouting(text, file.routes, file.importNames)
  if (mounts.length) file.mounts = mounts
  const msgs = detectMessages(text)
  if (msgs.emits.length) file.emits = msgs.emits
  if (msgs.listens.length) file.listens = msgs.listens
  file.effects = detectEffects(text, lang === 'python' ? 'python' : ['typescript', 'tsx', 'javascript', 'vue', 'svelte'].includes(lang) ? 'js' : 'other', file.imports)
  return file
}

/** Field names declared directly in a class / interface / type body. */
export function fieldsOf(defText: string, lang: LangId): string[] | undefined {
  const out: string[] = []
  if (lang === 'python') {
    const body = defText.split('\n').slice(1)
    const indent = Math.min(...body.filter((l) => l.trim()).map((l) => l.match(/^\s*/)![0].length))
    for (const l of body) {
      // name: type (pydantic, dataclass, TypedDict) or name = Column(...) / Field(...) / models.CharField(...) (ORMs).
      const m = l.match(/^(\s*)(\w+)\s*:\s*[^\s=]/) ?? l.match(/^(\s*)(\w+)\s*=\s*(?:\w+\.)?(?:Column|mapped_column|Field|relationship|\w+Field)\s*\(/)
      if (m && m[1].length === indent && !m[2].startsWith('_') && m[2] !== 'model_config') out.push(m[2])
    }
  } else {
    let depth = 0
    for (const l of defText.split('\n')) {
      if (depth === 1) {
        const m = l.match(/^\s*(?:readonly\s+|public\s+|private\s+|protected\s+)*['"]?(\w+)['"]?\??\s*:/)
        if (m) out.push(m[1])
      }
      for (const ch of l) depth += ch === '{' ? 1 : ch === '}' ? -1 : 0
    }
  }
  return out.length ? [...new Set(out)] : undefined
}

/** Attach the function right below each route declaration (and FastAPI's response_model). */
function linkHandlers(file: ScanFile, text: string): void {
  if (!file.routes.length) return
  const lines = text.split('\n')
  const fns = file.symbols.filter((s) => (s.kind === 'function' || s.kind === 'method') && s.line).sort((a, b) => a.line! - b.line!)
  for (const r of file.routes) {
    const h = fns.find((s) => s.line! >= r.line && s.line! <= r.line + 8)
    let end = h?.line
    if (h) {
      r.handler = h.name
      r.io = handlerIo(lines.slice(h.line! - 1, h.endLine ?? h.line! + 40).join('\n'))
    } else {
      // Handlers nested in an app factory (def create_app(): @app.get… def x()) are not top-level symbols.
      const at = lines.slice(r.line, r.line + 8).findIndex((l) => /^\s*(?:async\s+)?(?:def|function)\s+\w+\s*\(/.test(l))
      if (at < 0) {
        // Inline handler: app.post('/x', async (req, res) => {…}). Read up to the call's closing paren.
        const startIdx = lines.slice(0, r.line - 1).join('\n').length + (r.line > 1 ? 1 : 0)
        const open = text.indexOf('(', startIdx)
        let depth = 0
        let close = text.length
        for (let i = open; i >= 0 && i < text.length; i++) {
          if (text[i] === '(') depth++
          else if (text[i] === ')' && --depth === 0) {
            close = i
            break
          }
        }
        if (open >= 0) r.io = handlerIo(text.slice(open, Math.min(close, open + 20000)))
        continue
      }
      const start = r.line + at
      let sig = ''
      for (let i = start; i < Math.min(lines.length, start + 12); i++) {
        sig += ' ' + lines[i].trim()
        if (/\)\s*(->[^:]*)?:\s*$|\)\s*(:\s*[^{]+)?\{\s*$/.test(lines[i])) break
      }
      sig = sig.trim().replace(/\s*[:{]\s*$/, '')
      r.handler = sig.match(/(?:def|function)\s+(\w+)/)![1]
      r.handlerSig = sig
      end = start + 1
      const indent = lines[start].match(/^\s*/)![0].length
      let stop = start + 1
      while (stop < lines.length && (!lines[stop].trim() || lines[stop].match(/^\s*/)![0].length > indent)) stop++
      r.io = handlerIo(lines.slice(start, stop).join('\n'))
    }
    const decl = lines.slice(r.line - 1, end).join(' ')
    const rm = decl.match(/response_model\s*=\s*(?:(?:list|List|Optional)\[)?(\w+)/)
    if (rm) r.responseModel = rm[1]
  }
}

function importedNames(stmt: string, lang: LangId): string[] {
  if (lang === 'python') {
    const m = stmt.match(/\bimport\s+\(?([^)]*)\)?/s)
    return m ? m[1].split(',').map((s) => s.trim().split(/\s+as\s+/)[0]).filter((s) => /^\w+$/.test(s)) : []
  }
  const out: string[] = []
  const named = stmt.match(/\{([^}]*)\}/s)
  if (named) out.push(...named[1].split(',').map((s) => s.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]).filter((s) => /^[\w$]+$/.test(s)))
  const def = stmt.match(/^import\s+(?:type\s+)?([A-Za-z_$][\w$]*)\s*(?:,|from)/)
  if (def) out.push(def[1])
  if (/^import\s+\*\s+as\s/.test(stmt)) out.push('*')
  return out
}

/** Recursively list files, honouring .gitignore files at every level plus sensible defaults. */
async function walk(root: string): Promise<{ files: string[]; skipped: number }> {
  const files: string[] = []
  let skipped = 0
  const base = ignore().add(ALWAYS_IGNORE)

  async function visit(dir: string, rules: { ig: Ignore; at: string }[]): Promise<void> {
    if (files.length >= MAX_FILES) return
    let entries: import('fs').Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    const local = entries.find((e) => e.isFile() && e.name === '.gitignore')
    if (local) {
      try {
        const ig = ignore().add(await fs.readFile(path.join(dir, '.gitignore'), 'utf8'))
        rules = [...rules, { ig, at: path.relative(root, dir).split(path.sep).join('/') }]
      } catch {
        /* unreadable .gitignore: ignore it */
      }
    }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue
      const abs = path.join(dir, e.name)
      const rel = path.relative(root, abs).split(path.sep).join('/')
      const relDir = e.isDirectory() ? rel + '/' : rel
      if (base.ignores(relDir)) continue
      if (rules.some((r) => {
        const sub = r.at ? relDir.slice(r.at.length + 1) : relDir
        return (!r.at || relDir.startsWith(r.at + '/')) && sub && r.ig.ignores(sub)
      })) {
        skipped++
        continue
      }
      if (e.isDirectory()) await visit(abs, rules)
      else if (e.isFile()) files.push(rel)
    }
  }
  await visit(root, [])
  return { files, skipped }
}

export async function scanRepo(root: string, onProgress?: Progress): Promise<ScanResult> {
  const t0 = Date.now()
  onProgress?.({ phase: 'Listing files', done: 0, total: 0 })
  const { files: all, skipped } = await walk(root)
  const manifests: Record<string, string> = {}
  const sources = all.filter((f) => langOf(f))
  const out: ScanFile[] = []
  const languages: Partial<Record<LangId, number>> = {}

  for (const m of all.filter((f) => MANIFESTS.test(f))) {
    try {
      const txt = await fs.readFile(path.join(root, m), 'utf8')
      if (txt.length < 200_000) manifests[m] = txt
    } catch {
      /* skip */
    }
  }

  let done = 0
  for (const rel of sources) {
    done++
    if (done % 25 === 0) onProgress?.({ phase: 'Parsing code', done, total: sources.length })
    const lang = langOf(rel)!
    let text: string
    try {
      const abs = path.join(root, rel)
      const st = await fs.stat(abs)
      if (st.size > MAX_BYTES) continue
      text = await fs.readFile(abs, 'utf8')
    } catch {
      continue
    }
    const lines = text.split('\n')
    if (lines.length < 3 && text.length > 5000) continue // minified
    try {
      out.push(await extract(rel, lang, text))
      languages[lang] = (languages[lang] ?? 0) + 1
    } catch {
      out.push({ path: rel, lang, lines: lines.length, imports: [], importNames: {}, symbols: [], routes: [], calls: [], flags: detectFlags(rel, text), effects: [] })
    }
  }
  onProgress?.({ phase: 'Parsing code', done: sources.length, total: sources.length })
  if (out.length > 6000) for (const f of out) delete f.terms // memory: body-text relevance is for small and mid-size repos
  return { root, files: out, manifests, allPaths: all, languages, skipped, durationMs: Date.now() - t0 }
}

export interface ParseError {
  line: number
  col: number
  what: string
}

/** Parse errors in a file's text, or null when the language has no grammar. */
export async function syntaxErrors(rel: string, text: string): Promise<ParseError[] | null> {
  const lang = langOf(rel)
  const L = lang ? await loadLang(lang) : null
  if (!L) return null
  const tree = L.parser.parse(text)
  try {
    const out: ParseError[] = []
    const visit = (n: Parser.SyntaxNode): void => {
      if (out.length >= 3 || !n.hasError) return
      if (n.type === 'ERROR' || n.isMissing) {
        out.push({ line: n.startPosition.row + 1, col: n.startPosition.column + 1, what: n.isMissing ? `missing ${n.type}` : `unexpected ${JSON.stringify(n.text.slice(0, 30))}` })
        return
      }
      for (const c of n.children) visit(c)
    }
    if (tree.rootNode.hasError) visit(tree.rootNode)
    // hasError can be set by a MISSING leaf deeper than ERROR nodes: make sure we report something.
    if (tree.rootNode.hasError && !out.length) out.push({ line: 1, col: 1, what: 'syntax error' })
    return out
  } finally {
    tree.delete()
  }
}

/** Re-extract a few files (watch mode). Returns the fresh entries and the paths that no longer exist. */
export async function scanPaths(root: string, rels: string[]): Promise<{ files: ScanFile[]; removed: string[] }> {
  const files: ScanFile[] = []
  const removed: string[] = []
  for (const rel of rels) {
    const lang = langOf(rel)
    if (!lang) continue
    try {
      const abs = path.join(root, rel)
      const st = await fs.stat(abs)
      if (st.size > MAX_BYTES) continue
      files.push(await extract(rel, lang, await fs.readFile(abs, 'utf8')))
    } catch {
      removed.push(rel)
    }
  }
  return { files, removed }
}
