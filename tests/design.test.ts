import { describe, expect, it } from 'vitest'
import type { ArchModel } from '../src/shared/model'
import { buildOrder } from '../src/main/orchestrator'
import { parseOps } from '../src/main/architect'

const model = (edges: [string, string][]): ArchModel => ({
  name: 't',
  nodes: ['ui', 'api', 'billing', 'db', 'mail'].map((id) => ({ id, label: id, kind: 'box', purpose: '', files: [], symbols: [] })),
  edges: edges.map(([s, t]) => ({ id: `${s}->${t}`, source: s, target: t, kind: 'call', label: '', contract: [] }))
})

describe('build order', () => {
  it('builds providers before consumers, in parallel waves', () => {
    const waves = buildOrder(model([['ui', 'api'], ['api', 'billing'], ['billing', 'db'], ['api', 'mail']]), ['ui', 'api', 'billing', 'db', 'mail'])
    expect(waves[0].sort()).toEqual(['db', 'mail'])
    expect(waves[1]).toEqual(['billing'])
    expect(waves[2]).toEqual(['api'])
    expect(waves[3]).toEqual(['ui'])
  })
  it('does not stall on cycles', () => {
    const waves = buildOrder(model([['api', 'billing'], ['billing', 'api']]), ['api', 'billing'])
    expect(waves.flat().sort()).toEqual(['api', 'billing'])
  })
})

describe('architect output', () => {
  it('keeps only known operations from the JSON block', () => {
    const text = 'Here is my proposal.\n```json\n{"ops":[{"op":"addBox","label":"Billing","paths":[]},{"op":"dropDatabase"},{"op":"upsertEdge","edge":{"id":"a->b","from":"a","to":"b","kind":"call","uses":[]}}]}\n```'
    expect(parseOps(text).map((o) => o.op)).toEqual(['addBox', 'upsertEdge'])
  })
  it('returns nothing for prose or broken JSON', () => {
    expect(parseOps('Just a question back to you?')).toEqual([])
    expect(parseOps('```json\n{"ops":[ {"op": \n```')).toEqual([])
  })
})

describe('contract change proposals', () => {
  it('parses contract items', async () => {
    const { toItem } = await import('../src/main/acp')
    expect(toItem('post /api/skip')).toEqual({ kind: 'http', name: 'POST /api/skip' })
    expect(toItem('event: irrigation.skipped')).toEqual({ kind: 'event', name: 'irrigation.skipped' })
    expect(toItem('skip_day(zone, reason)')).toEqual({ kind: 'function', name: 'skip_day(zone, reason)' })
    expect(toItem('ZoneStatus')).toEqual({ kind: 'data', name: 'ZoneStatus' })
  })
  it('writes a scoped follow-up task for consumers', async () => {
    const { followUpTask } = await import('../src/main/acp')
    const t = followUpTask({ id: 'x', box: 'api', add: ['POST /api/skip'], remove: ['GET /api/old'], reason: 'needed', status: 'approved', createdAt: 0 }, 'ui')
    expect(t).toContain('POST /api/skip')
    expect(t).toContain('Stop using these')
    expect(t).toContain('Stay inside this box')
  })
})

describe('build placement', () => {
  it('gives a new box its own folder, under its parent when the parent has one', async () => {
    const { folderFor } = await import('../src/main/orchestrator')
    const node = (id: string, paths: string[], parent?: string) => ({ id, label: id, kind: 'box' as const, purpose: '', files: [], symbols: [], paths, parent })
    const m = { name: 't', edges: [], nodes: [node('farm', ['farm']), node('farm/irrigation', [], 'farm'), node('backend', []), node('api', ['backend'])] }
    expect(folderFor(m, m.nodes[1])).toBe('farm/irrigation')
    expect(folderFor(m, m.nodes[2])).toBe('backend-box') // "backend" is already another box's folder
  })
})

describe('symbol co-change', () => {
  it('names the function a diff hunk is in', async () => {
    const { hunkSymbol } = await import('../src/main/targeting')
    expect(hunkSymbol('def create_app(config_path: str | None = None) -> Fa')).toBe('create_app')
    expect(hunkSymbol('export default function App() {')).toBe('App')
    expect(hunkSymbol('func (s *Server) Handle(w http.ResponseWriter) {')).toBe('Handle')
    expect(hunkSymbol('export const listOrders = async (id) => {')).toBe('listOrders')
    expect(hunkSymbol('  async save(item: Item): Promise<void> {')).toBe('save')
    expect(hunkSymbol('  if (x) {')).toBeNull()
  })
})

describe('.box templates', () => {
  it('round-trips a box spec, code and needs, and refuses unsafe files', async () => {
    const { toTemplate, fromTemplate, checkTemplate } = await import('../src/main/boxTemplate')
    const m = {
      name: 't',
      nodes: [
        { id: 'billing', label: 'Billing', kind: 'box' as const, purpose: '', files: ['svc/billing/api.py', 'svc/billing/core/tax.py'], symbols: [], tech: 'FastAPI', rules: ['Amounts in cents'], spec: { responsibility: 'Invoices', contract: [{ kind: 'http' as const, name: 'POST /invoices' }], sideEffects: ['database' as const], status: 'built' as const } },
        { id: 'mail', label: 'Mail', kind: 'box' as const, purpose: '', files: [], symbols: [] },
        { id: 'shop', label: 'Shop', kind: 'box' as const, purpose: '', files: [], symbols: [], paths: ['shop'] }
      ],
      edges: [{ id: 'billing->mail', source: 'billing', target: 'mail', kind: 'call' as const, label: '', contract: ['send(to, body)'] }]
    }
    const t = toTemplate(m, m.nodes[0], { 'svc/billing/api.py': 'x = 1', 'svc/billing/core/tax.py': 'y = 2' })
    expect(checkTemplate(t)).toBeNull()
    expect(t.files).toEqual({ 'api.py': 'x = 1', 'core/tax.py': 'y = 2' })
    expect(t.requires).toEqual([{ kind: 'call', uses: ['send(to, body)'], note: 'provided by "Mail" in the source project' }])
    const r = fromTemplate(t, m, 'shop')
    expect(r.id).toBe('shop/billing')
    expect(Object.keys(r.files)).toEqual(['shop/billing/api.py', 'shop/billing/core/tax.py'])
    expect(r.ops[0]).toMatchObject({ op: 'addBox', tech: 'FastAPI', paths: ['shop/billing'], spec: { status: 'built', sideEffects: ['database'] } })
    expect(r.ops[1]).toEqual({ op: 'setRules', id: 'shop/billing', rules: ['Amounts in cents'] })
    const specOnly = fromTemplate(toTemplate(m, m.nodes[0]), m)
    expect(specOnly.ops[0]).toMatchObject({ id: 'billing-2', paths: [], spec: { status: 'planned' } })
    expect(checkTemplate({ ...t, files: { '../../etc/x': 'evil' } })).toMatch(/outside/)
    expect(checkTemplate({ schema: 'other' })).toMatch(/Unsupported/)
  })
})

describe('tech per box', () => {
  it('recommends a language from the box role and the project', async () => {
    const { recommendTech } = await import('../src/shared/techAdvice')
    const box = (id: string, extra: Record<string, unknown> = {}) => ({ id, label: id, kind: 'box' as const, purpose: '', files: [], symbols: [], ...extra })
    const nodes = [
      { id: 'actor:user', label: 'Gardener', kind: 'actor' as const, actorType: 'user' as const, purpose: '', files: [], symbols: [] },
      box('dashboard', { spec: { responsibility: 'Shows the garden dashboard' } }),
      box('api', { tech: 'FastAPI', stats: { files: 5, lines: 900, lang: 'Python' }, spec: { contract: [{ kind: 'http' as const, name: 'GET /api/plan' }] } }),
      box('sim', { spec: { responsibility: 'Simulates soil moisture hour by hour' } }),
      box('advisor', { spec: { responsibility: 'Answers questions with an LLM' } }),
      box('notify', { spec: { contract: [{ kind: 'event' as const, name: 'frost.warning' }] } }),
      box('billing', { spec: { contract: [{ kind: 'http' as const, name: 'POST /api/invoices' }] } })
    ]
    const m = { name: 't', nodes, edges: [{ id: 'u', source: 'actor:user', target: 'dashboard', kind: 'uses' as const, label: '', contract: [] }] }
    const tech = (id: string) => recommendTech(nodes.find((n) => n.id === id)!, m)
    expect(tech('dashboard')).toMatchObject({ role: 'ui', tech: 'TypeScript + React' })
    expect(tech('sim')).toMatchObject({ role: 'compute', tech: 'Rust' })
    expect(tech('advisor')).toMatchObject({ role: 'ai', tech: 'Python (FastAPI)' })
    expect(tech('notify')).toMatchObject({ role: 'worker', tech: 'Python (FastAPI)' }) // the backend is Python already
    expect(tech('billing').tech).toBe('Python (FastAPI)')
    const fresh = { name: 'n', nodes: [box('orders', { spec: { contract: [{ kind: 'http' as const, name: 'POST /api/orders' }] } })], edges: [] }
    expect(recommendTech(fresh.nodes[0], fresh).tech).toBe('TypeScript (Node + Hono)')
  })
})

describe('design check and dry runs', () => {
  const node = (id: string, kind: 'box' | 'actor', extra: Record<string, unknown> = {}) => ({ id, label: id, kind, purpose: '', files: [], symbols: [], ...extra })
  const edge = (s: string, t: string, kind: 'uses' | 'http' | 'call', contract: string[] = []) => ({ id: `${s}->${t}`, source: s, target: t, kind, label: '', contract })

  it('lists what a design is missing', async () => {
    const { designCheck } = await import('../src/shared/designCheck')
    const isolated = { name: 'gm', nodes: ['rules', 'llm', 'web'].map((b) => node(b, 'box', { spec: { status: 'planned', responsibility: 'x' } })), edges: [] }
    const bad = designCheck(isolated as never).filter((i) => !i.ok).map((i) => i.id)
    expect(bad).toEqual(['actors', 'actors-reach', 'connected', 'contracts', 'journeys', 'journeys-play'])

    const good = {
      name: 'gm',
      nodes: [node('actor:player', 'actor'), ...['phone', 'gm'].map((b) => node(b, 'box', { spec: { status: 'planned', responsibility: 'x' } }))],
      edges: [edge('actor:player', 'phone', 'uses'), edge('phone', 'gm', 'http', ['POST /rolls {die, result}'])],
      journeys: [{ id: 'roll', actor: 'actor:player', name: 'Roll', steps: [{ box: 'phone', action: 'enters 17' }, { box: 'gm', action: 'narrates' }, { box: 'phone', action: 'shows result' }] }]
    }
    expect(designCheck(good as never).every((i) => i.ok)).toBe(true)
  })

  it('checks every dry-run step against the real contracts', async () => {
    const { checkSteps } = await import('../src/main/dryRun')
    const m = { name: 'gm', nodes: [node('actor:player', 'actor'), node('phone', 'box'), node('gm', 'box'), node('rules', 'box')], edges: [edge('actor:player', 'phone', 'uses'), edge('phone', 'gm', 'http', ['POST /actions'])] }
    const r = checkSteps(m as never, 'actor:player', [
      { box: 'phone', action: 'picks Fireball and two targets', message: null as never },
      { box: 'gm', action: 'receives the action', message: 'POST /actions' },
      { box: 'rules', action: 'rolls damage' },
      { box: 'dice', action: 'reads the dice', payload: { die: 'd6', count: 8 } as never }
    ])
    expect(r.steps[3].payload).toContain('"die": "d6"') // objects from the model become text
    expect(r.steps[0].problem).toBeUndefined()
    expect(r.steps[0].message).toBeUndefined() // null from the model is dropped
    expect(r.steps[2].problem).toMatch(/No contract between gm and rules/)
    expect(r.steps[3].problem).toMatch(/no component "dice"/)
    expect(r.gaps).toHaveLength(2)
  })
})
