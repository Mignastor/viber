import { createHash } from 'crypto'
import { promises as fs } from 'fs'
import path from 'path'
import { ctx } from './context'
import { log } from './git'
import { complete } from './llm'
import { archDir } from './engine/store'

// Git history mapped onto boxes, and AI-written box descriptions.

export interface HistoryCommit {
  sha: string
  author: string
  time: number
  subject: string
  boxes: string[]
  files: number
}

export interface HistoryResult {
  commits: HistoryCommit[]
  boxes: Record<string, { commits: number; authors: string[]; lastTime: number; lastAuthor: string }>
}

export async function history(n = 200): Promise<HistoryResult> {
  const ws = ctx.requireWs()
  const entries = await log(ws.root, n)
  const boxes: HistoryResult['boxes'] = {}
  const commits = entries.map((e) => {
    const touched = [...new Set(e.files.map((f) => ws.ownerOfFile(f)).filter((x): x is string => !!x))]
    for (const b of touched) {
      const s = boxes[b] ?? { commits: 0, authors: [], lastTime: 0, lastAuthor: '' }
      s.commits++
      if (!s.authors.includes(e.author)) s.authors.push(e.author)
      if (e.time > s.lastTime) (s.lastTime = e.time), (s.lastAuthor = e.author)
      boxes[b] = s
    }
    return { sha: e.sha, author: e.author, time: e.time, subject: e.subject, boxes: touched, files: e.files.length }
  })
  return { commits, boxes }
}

// ── Descriptions ───────────────────────────────────────────────────────────────────────

type DescCache = Record<string, { hash: string; text: string }>

const cachePath = (root: string): string => path.join(archDir(root), 'cache', 'descriptions.json')

export async function loadDescriptions(root: string): Promise<Record<string, string>> {
  try {
    const c: DescCache = JSON.parse(await fs.readFile(cachePath(root), 'utf8'))
    return Object.fromEntries(Object.entries(c).map(([k, v]) => [k, v.text]))
  } catch {
    return {}
  }
}

/**
 * Write a one-to-two sentence purpose for every box the user hasn't described. Structure comes
 * from static analysis; the model only writes prose. Results are cached by a hash of what the box
 * contains, so unchanged boxes are never re-described.
 */
export async function describeBoxes(onProgress?: (done: number, total: number) => void): Promise<{ described: number; skipped: number; tokens: number }> {
  const ws = ctx.requireWs()
  const m = ws.built?.model
  if (!m) return { described: 0, skipped: 0, tokens: 0 }
  let cache: DescCache = {}
  try {
    cache = JSON.parse(await fs.readFile(cachePath(ws.root), 'utf8'))
  } catch {
    /* empty */
  }
  const curated = new Set(ws.defs.boxes.filter((b) => b.purpose).map((b) => b.id))
  const targets = m.nodes.filter((n) => n.kind === 'box' && !curated.has(n.id))
  let described = 0
  let skipped = 0
  let tokens = 0
  for (let i = 0; i < targets.length; i++) {
    const n = targets[i]
    onProgress?.(i, targets.length)
    const kids = m.nodes.filter((x) => x.parent === n.id).map((x) => x.label)
    const facts = [
      `Box: ${n.label} (${n.id})${n.tech ? `, ${n.tech}` : ''}`,
      kids.length ? `Contains: ${kids.join(', ')}` : '',
      `Files: ${n.files.slice(0, 25).join(', ')}`,
      n.routes?.length ? `Routes: ${n.routes.slice(0, 15).join(', ')}` : '',
      n.symbols.length ? `Exports:\n${n.symbols.slice(0, 25).map((s) => '- ' + s.signature).join('\n')}` : '',
      `Used by: ${m.edges.filter((e) => e.target === n.id).map((e) => e.source).slice(0, 8).join(', ') || '—'}`,
      `Uses: ${m.edges.filter((e) => e.source === n.id).map((e) => e.target).slice(0, 8).join(', ') || '—'}`
    ]
      .filter(Boolean)
      .join('\n')
    const hash = createHash('sha1').update(facts).digest('hex')
    if (cache[n.id]?.hash === hash) {
      skipped++
      continue
    }
    try {
      const r = await complete(
        'describe',
        'You write one or two plain sentences describing what a module of a codebase is for, for a developer seeing an architecture diagram. Say what it does and for whom, not how. No preamble, no markdown, at most 40 words.',
        facts
      )
      const text = r.text.trim().replace(/^["']|["']$/g, '')
      tokens += r.usage.input + r.usage.output
      if (text) {
        cache[n.id] = { hash, text }
        described++
      }
    } catch (err) {
      throw new Error(`Describing ${n.label} failed: ${(err as Error).message}`)
    }
  }
  await fs.mkdir(path.dirname(cachePath(ws.root)), { recursive: true })
  await fs.writeFile(cachePath(ws.root), JSON.stringify(cache, null, 1))
  ws.descriptions = Object.fromEntries(Object.entries(cache).map(([k, v]) => [k, v.text]))
  ws.rebuild()
  return { described, skipped, tokens }
}
