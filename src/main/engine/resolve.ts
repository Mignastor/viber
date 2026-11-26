import { applyMounts } from './detect'
import path from 'path'
import type { ScanFile, ScanResult } from './scan'

// Turns raw import specs into file→file dependencies (internal) and file→package uses (external),
// per language, using the repo's own config (tsconfig paths, workspaces, go.mod, Python packages).

export interface FileDep {
  from: string
  to: string
  names: string[]
}

export interface PkgUse {
  file: string
  pkg: string
}

export interface Resolution {
  deps: FileDep[]
  pkgs: PkgUse[]
}

const P = path.posix
const JS_EXT = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.vue', '.svelte']
const JS_LANGS = new Set(['typescript', 'tsx', 'javascript', 'vue'])

const NODE_BUILTINS = new Set(
  'assert async_hooks buffer child_process cluster console constants crypto dgram dns domain events fs http http2 https inspector module net os path perf_hooks process punycode querystring readline repl stream string_decoder timers tls trace_events tty url util v8 vm wasi worker_threads zlib'.split(' ')
)

const PY_STDLIB = new Set(
  'abc argparse array ast asyncio base64 bisect builtins calendar collections concurrent contextlib copy csv ctypes dataclasses datetime decimal difflib email enum errno functools gc getpass glob gzip hashlib heapq hmac html http importlib inspect io ipaddress itertools json logging math mimetypes multiprocessing numbers operator os pathlib pickle platform pprint queue random re secrets select shlex shutil signal socket sqlite3 ssl stat statistics string struct subprocess sys tempfile textwrap threading time timeit tkinter traceback types typing unicodedata unittest urllib uuid warnings weakref xml zipfile zoneinfo __future__ typing_extensions'.split(' ')
)

/** tsconfig.json is JSONC: strip comments and trailing commas before parsing. */
function parseJsonc(text: string): any {
  try {
    return JSON.parse(
      text
        .replace(/\\"|"(?:\\"|[^"])*"|(\/\/.*|\/\*[\s\S]*?\*\/)/g, (m, c) => (c ? '' : m))
        .replace(/,(\s*[}\]])/g, '$1')
    )
  } catch {
    return null
  }
}

export function resolveImports(scan: ScanResult): Resolution {
  const files = new Set(scan.files.map((f) => f.path))
  const allFiles = new Set(scan.allPaths)
  const deps: FileDep[] = []
  const pkgs: PkgUse[] = []
  const add = (from: string, to: string, names: string[]): void => {
    if (to !== from) deps.push({ from, to, names })
  }

  // ── JS/TS config: path aliases and workspace packages ───────────────────────────────────
  const aliases: { prefix: string; suffix: string; targets: string[] }[] = []
  const baseUrls: string[] = []
  for (const [p, txt] of Object.entries(scan.manifests)) {
    if (!/(^|\/)(tsconfig|jsconfig)\.json$/.test(p)) continue
    const j = parseJsonc(txt)
    const co = j?.compilerOptions
    if (!co) continue
    const dir = P.dirname(p) === '.' ? '' : P.dirname(p)
    const base = P.join(dir, co.baseUrl ?? '.')
    if (co.baseUrl) baseUrls.push(base === '.' ? '' : base)
    for (const [k, v] of Object.entries<string[]>(co.paths ?? {})) {
      const star = k.indexOf('*')
      aliases.push({
        prefix: star < 0 ? k : k.slice(0, star),
        suffix: star < 0 ? '' : k.slice(star + 1),
        targets: v.map((t) => P.join(base, t).replace(/^\.\//, ''))
      })
    }
  }
  const workspaces = new Map<string, string>() // package name → dir
  for (const [p, txt] of Object.entries(scan.manifests)) {
    if (!p.endsWith('package.json')) continue
    try {
      const name = JSON.parse(txt).name
      const dir = P.dirname(p)
      if (name && dir !== '.') workspaces.set(name, dir)
    } catch {
      /* skip */
    }
  }

  const tryJs = (base: string): string | null => {
    const b = base.replace(/^\.\//, '')
    if (files.has(b)) return b
    const noJs = b.replace(/\.(js|jsx|mjs|cjs)$/, '')
    for (const e of JS_EXT) if (files.has(noJs + e)) return noJs + e
    for (const e of JS_EXT) if (files.has(P.join(b, 'index' + e))) return P.join(b, 'index' + e)
    return null
  }

  const resolveJs = (f: ScanFile, spec: string): string | null => {
    if (spec.startsWith('.')) return tryJs(P.join(P.dirname(f.path), spec))
    for (const a of aliases) {
      if (spec.startsWith(a.prefix) && spec.endsWith(a.suffix)) {
        const mid = spec.slice(a.prefix.length, spec.length - a.suffix.length || undefined)
        for (const t of a.targets) {
          const r = tryJs(t.replace('*', mid))
          if (r) return r
        }
      }
    }
    for (const [name, dir] of workspaces) {
      if (spec === name || spec.startsWith(name + '/')) {
        const sub = spec.slice(name.length + 1)
        return tryJs(P.join(dir, sub)) ?? tryJs(P.join(dir, 'src', sub)) ?? tryJs(P.join(dir, 'src/index')) ?? tryJs(P.join(dir, 'index'))
      }
    }
    for (const b of baseUrls) {
      const r = tryJs(P.join(b, spec))
      if (r) return r
    }
    return null
  }

  const jsPkg = (spec: string): string | null => {
    if (spec.startsWith('node:') || NODE_BUILTINS.has(spec.split('/')[0])) return null
    if (spec.startsWith('.') || spec.startsWith('/')) return null
    const parts = spec.split('/')
    return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
  }

  // ── Python: module index ─────────────────────────────────────────────────────────────────
  const pyModules = new Map<string, string[]>() // dotted name (any suffix) → files
  for (const f of scan.files) {
    if (f.lang !== 'python') continue
    const segs = f.path.replace(/\.py$/, '').split('/')
    if (segs[segs.length - 1] === '__init__') segs.pop()
    for (let i = 0; i < segs.length; i++) {
      const name = segs.slice(i).join('.')
      pyModules.set(name, [...(pyModules.get(name) ?? []), f.path])
    }
  }
  const pyLookup = (dotted: string, near: string): string | null => {
    const parts = dotted.split('.')
    for (let n = parts.length; n > 0; n--) {
      const cands = pyModules.get(parts.slice(0, n).join('.'))
      if (cands?.length) {
        // Prefer the candidate sharing the longest directory prefix with the importer.
        return [...cands].sort((a, b) => common(b, near) - common(a, near) || a.length - b.length)[0]
      }
    }
    return null
  }
  const common = (a: string, b: string): number => {
    let i = 0
    while (i < a.length && a[i] === b[i]) i++
    return i
  }

  // ── Go: module paths ─────────────────────────────────────────────────────────────────────
  const goMods: { dir: string; module: string }[] = []
  for (const [p, txt] of Object.entries(scan.manifests)) {
    const m = p.endsWith('go.mod') && txt.match(/^module\s+(\S+)/m)
    if (m) goMods.push({ dir: P.dirname(p) === '.' ? '' : P.dirname(p), module: m[1] })
  }
  const goDirs = new Map<string, string[]>()
  for (const f of scan.files) if (f.lang === 'go' && !f.flags.includes('test')) goDirs.set(P.dirname(f.path), [...(goDirs.get(P.dirname(f.path)) ?? []), f.path])

  // ── Java / Kotlin / C#: namespace → files ────────────────────────────────────────────────
  const nsFiles = new Map<string, string[]>()
  const fqcn = new Map<string, string>()
  for (const f of scan.files) {
    if (!f.namespace) continue
    nsFiles.set(f.namespace, [...(nsFiles.get(f.namespace) ?? []), f.path])
    const cls = P.basename(f.path).replace(/\.\w+$/, '')
    fqcn.set(f.namespace + '.' + cls, f.path)
    for (const s of f.symbols) if (s.kind === 'class' || s.kind === 'interface') fqcn.set(f.namespace + '.' + s.name, f.path)
  }

  const resolvePy = (f: ScanFile, spec: string): string | null => {
    if (!spec.startsWith('.')) return pyLookup(spec, f.path)
    const dots = spec.match(/^\.+/)![0].length
    let dir = P.dirname(f.path)
    for (let i = 1; i < dots; i++) dir = P.dirname(dir)
    const rest = spec.slice(dots).replace(/\./g, '/')
    const base = rest ? P.join(dir, rest) : dir
    return [base + '.py', P.join(base, '__init__.py')].find((c) => files.has(c)) ?? null
  }
  const byPath = new Map(scan.files.map((f) => [f.path, f]))
  applyMounts(scan.files, (from, spec) => {
    const f = byPath.get(from)
    if (!f) return null
    return JS_LANGS.has(f.lang) ? resolveJs(f, spec) : f.lang === 'python' ? resolvePy(f, spec) : null
  })

  for (const f of scan.files) {
    for (const spec of f.imports) {
      const names = f.importNames[spec] ?? []
      if (JS_LANGS.has(f.lang)) {
        const r = resolveJs(f, spec)
        if (r) add(f.path, r, names)
        else {
          const pkg = jsPkg(spec)
          if (pkg && !(spec.startsWith('@/') || spec.startsWith('~/'))) pkgs.push({ file: f.path, pkg })
        }
      } else if (f.lang === 'python') {
        if (spec.startsWith('.')) {
          const dots = spec.match(/^\.+/)![0].length
          let dir = P.dirname(f.path)
          for (let i = 1; i < dots; i++) dir = P.dirname(dir)
          const rest = spec.slice(dots).replace(/\./g, '/')
          const base = rest ? P.join(dir, rest) : dir
          const hit = [base + '.py', P.join(base, '__init__.py')].find((c) => files.has(c))
          if (hit) add(f.path, hit, names)
          if (!rest) {
            // from . import a, b  → sibling modules
            for (const n of names) {
              const sib = [P.join(dir, n + '.py'), P.join(dir, n, '__init__.py')].find((c) => files.has(c))
              if (sib) add(f.path, sib, [])
            }
          }
        } else {
          const r = pyLookup(spec, f.path)
          if (r) add(f.path, r, names)
          else if (!PY_STDLIB.has(spec.split('.')[0])) pkgs.push({ file: f.path, pkg: spec.split('.')[0] })
        }
      } else if (f.lang === 'go') {
        const mod = goMods.find((m) => spec === m.module || spec.startsWith(m.module + '/'))
        if (mod) {
          const dir = P.join(mod.dir, spec.slice(mod.module.length + 1))
          for (const t of goDirs.get(dir) ?? []) add(f.path, t, [])
        } else if (spec.includes('.')) pkgs.push({ file: f.path, pkg: spec.split('/').slice(0, 3).join('/') })
      } else if (f.lang === 'java' || f.lang === 'kotlin' || f.lang === 'c_sharp') {
        const s = spec.replace(/^static\s+/, '').replace(/\.\*$/, '')
        const hit = fqcn.get(s)
        if (hit) add(f.path, hit, [s.split('.').pop()!])
        else if (nsFiles.has(s)) for (const t of nsFiles.get(s)!) add(f.path, t, [])
        else if (!/^(java|javax|kotlin|System)\b/.test(s)) pkgs.push({ file: f.path, pkg: s.split('.').slice(0, f.lang === 'c_sharp' ? 2 : 3).join('.') })
      } else if (f.lang === 'rust') {
        const s = spec.replace(/\{.*$/, '').replace(/::$/, '')
        const segs = s.split('::')
        const crateRoot = f.path.includes('/src/') ? f.path.slice(0, f.path.indexOf('/src/') + 5) : f.path.startsWith('src/') ? 'src/' : ''
        let baseDir: string | null = null
        if (segs[0] === 'crate') baseDir = crateRoot.replace(/\/$/, '')
        else if (segs[0] === 'super') baseDir = P.dirname(P.dirname(f.path))
        else if (segs[0] === 'self') baseDir = P.dirname(f.path)
        else if (segs.length === 1 && /^[a-z_]\w*$/.test(s)) {
          // `mod x;` → sibling file
          const stem = P.basename(f.path, '.rs')
          const dir = ['main', 'lib', 'mod'].includes(stem) ? P.dirname(f.path) : P.join(P.dirname(f.path), stem)
          const hit = [P.join(dir, s + '.rs'), P.join(dir, s, 'mod.rs')].find((c) => files.has(c))
          if (hit) add(f.path, hit, [])
          continue
        }
        if (baseDir !== null) {
          const rest = segs.slice(1)
          for (let n = rest.length; n > 0; n--) {
            const p = P.join(baseDir, ...rest.slice(0, n))
            const hit = [p + '.rs', P.join(p, 'mod.rs')].find((c) => files.has(c))
            if (hit) {
              add(f.path, hit, rest.slice(n))
              break
            }
          }
        } else if (!['std', 'core', 'alloc'].includes(segs[0])) pkgs.push({ file: f.path, pkg: segs[0] })
      } else if (f.lang === 'php') {
        const tail = spec.replace(/\\/g, '/').split('/').slice(-2).join('/') + '.php'
        const hit = scan.files.find((x) => x.path.endsWith(tail))
        if (hit) add(f.path, hit.path, [spec.split('\\').pop()!])
        else if (spec.includes('\\')) pkgs.push({ file: f.path, pkg: spec.split('\\').slice(0, 2).join('/') })
      } else if (f.lang === 'ruby') {
        const cands = spec.startsWith('.') ? [P.join(P.dirname(f.path), spec)] : [P.join('lib', spec), spec, P.join(P.dirname(f.path), spec)]
        const hit = cands.map((c) => (c.endsWith('.rb') ? c : c + '.rb')).find((c) => files.has(c) || allFiles.has(c))
        if (hit) add(f.path, hit, [])
        else if (!spec.startsWith('.')) pkgs.push({ file: f.path, pkg: spec.split('/')[0] })
      }
    }
  }
  return { deps, pkgs }
}
