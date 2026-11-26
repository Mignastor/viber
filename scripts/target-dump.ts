// Dev helper: npx tsx --tsconfig tsconfig.node.json scripts/target-dump.ts <repo> "<task>" [usages-target]
import path from 'path'
import { scanRepo } from '../src/main/engine/scan'
import { resolveImports } from '../src/main/engine/resolve'
import { buildModel, emptyDefs, ownerOf } from '../src/main/engine/build'
import { buildCoChange, findUsages, predictionsText, whereToChange } from '../src/main/targeting'

const [repo, task, usage] = process.argv.slice(2)
const root = path.resolve(repo)
;(async () => {
  const scan = await scanRepo(root)
  const res = resolveImports(scan)
  const built = buildModel(scan, res, emptyDefs('x'), { includeProposals: true })
  const files = new Map(scan.files.map((f) => [f.path, f]))
  const boxes = built.model.nodes.filter((n) => n.kind === 'box').map((n) => ({ id: n.id, label: n.label, paths: n.paths ?? [] }))
  const ws = {
    root,
    built,
    res,
    coChange: await buildCoChange(root),
    allFiles: () => scan.files,
    fileInfo: (p: string) => files.get(p),
    ownerOfFile: (p: string) => built.fileOwner[p] ?? ownerOf(boxes, p)
  } as never
  console.log(predictionsText(whereToChange(ws, task)))
  if (usage) console.log('\n--- find_usages ' + usage + '\n' + (await findUsages(ws, root, usage)))
})()
