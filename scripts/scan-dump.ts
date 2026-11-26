// Dev helper: npx tsx --tsconfig tsconfig.node.json scripts/scan-dump.ts <repo> [sampleFiles]
import { scanRepo } from '../src/main/engine/scan'
const root = process.argv[2] ?? '.'
scanRepo(root).then((r) => {
  const syms = r.files.reduce((a, f) => a + f.symbols.length, 0)
  const routes = r.files.flatMap((f) => f.routes.map((x) => `${x.method} ${x.path}  (${f.path})`))
  const calls = r.files.flatMap((f) => f.calls.map((x) => `${x.method} ${x.url}  (${f.path})`))
  const flags = r.files.filter((f) => f.flags.length).map((f) => `${f.path}: ${f.flags.join(',')}`)
  console.log(JSON.stringify({ files: r.files.length, all: r.allPaths.length, languages: r.languages, symbols: syms, ms: r.durationMs, manifests: Object.keys(r.manifests).slice(0, 12) }))
  console.log('ROUTES', routes.slice(0, 8))
  console.log('CALLS', calls.slice(0, 6))
  console.log('FLAGS', flags.slice(0, 8))
  const rich = [...r.files].sort((a, b) => b.symbols.length - a.symbols.length).slice(0, Number(process.argv[3] ?? 1))
  for (const f of rich) console.log(f.path, f.imports.slice(0, 6), f.symbols.slice(0, 6).map((s) => `${s.exported ? '+' : '-'}${s.kind} ${s.signature} @${s.line}`))
})
