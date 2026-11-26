import { describe, expect, it } from 'vitest'
import type { ScanFile } from '../src/main/engine/scan'
import type { FileDep } from '../src/main/engine/resolve'
import { clusterFiles, compressPaths, louvain } from '../src/main/engine/components'

const file = (p: string, extra: Partial<ScanFile> = {}): ScanFile => ({
  path: p,
  lang: 'python',
  lines: 50,
  imports: [],
  importNames: {},
  symbols: [],
  routes: [],
  calls: [],
  effects: [],
  flags: [],
  ...extra
})
const dep = (from: string, to: string, names: string[] = ['x']): FileDep => ({ from, to, names })

describe('louvain', () => {
  it('separates two dense groups joined by one edge', () => {
    const g = new Map<number, Map<number, number>>()
    const link = (a: number, b: number): void => {
      if (!g.has(a)) g.set(a, new Map())
      if (!g.has(b)) g.set(b, new Map())
      g.get(a)!.set(b, 1)
      g.get(b)!.set(a, 1)
    }
    for (const [a, b] of [[0, 1], [1, 2], [0, 2], [3, 4], [4, 5], [3, 5], [2, 3]]) link(a, b)
    const m = louvain(6, g)
    expect(m[0]).toBe(m[1])
    expect(m[1]).toBe(m[2])
    expect(m[3]).toBe(m[4])
    expect(m[0]).not.toBe(m[3])
  })
})

describe('clusterFiles', () => {
  // Billing and sensors talk inside themselves; both use db.py and config.py (shared kernel);
  // api.py serves routes and imports everything (interface layer).
  const files = [
    file('app/billing/invoice.py'),
    file('app/billing/pricing.py'),
    file('app/billing/tax.py'),
    file('app/sensors/mqtt.py'),
    file('app/sensors/reader.py'),
    file('app/sensors/calibrate.py'),
    file('app/reports/summary.py'),
    file('app/reports/export.py'),
    file('app/db.py'),
    file('app/config.py'),
    file('app/api.py', { routes: [1, 2, 3, 4, 5, 6].map((i) => ({ method: 'GET', path: `/api/r${i}`, line: i })) })
  ]
  const deps: FileDep[] = [
    dep('app/billing/invoice.py', 'app/billing/pricing.py', ['price', 'discount']),
    dep('app/billing/invoice.py', 'app/billing/tax.py', ['vat']),
    dep('app/billing/pricing.py', 'app/billing/tax.py'),
    dep('app/sensors/reader.py', 'app/sensors/mqtt.py', ['connect', 'subscribe']),
    dep('app/sensors/reader.py', 'app/sensors/calibrate.py'),
    dep('app/sensors/calibrate.py', 'app/sensors/mqtt.py'),
    dep('app/reports/export.py', 'app/reports/summary.py', ['summary']),
    ...['app/billing/invoice.py', 'app/sensors/reader.py', 'app/reports/summary.py', 'app/billing/pricing.py', 'app/sensors/mqtt.py'].flatMap((f) => [dep(f, 'app/db.py'), dep(f, 'app/config.py')]),
    ...['app/billing/invoice.py', 'app/sensors/reader.py', 'app/reports/export.py'].map((f) => dep('app/api.py', f, ['run']))
  ]

  it('finds components by behaviour, pins interface layers, extracts a shared kernel', () => {
    const clusters = clusterFiles(files, deps, { fallbackName: 'App', genericDirs: new Set(['app']) })
    const byName = new Map(clusters.map((c) => [c.name, c.files.map((f) => f.path).sort()]))
    expect(byName.get('API')).toEqual(['app/api.py'])
    expect(byName.get('Billing')).toEqual(['app/billing/invoice.py', 'app/billing/pricing.py', 'app/billing/tax.py'])
    expect(byName.get('Sensors')).toEqual(['app/sensors/calibrate.py', 'app/sensors/mqtt.py', 'app/sensors/reader.py'])
    expect(byName.get('Shared kernel')).toEqual(['app/config.py', 'app/db.py'])
  })

  it('compresses fully-owned folders and keeps stray files explicit', () => {
    const owner = new Map([
      ['app/billing/invoice.py', 'b'],
      ['app/billing/tax.py', 'b'],
      ['app/db.py', 'k'],
      ['app/api.py', 'b']
    ])
    expect(compressPaths(['app/billing/invoice.py', 'app/billing/tax.py', 'app/api.py'], owner, 'b')).toEqual(['app/api.py', 'app/billing'])
  })
})
