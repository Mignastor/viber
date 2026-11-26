import path from 'path'
import type { ScanResult } from './scan'
import { detectFramework } from './detect'
import { LANGS } from './languages'
import type { FileDep } from './resolve'
import { clusterFiles, compressPaths } from './components'

// Proposes the box hierarchy from the folder structure. This is only a first guess: the user
// renames, merges and splits boxes in the curation step, and model.yaml remembers their choices.

const P = path.posix

export interface BoxDef {
  id: string
  label: string
  parent?: string
  /** Directory prefixes ("server/auth") or exact files owned by this box. */
  paths: string[]
  purpose?: string
  rules?: string[]
  tech?: string
  role?: 'frontend' | 'backend' | 'mobile' | 'desktop' | 'data' | 'tests' | null
  declared?: boolean
  spec?: import('@shared/model').BoxSpec
}

const MIN_FILES = 2
const MIN_LINES = 150
const MAX_CHILDREN = 10
const MAX_DEPTH = 3
const PASS_THROUGH = new Set(['src', 'lib', 'app', 'source', 'pkg', 'internal', 'main', 'java', 'kotlin', 'python'])
const MANIFEST_RE = /(^|\/)(package\.json|pyproject\.toml|go\.mod|Cargo\.toml|pom\.xml|build\.gradle(\.kts)?|[^/]+\.csproj|composer\.json|Gemfile|requirements\.txt|pubspec\.yaml)$/
const MONO_DIRS = new Set(['packages', 'apps', 'services', 'libs', 'modules', 'crates', 'cmd'])

interface Dir {
  path: string
  files: string[]
  total: number
  lines: number
  subdirs: Map<string, Dir>
}

const ACRONYMS: Record<string, string> = { api: 'API', ui: 'UI', db: 'DB', ml: 'ML', ai: 'AI', cli: 'CLI', auth: 'Auth', iot: 'IoT', aws: 'AWS', mcp: 'MCP', llm: 'LLM', sdk: 'SDK', http: 'HTTP' }

export function humanize(name: string): string {
  const clean = name.replace(/^\((.*)\)$/, '$1').replace(/^\[\.\.\.(\w+)\]$/, '$1…').replace(/^\[(\w+)\]$/, ':$1')
  return clean
    .split(/[-_.\s]+|(?<=[a-z])(?=[A-Z])/)
    .filter(Boolean)
    .map((w) => ACRONYMS[w.toLowerCase()] ?? w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

/**
 * Level 1: deployable units (separate processes/apps that talk over HTTP, queues, SDKs).
 * Levels 2-3: components found by clustering the dependency graph inside each unit, so a box is a
 * set of files that mostly talk to each other. Without dependency data, falls back to folders.
 */
export function proposeBoxes(scan: ScanResult, projectName: string, deps?: FileDep[]): BoxDef[] {
  const code = scan.files.filter((f) => !f.flags.includes('test'))
  if (!code.length) return [] // a new, empty project: the human designs the boxes
  const lines = new Map(code.map((f) => [f.path, f.lines]))

  // Directory tree with recursive counts.
  const root: Dir = { path: '', files: [], total: 0, lines: 0, subdirs: new Map() }
  for (const f of code) {
    const segs = f.path.split('/')
    let d = root
    d.total++
    d.lines += f.lines
    for (const s of segs.slice(0, -1)) {
      const p = d.path ? `${d.path}/${s}` : s
      if (!d.subdirs.has(s)) d.subdirs.set(s, { path: p, files: [], total: 0, lines: 0, subdirs: new Map() })
      d = d.subdirs.get(s)!
      d.total++
      d.lines += f.lines
    }
    d.files.push(f.path)
  }

  const significant = (d: Dir): boolean =>
    !/^(tests?|__tests__|spec|e2e|fixtures|mocks?|examples?|docs?|scripts)$/.test(P.basename(d.path)) &&
    !/[0-9a-f]{16,}/.test(P.basename(d.path)) && // generated asset folders
    (d.total >= MIN_FILES || d.lines >= MIN_LINES)
  const sigSubdirs = (d: Dir): Dir[] => [...d.subdirs.values()].filter(significant).sort((a, b) => b.lines - a.lines)

  /** Skip wrapper folders like src/ that hold everything and add no meaning. */
  const descend = (d: Dir): Dir => {
    let cur = d
    for (;;) {
      const subs = sigSubdirs(cur)
      const looseLines = cur.files.reduce((a, f) => a + (lines.get(f) ?? 0), 0)
      if (subs.length === 1 && (PASS_THROUGH.has(P.basename(subs[0].path)) || looseLines < 80) && subs[0].total >= cur.total * 0.7) cur = subs[0]
      else return cur
    }
  }

  const manifests = Object.entries(scan.manifests)
  const techFor = (dirPath: string): { tech?: string; role?: BoxDef['role'] } => {
    // Nearest manifest at or above this directory.
    let best: [string, string] | null = null
    for (const [p, txt] of manifests) {
      if (!MANIFEST_RE.test(p) && !p.endsWith('package.json')) continue
      const dir = P.dirname(p) === '.' ? '' : P.dirname(p)
      if ((dir === '' || dirPath === dir || dirPath.startsWith(dir + '/')) && (!best || dir.length > P.dirname(best[0]).length)) best = [p, txt]
    }
    const fw = best ? detectFramework(best[1]) : null
    if (fw) return { tech: fw.tech, role: fw.role }
    // Fall back on the dominant language.
    const counts = new Map<string, number>()
    for (const f of code) if (!dirPath || f.path.startsWith(dirPath + '/')) counts.set(LANGS[f.lang].label, (counts.get(LANGS[f.lang].label) ?? 0) + f.lines)
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]
    return { tech: top?.[0] }
  }

  const boxes: BoxDef[] = []
  const used = new Set<string>()
  const addBox = (d: Dir, parent: string | undefined, labelDir?: Dir): BoxDef => {
    let id = d.path || 'root'
    while (used.has(id)) id += '_'
    used.add(id)
    const t = techFor(d.path)
    const box: BoxDef = { id, label: humanize(P.basename((labelDir ?? d).path) || projectName), parent, paths: [d.path], tech: t.tech, role: t.role ?? null }
    boxes.push(box)
    return box
  }

  const grow = (d: Dir, parent: BoxDef, depth: number): void => {
    if (depth > MAX_DEPTH) return
    const inner = descend(d)
    let subs = sigSubdirs(inner)
    if (subs.length < 2 && depth > 1) return // a single sub-folder adds no structure
    if (subs.length > MAX_CHILDREN) subs = subs.slice(0, MAX_CHILDREN - 1) // the rest folds into the parent
    for (const s of subs) {
      const child = descend(s)
      const box = addBox(child, parent.id, s)
      grow(child, box, depth + 1)
    }
  }

  // ── Level 1: deployable units ───────────────────────────────────────────────────────────
  const top = descend(root)
  const unitDirs = new Set<string>()
  for (const [p] of manifests) {
    if (!MANIFEST_RE.test(p)) continue
    const dir = P.dirname(p)
    if (dir !== '.' && dir !== top.path) unitDirs.add(dir)
  }
  const findDir = (p: string): Dir | null => {
    let d: Dir | undefined = root
    for (const s of p.split('/')) {
      d = d?.subdirs.get(s)
      if (!d) return null
    }
    return d
  }
  // Monorepo containers: packages/*, apps/*, services/* each become a unit.
  for (const d of sigSubdirs(top)) if (MONO_DIRS.has(P.basename(d.path))) for (const s of sigSubdirs(d)) unitDirs.add(s.path)

  let units = [...unitDirs]
    .map(findDir)
    .filter((d): d is Dir => !!d && significant(d))
    // keep outermost units only
    .filter((d, _i, arr) => !arr.some((o) => o !== d && d.path.startsWith(o.path + '/')))

  const topLevel = sigSubdirs(top).filter((d) => !MONO_DIRS.has(P.basename(d.path)) || !units.some((u) => u.path.startsWith(d.path + '/')))
  if (units.length < 2) units = topLevel
  else for (const d of topLevel) if (!units.some((u) => u.path === d.path || u.path.startsWith(d.path + '/') || d.path.startsWith(u.path + '/'))) units.push(d)

  if (units.length === 0) {
    // Flat project: one box per significant file group is overkill — a single root box.
    const b = addBox(top, undefined)
    b.label = humanize(projectName)
    return boxes
  }

  const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'part'
  const addComponent = (id: string, label: string, parent: string, paths: string[], tech?: string): BoxDef => {
    let k = id
    while (used.has(k)) k += '_'
    used.add(k)
    const b: BoxDef = { id: k, label, parent, paths, tech, role: null }
    boxes.push(b)
    return b
  }
  /** Cluster `files` into components under `parent`; recurse once for big components. */
  const leafOwner = new Map<string, string>() // file → deepest component id
  const subtree = new Map<string, string[]>() // component id → all files under it
  const componentize = (parent: BoxDef, files: ScanResult['files'], depth: number): boolean => {
    const local = new Set(files.map((f) => f.path))
    const localDeps = (deps ?? []).filter((d) => local.has(d.from) && local.has(d.to))
    // The unit's own folders ("myapp", "src") don't name a component.
    const genericDirs = new Set((parent.paths[0] ?? '').split('/').filter(Boolean))
    const clusters = clusterFiles(files, localDeps, { min: depth === 2 ? 3 : 2, max: depth === 2 ? 9 : 6, fallbackName: parent.label, genericDirs, reserved: depth > 2 ? [parent.label] : [] })
    if (clusters.length < 2) return false
    for (const c of clusters) {
      const box = addComponent(`${parent.id}/${slug(c.name)}`, c.name, parent.id, [], parent.tech)
      subtree.set(box.id, c.files.map((f) => f.path))
      for (const f of c.files) leafOwner.set(f.path, box.id)
      if (depth < MAX_DEPTH && c.files.length > 14) componentize(box, c.files, depth + 1)
    }
    return true
  }

  for (const u of units) {
    const box = addBox(u, undefined)
    const unitFiles = code.filter((f) => !u.path || f.path.startsWith(u.path + '/'))
    // Components from behaviour when we know the dependencies; folders only as a fallback.
    if (!deps) grow(u, box, 2)
    else if (componentize(box, unitFiles, 2)) {
      // Paths are computed once ownership is final for the whole unit: a component owns whole
      // folders only when every file in them is its own (or its sub-components').
      const unitOwner = new Map(unitFiles.map((f) => [f.path, leafOwner.get(f.path) ?? box.id]))
      for (const b of boxes.filter((x) => subtree.has(x.id) && x.id.startsWith(box.id + '/'))) {
        const mine = new Set(subtree.get(b.id))
        const owner = new Map([...unitOwner].map(([f]) => [f, mine.has(f) ? b.id : '~']))
        const paths = compressPaths([...mine], owner, b.id)
        // A component with sub-components keeps only folder prefixes: its children own the files.
        const hasKids = boxes.some((x) => x.parent === b.id)
        b.paths = hasKids ? paths.filter((p) => !/\.\w+$/.test(p)) : paths
      }
    }
  }

  // Loose files at the top that no unit covers (main.py, server.js…) get their own box.
  const loose = top.files.filter((f) => !units.some((u) => f.startsWith(u.path + '/')))
  if (loose.length) {
    const looseLines = loose.reduce((a, f) => a + (lines.get(f) ?? 0), 0)
    if (loose.length >= 2 || looseLines >= 60) {
      let id = (top.path ? top.path + '/' : '') + '(root)'
      while (used.has(id)) id += '_'
      boxes.push({ id, label: top.path ? humanize(P.basename(top.path)) + ' entry' : 'Entry points', paths: loose, ...techFor(top.path), role: null })
    }
  }
  return boxes
}
