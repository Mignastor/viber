import { mkdtempSync, mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { lspReferences, stopAllLsp } from '../src/main/lsp'
const root = mkdtempSync(path.join(tmpdir(), 'viber-lspdbg-'))
const F: Record<string, string> = {
  'price.ts': 'export function total(items: number[]): number {\n  return items.reduce((a, b) => a + b, 0)\n}\n',
  'cart.ts': "import { total } from './price'\nexport const sum = total([1, 2])\n"
}
for (const [r, t] of Object.entries(F)) writeFileSync(path.join(root, r), t)
;(async () => {
  for (let i = 0; i < 4; i++) {
    const r = await lspReferences(root, 'price.ts', 1, 17)
    console.log(i, JSON.stringify(r))
    await new Promise((res) => setTimeout(res, 1500))
  }
  stopAllLsp()
})()
