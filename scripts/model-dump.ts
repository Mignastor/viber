// Dev helper: npx tsx --tsconfig tsconfig.node.json scripts/model-dump.ts <repo>
import path from 'path'
import { scanRepo } from '../src/main/engine/scan'
import { resolveImports } from '../src/main/engine/resolve'
import { buildModel, emptyDefs } from '../src/main/engine/build'
const root = path.resolve(process.argv[2] ?? '.')
scanRepo(root).then((scan) => {
  const res = resolveImports(scan)
  const { model, unmapped } = buildModel(scan, res, emptyDefs(path.basename(root)), { includeProposals: true })
  const depth = (id: string): number => { let d = 0, n = model.nodes.find((x) => x.id === id); while (n?.parent) { d++; n = model.nodes.find((x) => x.id === n!.parent) } return d }
  console.log(`deps=${res.deps.length} pkgs=${res.pkgs.length} unmapped=${unmapped.length} ${unmapped.slice(0, 5).join(' ')}`)
  for (const n of model.nodes) console.log('  '.repeat(depth(n.id)) + `[${n.kind}${n.actorType ? ':' + n.actorType : ''}] ${n.label}  (${n.id}) ${n.tech ?? ''} files=${n.files.length} ${n.evidence ? 'ev=' + n.evidence.join('; ') : ''}`)
  console.log('EDGES', model.edges.length)
  for (const e of model.edges.slice(0, Number(process.argv[3] ?? 25))) console.log(`  ${e.source} -> ${e.target} [${e.kind}] ${e.label} | ${e.contract.slice(0, 3).join(' ; ')}`)
})
