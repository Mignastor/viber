// Edit-site benchmark: how well does where_to_change predict the files a real commit changed, from its
// message alone? For each commit, the repo is checked out at the parent (so history can't leak), the
// model is built, and predictions are compared with the commit's changed source files. A keyword-search
// baseline (what an agent gets from grep) runs on the same commits.
//
//   npx tsx scripts/edit-site-bench.ts <clone of a repo> [commits=40]
// Use a throwaway clone: the script checks out old commits.

import { promises as fs } from 'fs'
import path from 'path'
import { scanRepo } from '../src/main/engine/scan'
import { resolveImports } from '../src/main/engine/resolve'
import { buildModel, emptyDefs, ownerOf } from '../src/main/engine/build'
import { langOf } from '../src/main/engine/languages'
import { BODY_WEIGHT, buildCoChange, buildSymbolCoChange, setBodyWeight, whereToChange } from '../src/main/targeting'
import { keywords } from '../src/main/contextPack'
import { git } from '../src/main/git'

const root = path.resolve(process.argv[2] ?? '.')
const limit = Number(process.argv[3] ?? 40)
// VIBER_BODY_WEIGHTS=0,0.5,1 compares several body-text weights in one pass.
const weights = (process.env.VIBER_BODY_WEIGHTS ?? String(BODY_WEIGHT)).split(',').map(Number)

interface Score {
  hit1: number
  hit3: number
  recall5: number
  mrr: number
}
const empty = (): Score => ({ hit1: 0, hit3: 0, recall5: 0, mrr: 0 })

function score(ranked: string[], truth: Set<string>, s: Score): void {
  const firstHit = ranked.findIndex((f) => truth.has(f))
  if (firstHit === 0) s.hit1++
  if (firstHit >= 0 && firstHit < 3) s.hit3++
  if (firstHit >= 0) s.mrr += 1 / (firstHit + 1)
  s.recall5 += ranked.slice(0, 5).filter((f) => truth.has(f)).length / truth.size
}

async function grepRank(files: string[], message: string): Promise<string[]> {
  const kws = keywords(message).map((k) => k.toLowerCase())
  const scored: [string, number][] = []
  for (const f of files) {
    const text = (await fs.readFile(path.join(root, f), 'utf8').catch(() => '')).toLowerCase()
    let s = 0
    for (const k of kws) {
      s += Math.min(20, text.split(k).length - 1)
      if (f.toLowerCase().includes(k)) s += 5
    }
    if (s > 0) scored.push([f, s])
  }
  return scored.sort((a, b) => b[1] - a[1]).map(([f]) => f)
}

;(async () => {
  const head = (await git(root, ['rev-parse', 'HEAD'])).stdout.trim()
  const log = (await git(root, ['log', '--no-merges', '--format=%H%x09%s', '-n', '400'])).stdout.trim().split('\n')
  const commits: { sha: string; msg: string; files: string[] }[] = []
  for (const line of log) {
    const [sha, msg] = line.split('\t')
    if (!msg || msg.split(/\s+/).length < 3) continue
    const changed = (await git(root, ['show', '--name-only', '--format=', sha])).stdout.split('\n').map((s) => s.trim()).filter(Boolean)
    const src = changed.filter((f) => langOf(f) && !/(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.|(^|\/)test_/.test(f))
    const parent = await git(root, ['rev-parse', '--verify', '-q', `${sha}^`])
    if (src.length >= 1 && src.length <= 6 && parent.code === 0) commits.push({ sha, msg, files: src })
    if (commits.length >= limit) break
  }
  const viber = weights.map(() => empty())
  const grep = empty()
  let n = 0
  const rows: string[] = []
  try {
    for (const c of commits) {
      await git(root, ['checkout', '-q', '-f', `${c.sha}^`])
      const scan = await scanRepo(root)
      const existing = new Set(scan.files.map((f) => f.path))
      const truth = new Set(c.files.filter((f) => existing.has(f))) // edits to files that existed before
      if (!truth.size) continue
      const res = resolveImports(scan)
      const built = buildModel(scan, res, emptyDefs(path.basename(root)), { includeProposals: true })
      const files = new Map(scan.files.map((f) => [f.path, f]))
      const boxes = built.model.nodes.filter((x) => x.kind === 'box').map((x) => ({ id: x.id, label: x.label, paths: x.paths ?? [] }))
      const ws = {
        root,
        built,
        res,
        coChange: await buildCoChange(root),
        symbolCoChange: await buildSymbolCoChange(root),
        allFiles: () => scan.files,
        fileInfo: (p: string) => files.get(p),
        ownerOfFile: (p: string) => built.fileOwner[p] ?? ownerOf(boxes, p)
      } as never
      let v: string[] = []
      weights.forEach((w, i) => {
        setBodyWeight(w)
        const r = whereToChange(ws, c.msg, { limit: 10 }).map((p) => p.file)
        score(r, truth, viber[i])
        if (i === weights.length - 1) v = r
      })
      const g = await grepRank(scan.files.map((f) => f.path), c.msg)
      score(g, truth, grep)
      n++
      const mark = (r: string[]): string => (truth.has(r[0]) ? '✓' : r.slice(0, 3).some((f) => truth.has(f)) ? '~' : '✗')
      rows.push(`${mark(v)} ${mark(g)}  ${c.sha.slice(0, 7)} ${c.msg.slice(0, 70)}`)
    }
  } finally {
    await git(root, ['checkout', '-q', '-f', head])
  }
  const pct = (x: number): string => `${Math.round((100 * x) / Math.max(1, n))}%`
  console.log(rows.join('\n'))
  console.log(`\n${n} commits  (columns: Viber, grep; ✓ top-1 hit, ~ in top 3, ✗ miss)`)
  console.log(`              hit@1   hit@3   recall@5   MRR`)
  for (const [name, s] of [...weights.map((w, i) => [`viber body=${w}`, viber[i]] as const), ['keyword grep', grep] as const])
    console.log(`${name.padEnd(16)} ${pct(s.hit1).padStart(5)}   ${pct(s.hit3).padStart(5)}   ${pct(s.recall5).padStart(7)}   ${(s.mrr / Math.max(1, n)).toFixed(2)}`)
})()
