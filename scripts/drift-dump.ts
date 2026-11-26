// Dev helper: print the drift of a repo with a saved .arch/model.yaml.  npx tsx scripts/drift-dump.ts <repo>
import { scanRepo } from '../src/main/engine/scan'
import { resolveImports } from '../src/main/engine/resolve'
import { buildModel } from '../src/main/engine/build'
import { loadDefs } from '../src/main/engine/store'

const root = process.argv[2]
;(async () => {
  const defs = await loadDefs(root)
  if (!defs) throw new Error('no .arch/model.yaml')
  const scan = await scanRepo(root)
  const { model } = buildModel(scan, resolveImports(scan), defs, { includeProposals: false })
  for (const n of model.nodes.filter((x) => x.kind === 'box')) console.log(`${n.id}: ${n.files.length} files, routes ${JSON.stringify(n.routes ?? [])}, checks ${JSON.stringify(n.contractCheck ?? {})}`)
  console.log('edges', model.edges.map((e) => `${e.source}->${e.target} ${e.kind}${e.planned ? ' (planned)' : ''}`))
  console.log('drift', model.drift?.map((d) => `${d.kind}: ${d.detail}`))
})()
