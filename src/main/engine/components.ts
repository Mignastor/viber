import path from 'path'
import type { ScanFile } from './scan'
import type { FileDep } from './resolve'

// Components from behaviour, not folders: cluster the file dependency graph so that each box is a
// set of files that mostly talk to each other, and talk to the rest of the system through a small
// surface (its contract). Folders only act as a weak tie-breaker.

const P = path.posix

/** Weighted undirected graph over file indexes. */
type Graph = Map<number, Map<number, number>>

function addEdge(g: Graph, a: number, b: number, w: number): void {
  if (!g.has(a)) g.set(a, new Map())
  if (a === b) {
    // Self-loop (internal weight of an aggregated community): counts twice in the node's degree.
    g.get(a)!.set(a, (g.get(a)!.get(a) ?? 0) + 2 * w)
    return
  }
  if (!g.has(b)) g.set(b, new Map())
  g.get(a)!.set(b, (g.get(a)!.get(b) ?? 0) + w)
  g.get(b)!.set(a, (g.get(b)!.get(a) ?? 0) + w)
}

/**
 * Louvain community detection (modularity optimisation, with a resolution parameter).
 * Deterministic: nodes are visited in index order.
 */
export function louvain(n: number, g: Graph, resolution = 1): number[] {
  // Start from singletons on the original graph; aggregate level by level.
  let membership = Array.from({ length: n }, (_, i) => i)
  let graph = g
  let size = n
  for (let level = 0; level < 10; level++) {
    const deg = new Array(size).fill(0)
    let m2 = 0
    for (const [i, nb] of graph) for (const w of nb.values()) (deg[i] += w), (m2 += w)
    if (m2 === 0) break
    const comm = Array.from({ length: size }, (_, i) => i)
    const tot = [...deg]
    let moved = true
    let improved = false
    for (let pass = 0; pass < 20 && moved; pass++) {
      moved = false
      for (let i = 0; i < size; i++) {
        const nb = graph.get(i)
        if (!nb) continue
        const ci = comm[i]
        const links = new Map<number, number>()
        for (const [j, w] of nb) if (j !== i) links.set(comm[j], (links.get(comm[j]) ?? 0) + w)
        tot[ci] -= deg[i]
        let best = ci
        let bestGain = (links.get(ci) ?? 0) - (resolution * tot[ci] * deg[i]) / m2
        for (const [c, kin] of links) {
          const gain = kin - (resolution * tot[c] * deg[i]) / m2
          if (gain > bestGain + 1e-12) (best = c), (bestGain = gain)
        }
        tot[best] += deg[i]
        if (best !== ci) {
          comm[i] = best
          moved = true
          improved = true
        }
      }
    }
    if (!improved) break
    // Renumber communities and fold the graph.
    const ids = new Map<number, number>()
    for (const c of comm) if (!ids.has(c)) ids.set(c, ids.size)
    membership = membership.map((m) => ids.get(comm[m])!)
    const next: Graph = new Map()
    for (const [i, nb] of graph) {
      for (const [j, w] of nb) {
        // Keep internal weight as self-loops so folded communities keep their true degree.
        if (i === j) addEdge(next, ids.get(comm[i])!, ids.get(comm[i])!, w / 2)
        else if (i < j) addEdge(next, ids.get(comm[i])!, ids.get(comm[j])!, w)
      }
    }
    graph = next
    size = ids.size
  }
  // Compact ids.
  const ids = new Map<number, number>()
  return membership.map((m) => (ids.has(m) ? ids.get(m)! : (ids.set(m, ids.size), ids.size - 1)))
}

function modularity(n: number, g: Graph, membership: number[]): number {
  let m2 = 0
  const deg = new Array(n).fill(0)
  for (const [i, nb] of g) for (const w of nb.values()) (deg[i] += w), (m2 += w)
  if (!m2) return 0
  let q = 0
  const tot = new Map<number, number>()
  for (let i = 0; i < n; i++) tot.set(membership[i], (tot.get(membership[i]) ?? 0) + deg[i])
  for (const [i, nb] of g) for (const [j, w] of nb) if (membership[i] === membership[j]) q += w
  for (const t of tot.values()) q -= (t * t) / m2
  return q / m2
}

const STOP = new Set(
  'index main app src lib utils util helpers helper common core base types type models model init mod test tests spec components component pages page api service services handler handlers routes route views view the and of to for in on js ts tsx jsx py go rs java'.split(' ')
)

const GENERIC_DIRS = new Set(['src', 'lib', 'app', 'components', 'pages', 'views', 'utils', 'common', 'core', 'internal', 'pkg', 'modules', 'services', 'shared', 'helpers'])
const ROLE_SUFFIX = /(Page|Screen|View|Controller|Service|Repository|Repo|Model|Handler|Router|Store|Hook|Modal)$/
const ENTRY_STEMS = /^(main|index|app|App|__main__|server|_app|layout)$/

const humanizeWord = (s: string): string =>
  s
    .split(/[-_.\s]+|(?<=[a-z])(?=[A-Z])/)
    .filter(Boolean)
    .map((w) => (w.length <= 3 && w === w.toLowerCase() && /^(api|ui|db|cli|llm|mqtt|io)$/.test(w) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ')

/**
 * Name a component by what it *is*: an API (serves routes), a shared folder, a family of
 * pages/services, an app shell (entry points), or its most central file.
 */
export function nameComponent(files: ScanFile[], deps: FileDep[], fallback: string, genericDirs: Set<string> = new Set()): string {
  const n = files.length
  const routeFiles = files.filter((f) => f.routes.length > 0)
  if (routeFiles.length >= Math.max(1, n * 0.6) && routeFiles.reduce((a, f) => a + f.routes.length, 0) >= 2) {
    // Common route prefix, ignoring "api" and params: /api/admin/x, /api/admin/y → "Admin API".
    const segs = routeFiles.flatMap((f) => f.routes.map((r) => r.path.split('/').filter((s) => s && s !== 'api' && !s.startsWith(':') && !s.startsWith('{'))))
    const first = new Map<string, number>()
    for (const s of segs) if (s[0]) first.set(s[0], (first.get(s[0]) ?? 0) + 1)
    const top = [...first.entries()].sort((a, b) => b[1] - a[1])[0]
    return top && top[1] >= segs.length * 0.6 ? `${humanizeWord(top[0])} API` : 'API'
  }
  // Shared, meaningful folder.
  const dirCount = new Map<string, number>()
  for (const f of files) {
    const d = P.basename(P.dirname(f.path))
    if (d && d !== '.' && !GENERIC_DIRS.has(d.toLowerCase()) && !genericDirs.has(d) && !/^[[(]/.test(d)) dirCount.set(d, (dirCount.get(d) ?? 0) + 1)
  }
  const topDir = [...dirCount.entries()].sort((a, b) => b[1] - a[1])[0]
  if (topDir && topDir[1] >= Math.max(2, n * 0.6)) return humanizeWord(topDir[0])
  // A family: most files share a role suffix (FooPage, BarPage → Pages).
  const stems = files.map((f) => P.basename(f.path).replace(/\.\w+$/, ''))
  const suffix = new Map<string, number>()
  for (const s of stems) {
    const m = s.match(ROLE_SUFFIX)
    if (m) suffix.set(m[1], (suffix.get(m[1]) ?? 0) + 1)
  }
  const topSuffix = [...suffix.entries()].sort((a, b) => b[1] - a[1])[0]
  if (topSuffix && topSuffix[1] >= Math.max(3, n * 0.6)) return humanizeWord(topSuffix[0]) + 's'
  if (stems.some((s) => ENTRY_STEMS.test(s)) && files.some((f) => f.flags.includes('component') || f.flags.includes('entry'))) return 'App shell'
  if (n >= 8 && !files.some((f) => f.flags.includes('component'))) return 'Core'
  // Most central file (most links inside the component), skipping generic stems.
  const inside = new Set(files.map((f) => f.path))
  const degree = new Map<string, number>()
  for (const d of deps) {
    if (inside.has(d.from) && inside.has(d.to)) {
      degree.set(d.from, (degree.get(d.from) ?? 0) + 1)
      degree.set(d.to, (degree.get(d.to) ?? 0) + 1)
    }
  }
  const central = [...files]
    .map((f) => ({ f, stem: P.basename(f.path).replace(/\.\w+$/, ''), deg: degree.get(f.path) ?? 0 }))
    .filter((x) => !ENTRY_STEMS.test(x.stem) && !STOP.has(x.stem.toLowerCase()))
    .sort((a, b) => b.deg - a.deg || b.f.lines - a.f.lines)[0]
  if (central) return humanizeWord(central.stem)
  return nameCluster(files, fallback)
}

function centralName(files: ScanFile[], deps: FileDep[]): string | null {
  const inside = new Set(files.map((f) => f.path))
  const degree = new Map<string, number>()
  for (const d of deps) if (inside.has(d.from) && inside.has(d.to)) for (const p of [d.from, d.to]) degree.set(p, (degree.get(p) ?? 0) + 1)
  const best = [...files]
    .map((f) => ({ stem: P.basename(f.path).replace(/\.\w+$/, ''), deg: degree.get(f.path) ?? 0, lines: f.lines }))
    .filter((x) => !ENTRY_STEMS.test(x.stem) && !STOP.has(x.stem.toLowerCase()))
    .sort((a, b) => b.deg - a.deg || b.lines - a.lines)[0]
  return best ? humanizeWord(best.stem) : null
}

/** Name a cluster from the words its files and exported symbols share. */
export function nameCluster(files: ScanFile[], fallback: string): string {
  const counts = new Map<string, number>()
  const bump = (w: string, by: number): void => {
    const k = w.toLowerCase()
    if (k.length < 3 || STOP.has(k) || /^\d+$/.test(k)) return
    counts.set(k, (counts.get(k) ?? 0) + by)
  }
  const words = (s: string): string[] => s.split(/[^A-Za-z0-9]+|(?<=[a-z])(?=[A-Z])/).filter(Boolean)
  for (const f of files) {
    for (const w of words(P.basename(f.path).replace(/\.\w+$/, ''))) bump(w, 3)
    for (const w of words(P.basename(P.dirname(f.path)))) bump(w, 1)
    for (const s of f.symbols.filter((x) => x.exported).slice(0, 8)) for (const w of words(s.name)) bump(w, 1)
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  if (!top.length) return fallback
  const [w1, c1] = top[0]
  const second = top[1] && top[1][1] >= c1 * 0.75 ? top[1][0] : null
  const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)
  return second ? `${cap(w1)} & ${cap(second)}` : cap(w1)
}

/** Replace file lists by folder prefixes wherever a folder belongs entirely to one box. */
export function compressPaths(files: string[], ownerOf: Map<string, string>, box: string): string[] {
  const mine = new Set(files)
  const dirs = new Map<string, { total: number; mine: number }>()
  for (const [f, owner] of ownerOf) {
    let d = P.dirname(f)
    while (d && d !== '.') {
      const s = dirs.get(d) ?? { total: 0, mine: 0 }
      s.total++
      if (owner === box) s.mine++
      dirs.set(d, s)
      d = P.dirname(d)
    }
  }
  const out: string[] = []
  const covered = new Set<string>()
  // Shallowest fully-owned folders first.
  const full = [...dirs.entries()].filter(([, s]) => s.total === s.mine && s.total > 1).map(([d]) => d).sort((a, b) => a.length - b.length)
  for (const d of full) {
    if (out.some((o) => d.startsWith(o + '/'))) continue
    out.push(d)
    for (const f of mine) if (f.startsWith(d + '/')) covered.add(f)
  }
  for (const f of mine) if (!covered.has(f)) out.push(f)
  return out.sort()
}

export interface Cluster {
  files: ScanFile[]
  name: string
  shared: boolean
}

/**
 * Split a set of files into components. Returns clusters sized for a readable diagram: between
 * `min` and `max` clusters when the code allows it; tiny clusters merge into their best neighbour.
 */
export function clusterFiles(files: ScanFile[], deps: FileDep[], opts: { min?: number; max?: number; fallbackName: string; genericDirs?: Set<string>; reserved?: string[] }): Cluster[] {
  const min = opts.min ?? 3
  const max = opts.max ?? 9
  // Tooling config (vite.config.js, next.config.mjs, tailwind…) belongs to the unit, not a component.
  files = files.filter((f) => !/(^|\/)[\w.-]*\.config\.[cm]?[jt]s$|(^|\/)(setup|conftest)\.py$/.test(f.path))
  if (files.length < 8) return [{ files, name: opts.fallbackName, shared: false }]
  const index = new Map(files.map((f, i) => [f.path, i]))
  const g: Graph = new Map()
  for (const d of deps) {
    const a = index.get(d.from)
    const b = index.get(d.to)
    if (a === undefined || b === undefined) continue
    addEdge(g, a, b, 1 + Math.min(4, d.names.length) * 0.5)
  }
  // Weak folder affinity keeps unconnected siblings together without letting folders dominate.
  const ancestorAt = (p: string, up: number): string => {
    let d = P.dirname(p)
    for (let k = 0; k < up && d !== '.'; k++) d = P.dirname(d)
    return d
  }
  for (const [up, w] of [[0, 0.35], [1, 0.18], [2, 0.08]] as const) {
    const byDir = new Map<string, number[]>()
    files.forEach((f, i) => {
      const d = ancestorAt(f.path, up)
      if (d !== '.') byDir.set(d, [...(byDir.get(d) ?? []), i])
    })
    for (const ids of byDir.values()) for (let k = 1; k < ids.length; k++) addEdge(g, ids[k - 1], ids[k], w)
  }

  // Shared kernel: files depended on by many others across the graph (models, config, utils).
  const inDeg = new Map<number, Set<number>>()
  for (const d of deps) {
    const a = index.get(d.from)
    const b = index.get(d.to)
    if (a !== undefined && b !== undefined && a !== b) inDeg.set(b, new Set([...(inDeg.get(b) ?? []), a]))
  }
  const hubThreshold = Math.max(5, Math.round(files.length * 0.25))
  const hubs = new Set([...inDeg.entries()].filter(([, s]) => s.size >= hubThreshold).map(([i]) => i))

  // Interface layers are boundaries by definition: an HTTP layer and a CLI are components of their own,
  // even though they import everything (which would otherwise glue them to the domain).
  const apiFiles = new Set(files.map((f, i) => (f.routes.length >= 5 ? i : -1)).filter((i) => i >= 0))
  const cliFiles = new Set(files.map((f, i) => (f.flags.includes('cli') && !apiFiles.has(i) ? i : -1)).filter((i) => i >= 0))
  const pinned = new Set([...apiFiles, ...cliFiles])
  for (const i of pinned) hubs.delete(i)

  // Pick the resolution giving a cluster count in range with the best modularity.
  const skip = (i: number): boolean => hubs.has(i) || pinned.has(i)
  const core = new Map([...g].filter(([i]) => !skip(i)).map(([i, nb]) => [i, new Map([...nb].filter(([j]) => !skip(j)))]))
  let best: number[] | null = null
  let bestScore = -Infinity
  for (const r of [0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3]) {
    const m = louvain(files.length, core, r)
    const sizes = new Map<number, number>()
    files.forEach((_, i) => !skip(i) && sizes.set(m[i], (sizes.get(m[i]) ?? 0) + 1))
    const count = [...sizes.values()].filter((s) => s >= 2).length
    const inRange = count >= min && count <= max
    const score = modularity(files.length, core, m) + (inRange ? 1 : -Math.abs(count < min ? min - count : count - max) * 0.05)
    if (score > bestScore) (bestScore = score), (best = m)
  }
  const membership = best!

  // Merge tiny clusters into the neighbour they talk to most (one-file components are noise).
  const groups = new Map<number, number[]>()
  files.forEach((_, i) => {
    if (skip(i)) return
    groups.set(membership[i], [...(groups.get(membership[i]) ?? []), i])
  })
  const API = -1
  const CLI = -2
  if (apiFiles.size) groups.set(API, [...apiFiles])
  if (cliFiles.size) groups.set(CLI, [...cliFiles])
  for (const i of apiFiles) membership[i] = API
  for (const i of cliFiles) membership[i] = CLI
  const minSize = Math.max(2, Math.floor(files.length / 30))
  for (const [c, ids] of [...groups.entries()].sort((a, b) => a[1].length - b[1].length)) {
    if (c === API || c === CLI || ids.length >= minSize || groups.size <= min) continue
    const votes = new Map<number, number>()
    for (const i of ids) for (const [j, w] of g.get(i) ?? []) if (membership[j] !== c && membership[j] >= 0 && groups.has(membership[j])) votes.set(membership[j], (votes.get(membership[j]) ?? 0) + w)
    const target = [...votes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
    if (target === undefined) continue
    for (const i of ids) membership[i] = target
    groups.set(target, [...groups.get(target)!, ...ids])
    groups.delete(c)
  }

  for (const [c, ids] of [...groups]) {
    if (c === API || c === CLI || ids.length > 1) continue
    const linked = (g.get(ids[0]) ? [...g.get(ids[0])!].some(([j, w]) => w >= 1 && membership[j] !== c) : false)
    if (!linked) groups.delete(c)
  }

  // A file imported from three or more *other* components is shared infrastructure (db, config,
  // api client…): it joins the shared kernel instead of making one component look central.
  for (const [c, ids] of groups) {
    for (const i of [...ids]) {
      const users = new Set<number>()
      for (const d of deps) {
        if (index.get(d.to) !== i) continue
        const from = index.get(d.from)
        if (from !== undefined && !hubs.has(from) && membership[from] !== c) users.add(membership[from])
      }
      if (users.size >= 3 && ids.length > 1) {
        hubs.add(i)
        groups.set(c, groups.get(c)!.filter((x) => x !== i))
      }
    }
  }

  const clusters: Cluster[] = [...groups.entries()]
    .filter(([, ids]) => ids.length)
    .map(([c, ids]) => {
      const fs = ids.map((i) => files[i])
      const name = c === CLI ? 'CLI' : nameComponent(fs, deps, opts.fallbackName, opts.genericDirs)
      return { files: fs, name, shared: false }
    })
  if (hubs.size) {
    const fs = [...hubs].map((i) => files[i])
    clusters.push({ files: fs, name: 'Shared kernel', shared: true })
  }
  // Disambiguate duplicate names with each one's most central file ("Pages" → "Goals Page").
  const taken = new Set<string>(opts.reserved ?? [])
  for (const c of [...clusters].sort((a, b) => b.files.length - a.files.length)) {
    if (taken.has(c.name)) {
      const alt = centralName(c.files, deps)
      c.name = alt && !taken.has(alt) ? alt : c.name
      let k = 2
      while (taken.has(c.name)) c.name = `${c.name.replace(/ \d+$/, '')} ${k++}`
    }
    taken.add(c.name)
  }
  return clusters.sort((a, b) => b.files.length - a.files.length)
}
