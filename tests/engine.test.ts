import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { scanRepo } from '../src/main/engine/scan'
import { resolveImports } from '../src/main/engine/resolve'
import { buildModel, emptyDefs } from '../src/main/engine/build'
import { detectHttpCalls, detectRoutes, fileRoute, pathsMatch } from '../src/main/engine/detect'
import { diffCounts } from '../src/main/git'

// A tiny full-stack repo: React frontend calling a FastAPI backend, which uses Stripe and Postgres.
const FILES: Record<string, string> = {
  'frontend/package.json': JSON.stringify({ name: 'web', dependencies: { react: '19.0.0' } }),
  'frontend/src/pages/Orders.tsx': `import { listOrders } from '../api/client'\nexport function Orders() { return <ul>{listOrders()}</ul> }\n`,
  'frontend/src/pages/Admin.tsx': `export function Admin() { return <div /> }\n`,
  'frontend/src/api/client.ts': `export async function listOrders() { return fetch('/api/orders').then(r => r.json()) }\n`,
  'backend/pyproject.toml': `[project]\nname = "api"\ndependencies = ["fastapi", "stripe", "psycopg2"]\n`,
  'backend/app/main.py': `from fastapi import FastAPI\nfrom app.orders.service import list_orders\napp = FastAPI()\n\n@app.get("/api/orders")\ndef orders():\n    return list_orders()\n\n@app.post("/api/admin/refund")\ndef refund():\n    return {}\n`,
  'backend/app/orders/service.py': `import stripe\nimport psycopg2\n\ndef list_orders():\n    return []\n\ndef _private():\n    pass\n`,
  'backend/app/orders/models.py': `class Order:\n    pass\n`,
  'backend/app/cli.py': `import argparse\nif __name__ == "__main__":\n    argparse.ArgumentParser()\n`,
  'backend/tests/test_orders.py': `from app.orders.service import list_orders\n\ndef test_list():\n    assert list_orders() == []\n`
}

let root = ''

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), 'viber-test-'))
  for (const [rel, text] of Object.entries(FILES)) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
    writeFileSync(path.join(root, rel), text)
  }
})

afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('detectors', () => {
  it('finds routes across frameworks', () => {
    expect(detectRoutes(`@app.get("/api/orders")\ndef x(): pass`)).toMatchObject([{ method: 'GET', path: '/api/orders' }])
    expect(detectRoutes(`router.post('/users/:id', h)`)).toMatchObject([{ method: 'POST', path: '/users/:id' }])
    expect(detectRoutes(`@GetMapping("/items/{id}")`)).toMatchObject([{ method: 'GET', path: '/items/{id}' }])
    expect(fileRoute('app/api/orders/[id]/route.ts')?.route.path).toBe('/api/orders/:id')
    expect(fileRoute('app/(shop)/cart/page.tsx')).toMatchObject({ kind: 'page', route: { path: '/cart' } })
  })

  it('matches client calls to server routes', () => {
    expect(detectHttpCalls("fetch(`/api/orders/${id}`)")[0].url).toBe('/api/orders/:p')
    expect(pathsMatch('/api/orders/:p', '/api/orders/{order_id}')).toBe(true)
    expect(pathsMatch('/api/orders', '/api/users')).toBe(false)
  })

  it('counts line changes regardless of line endings', () => {
    expect(diffCounts('a\nb\nc\n', 'a\r\nb\r\nc\r\nd\r\n')).toEqual({ added: 1, removed: 0 })
    expect(diffCounts('', 'x\ny')).toEqual({ added: 2, removed: 0 })
  })
})

describe('initialize a repo', () => {
  it('builds boxes, edges, services and actors from code', async () => {
    const scan = await scanRepo(root)
    const res = resolveImports(scan)
    const { model, unmapped } = buildModel(scan, res, emptyDefs('shop'), { includeProposals: true })
    const ids = model.nodes.map((n) => n.id)

    // Deployable units become top-level boxes; tests don't.
    expect(ids).toContain('frontend')
    expect(ids).toContain('backend')
    expect(ids.some((id) => id.includes('tests'))).toBe(false)
    expect(unmapped).toEqual([])

    // Python import resolution: main.py → orders/service.py crosses boxes.
    const service = scan.files.find((f) => f.path.endsWith('orders/service.py'))!
    expect(service.symbols.map((s) => `${s.name}:${s.exported}`)).toEqual(['list_orders:true', '_private:false'])

    // The frontend's fetch('/api/orders') is matched to the FastAPI route: an HTTP edge.
    const http = model.edges.find((e) => e.kind === 'http')
    expect(http?.contract).toContain('GET /api/orders')

    // Known packages become external services / data stores.
    expect(model.nodes.find((n) => n.id === 'ext:stripe')?.kind).toBe('external')
    expect(model.nodes.find((n) => n.id === 'ds:postgres')?.kind).toBe('datastore')

    // Actors from entry points: UI pages → user, /admin routes → admin, argparse → CLI.
    const actors = model.nodes.filter((n) => n.kind === 'actor').map((n) => n.id)
    expect(actors).toEqual(expect.arrayContaining(['actor:user', 'actor:admin', 'actor:cli']))
    expect(model.edges.some((e) => e.source === 'actor:user' && e.target.startsWith('frontend'))).toBe(true)

    // Tests are mapped to the box they exercise.
    expect(model.nodes.some((n) => n.tests?.includes('backend/tests/test_orders.py'))).toBe(true)
  })

  it('respects curated definitions and flags guardrail violations', async () => {
    const scan = await scanRepo(root)
    const res = resolveImports(scan)
    const defs = {
      ...emptyDefs('shop'),
      boxes: [
        { id: 'ui', label: 'Storefront', paths: ['frontend'] },
        { id: 'api', label: 'API', paths: ['backend'] }
      ],
      actors: [{ id: 'actor:shopper', label: 'Shopper', type: 'user' as const, routes: ['GET /api/orders'] }],
      guardrails: [{ id: 'g1', from: 'ui', to: 'ext:stripe' }, { id: 'g2', from: 'api', to: 'ext:stripe', reason: 'payments go through billing' }]
    }
    const { model } = buildModel(scan, res, defs, { includeProposals: false })
    expect(model.nodes.find((n) => n.id === 'ui')?.label).toBe('Storefront')
    // The declared actor reaches the box serving its route.
    expect(model.edges.some((e) => e.source === 'actor:shopper' && e.target === 'api')).toBe(true)
    // api → stripe exists, ui → stripe doesn't.
    expect(model.violations?.map((v) => v.guardrail)).toEqual(['g2'])
  })
})

describe('design vs code', () => {
  it('shows designed edges, and flags drift', async () => {
    const scan = await scanRepo(root)
    const res = resolveImports(scan)
    const defs = {
      ...emptyDefs('shop'),
      boxes: [
        { id: 'ui', label: 'Storefront', paths: ['frontend'] },
        { id: 'api', label: 'API', paths: ['backend'], spec: { status: 'built' as const, contract: [{ kind: 'http' as const, name: 'GET /api/orders' }, { kind: 'http' as const, name: 'GET /api/invoices' }] } },
        { id: 'billing', label: 'Billing', paths: [], spec: { status: 'planned' as const } }
      ],
      // The UI is designed to depend on Billing only: its real dependency on the API is drift.
      edges: [{ id: 'ui->billing', from: 'ui', to: 'billing', kind: 'call' as const, uses: ['createInvoice()'] }]
    }
    const { model } = buildModel(scan, res, defs, { includeProposals: false })
    expect(model.edges.find((e) => e.id === 'ui->billing')?.planned).toBe(true)
    const kinds = (model.drift ?? []).map((d) => `${d.kind}:${d.source}`)
    expect(kinds).toContain('undeclared-dependency:ui')
    expect(kinds).toContain('missing-route:api') // GET /api/invoices is promised, not served
    expect(kinds).toContain('undeclared-route:api') // POST /api/admin/refund is served, not promised
  })
})

describe('targeting', () => {
  it('points at the handler and every caller of a route', async () => {
    const { whereToChange, findUsages } = await import('../src/main/targeting')
    const { ownerOf } = await import('../src/main/engine/build')
    const scan = await scanRepo(root)
    const res = resolveImports(scan)
    const built = buildModel(scan, res, emptyDefs('shop'), { includeProposals: true })
    const files = new Map(scan.files.map((f) => [f.path, f]))
    const boxes = built.model.nodes.filter((n) => n.kind === 'box').map((n) => ({ id: n.id, label: n.label, paths: n.paths ?? [] }))
    const ws = { root, built, res, coChange: new Map(), allFiles: () => scan.files, fileInfo: (p: string) => files.get(p), ownerOfFile: (p: string) => built.fileOwner[p] ?? ownerOf(boxes, p) } as never
    const preds = whereToChange(ws, 'Rename /api/orders to /api/purchases in the backend and the frontend')
    expect(preds.slice(0, 2).map((p) => p.file).sort()).toEqual(['backend/app/main.py', 'frontend/src/api/client.ts'])
    const usages = await findUsages(ws, root, '/api/orders')
    expect(usages).toContain('backend/app/main.py:5')
    expect(usages).toContain('frontend/src/api/client.ts:1')
  })
})
