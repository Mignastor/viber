// Dev helper: functions that change together in a repo's history.  npx tsx scripts/cochange-dump.ts <repo>
import { buildSymbolCoChange } from '../src/main/targeting'

;(async () => {
  const m = await buildSymbolCoChange(process.argv[2])
  const pairs: [string, string, number][] = []
  for (const [a, others] of m) for (const [b, n] of others) if (a < b && n >= 2) pairs.push([a, b, n])
  pairs.sort((x, y) => y[2] - x[2])
  console.log(`${m.size} symbols, ${pairs.length} pairs changed together 2+ times`)
  for (const [a, b, n] of pairs.slice(0, 12)) console.log(`${n}×  ${a}  ↔  ${b}`)
})()
