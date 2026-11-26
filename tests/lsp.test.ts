import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { lspNewErrors, lspReferences, stopAllLsp } from '../src/main/lsp'

// The bundled language servers give exact references: a comment or an unrelated variable with the
// same name is not a use (the regex index would count both).
const FILES: Record<string, string> = {
  'web/price.ts': 'export function total(items: number[]): number {\n  return items.reduce((a, b) => a + b, 0)\n}\n',
  'web/cart.ts': "import { total } from './price'\n// total is computed elsewhere\nexport const sum = total([1, 2])\nexport const again = total([3])\n",
  'web/other.ts': 'const total = 5\nexport const x = total\n',
  'api/price.py': 'def total(items):\n    return sum(items)\n',
  'api/cart.py': 'from price import total\n\n# total of the cart\ndef checkout(items):\n    return total(items)\n'
}

let root = ''
beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), 'viber-lsp-'))
  for (const [rel, text] of Object.entries(FILES)) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
    writeFileSync(path.join(root, rel), text)
  }
})
afterAll(async () => {
  stopAllLsp()
  await new Promise((r) => setTimeout(r, 1500)) // let the servers exit and release the folder (Windows)
  try {
    rmSync(root, { recursive: true, force: true })
  } catch {
    /* temp folder: the OS cleans it up */
  }
})

describe('language servers', () => {
  it('finds exact TypeScript references', async () => {
    const refs = await lspReferences(root, 'web/price.ts', 1, 17, ['web/cart.ts', 'web/other.ts'])
    expect(refs).not.toBeNull()
    const locs = refs!.map((r) => `${r.file}:${r.line}`).sort()
    expect(locs).toEqual(['web/cart.ts:1', 'web/cart.ts:3', 'web/cart.ts:4'])
  }, 90_000)
  it('finds exact Python references', async () => {
    const refs = await lspReferences(path.join(root, 'api'), 'price.py', 1, 5, ['cart.py'])
    expect(refs).not.toBeNull()
    const locs = refs!.map((r) => `${r.file}:${r.line}`).sort()
    expect(locs).toEqual(['cart.py:1', 'cart.py:5'])
  }, 90_000)
  it('reports only the type errors an edit introduced (TypeScript)', async () => {
    const before = ["import { nope } from 'missing-pkg'", "export const broken: number = 'old error'", 'export function add(a: number, b: number): number {', '  return a + b', '}', ''].join('\n')
    const after = before.replace('return a + b', "return a + 'x'")
    const errs = await lspNewErrors(root, 'web/math.ts', before, after)
    expect(errs).not.toBeNull()
    expect(errs!.length).toBe(1)
    expect(errs![0]).toMatch(/^line 4: .*string.*number/i)
    expect(await lspNewErrors(root, 'web/math.ts', before, before)).toEqual([])
  }, 90_000)
  it('reports only the type errors an edit introduced (Python)', async () => {
    const before = ['import missing_pkg', '', 'def double(x: int) -> int:', '    return x * 2', ''].join('\n')
    const after = before.replace('return x * 2', 'return "two"')
    const errs = await lspNewErrors(path.join(root, 'api'), 'calc.py', before, after)
    expect(errs).not.toBeNull()
    expect(errs!.length).toBe(1)
    expect(errs![0]).toMatch(/^line 4:/)
  }, 90_000)
})
