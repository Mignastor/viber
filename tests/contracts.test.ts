import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { scanRepo } from '../src/main/engine/scan'
import { resolveImports } from '../src/main/engine/resolve'
import { buildModel, emptyDefs } from '../src/main/engine/build'
import { detectEffects } from '../src/main/engine/detect'
import { paramsOf, parseShape, returnTypeOf } from '../src/main/engine/contracts'

const FILES: Record<string, string> = {
  'api/pyproject.toml': `[project]\nname = "api"\ndependencies = ["fastapi", "psycopg2"]\n`,
  'api/models.py': `from pydantic import BaseModel\n\nclass SkipRequest(BaseModel):\n    zone: str\n    reason: str | None = None\n\nclass Plan(BaseModel):\n    zone: str\n    start: str\n    minutes: int\n`,
  'api/factory.py': `from fastapi import FastAPI
from pydantic import BaseModel

class TaskCreate(BaseModel):
    title: str
    zone: str = ""

def create_app():
    app = FastAPI()

    @app.post("/api/tasks")
    def create_task(
        t: TaskCreate,
    ):
        return {}
    return app
`,
  'api/main.py': [
    'import os',
    'import psycopg2',
    'from fastapi import FastAPI, Depends',
    'from models import SkipRequest, Plan',
    'app = FastAPI()',
    'TOKEN = os.environ.get("TOKEN")',
    '',
    '@app.post("/api/irrigation/skip")',
    'def skip(body: SkipRequest, db=Depends(get_db)):',
    '    return {}',
    '',
    '@app.get("/api/irrigation/plan", response_model=list[Plan])',
    'def plan(day: str):',
    '    return []',
    '',
    'def plan_irrigation(zones, forecast):',
    '    return []',
    ''
  ].join('\n')
}

let root = ''
beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), 'viber-contracts-'))
  for (const [rel, text] of Object.entries(FILES)) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
    writeFileSync(path.join(root, rel), text)
  }
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('shapes and signatures', () => {
  it('parses declared shapes', () => {
    expect(parseShape('{zone: str, reason?: str}')).toEqual({ fields: ['zone', 'reason'] })
    expect(parseShape('Plan[]')).toEqual({ type: 'Plan', fields: [] })
    expect(parseShape('zone, minutes')).toEqual({ fields: ['zone', 'minutes'] })
    expect(parseShape('')).toBeNull()
  })
  it('reads parameters and return types', () => {
    expect(paramsOf('def skip(body: SkipRequest, db: Session = Depends(get_db))').map((p) => [p.name, p.injected])).toEqual([['body', false], ['db', true]])
    expect(paramsOf('function f(a: Map<string, number>, b?: string)').map((p) => p.name)).toEqual(['a', 'b'])
    expect(paramsOf('def chat(req: ChatRequest, request: Request)').map((p) => [p.name, p.injected])).toEqual([['req', false], ['request', true]])
    expect(returnTypeOf('async def plan(day: str) -> list[Plan]')).toBe('Plan')
    expect(returnTypeOf('export async function plan(): Promise<Plan[]>')).toBe('Plan')
    expect(returnTypeOf('def f() -> None')).toBeUndefined()
  })
  it('detects side effects', () => {
    const kinds = (t: string, lang: 'python' | 'js', imports: string[] = []): string[] => detectEffects(t, lang, imports).map((e) => e.kind).sort()
    expect(kinds('import subprocess\nsubprocess.run(["ls"])\nwith open("x") as f: pass', 'python')).toEqual(['filesystem', 'process'])
    expect(kinds('const k = process.env.KEY\nawait fetch(url)', 'js')).toEqual(['env', 'network'])
    expect(kinds('import paho.mqtt.client as mqtt', 'python', ['paho.mqtt.client'])).toEqual(['queue'])
    expect(kinds('const [open, setOpen] = useState(false); setOpen(true)', 'js')).toEqual([])
  })
})

describe('typed contracts against code', () => {
  it('checks inputs, outputs and functions, and flags undeclared effects', async () => {
    const scan = await scanRepo(root)
    const defs = {
      ...emptyDefs('farm'),
      boxes: [
        {
          id: 'api',
          label: 'API',
          paths: ['api'],
          spec: {
            status: 'built' as const,
            sideEffects: ['database' as const],
            contract: [
              { kind: 'http' as const, name: 'POST /api/irrigation/skip', input: '{zone: str, reason?: str}' },
              { kind: 'http' as const, name: 'GET /api/irrigation/plan', input: 'day', output: '{zone, start, minutes, valve}' },
              { kind: 'function' as const, name: 'plan_irrigation(zones, weather)' },
              { kind: 'http' as const, name: 'POST /api/tasks', input: '{title, zone}' }
            ]
          }
        }
      ]
    }
    const { model } = buildModel(scan, resolveImports(scan), defs, { includeProposals: false })
    const api = model.nodes.find((n) => n.id === 'api')!
    expect(api.contractCheck?.['POST /api/irrigation/skip']).toEqual({ status: 'ok' })
    expect(api.contractCheck?.['GET /api/irrigation/plan']).toMatchObject({ status: 'mismatch', detail: expect.stringContaining('lacks valve') })
    expect(api.contractCheck?.['plan_irrigation(zones, weather)']?.status).toBe('mismatch')
    expect(api.contractCheck?.['POST /api/tasks']).toEqual({ status: 'ok' }) // handler nested in an app factory
    expect(api.effects?.map((e) => e.kind).sort()).toEqual(['database', 'env'])
    const drift = (model.drift ?? []).map((d) => d.kind)
    expect(drift.filter((k) => k === 'contract-mismatch')).toHaveLength(2)
    expect(drift.filter((k) => k === 'undeclared-effect')).toHaveLength(1) // env, not database
  })
})

describe('code style', () => {
  it('measures nesting and reports functions that break the style', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'viber-style-'))
    mkdirSync(path.join(dir, 'svc'))
    writeFileSync(
      path.join(dir, 'svc/rules.py'),
      [
        'def flat(x):',
        '    """Return x."""',
        '    return x',
        '',
        'def deep(items):',
        '    for i in items:',
        '        if i:',
        '            try:',
        '                while i:',
        '                    i -= 1',
        '            except Exception:',
        '                pass',
        '        elif i is None:',
        '            pass',
        '    return items',
        ''
      ].join('\n')
    )
    const scan = await scanRepo(dir)
    const syms = scan.files[0].symbols
    expect(syms.find((s) => s.name === 'flat')?.nesting).toBe(0)
    expect(syms.find((s) => s.name === 'deep')?.nesting).toBe(4)
    const defs = { ...emptyDefs('s'), style: { maxNesting: 3, publicDocs: true }, boxes: [{ id: 'svc', label: 'Service', paths: ['svc'], spec: { style: { maxFunctionLines: 8 } } }] }
    const { model } = buildModel(scan, resolveImports(scan), defs, { includeProposals: false })
    expect(model.nodes[0].style).toEqual({ maxNesting: 3, publicDocs: true, maxFunctionLines: 8 })
    const style = (model.drift ?? []).filter((d) => d.kind === 'style').map((d) => d.detail)
    expect(style).toHaveLength(3) // deep: too long, too nested, no docstring
    expect(style.every((d) => d.includes('deep'))).toBe(true)
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('express handlers and events', () => {
  it('reads request fields and response keys from inline handlers, and checks events', async () => {
    const { handlerIo, detectMessages, topicsMatch } = await import('../src/main/engine/detect')
    expect(handlerIo("async (req, res) => { const { title, zone } = req.body; if (!title) return res.status(400).json({ error: 'x' }); res.status(201).json({ id, title }) }")).toEqual({ input: ['title', 'zone'], output: ['id', 'title'] })
    expect(detectMessages("client.publish(f'farm/{zone}/valve', 1)\nbus.emit('order.paid', o)\nclient.subscribe('farm/+/moisture')").emits.map((m) => m.topic)).toEqual(['farm/*/valve', 'order.paid'])
    expect(topicsMatch('farm/*/moisture', 'farm/+/moisture')).toBe(true)
    expect(topicsMatch('order.paid', 'order.created')).toBe(false)

    const dir = mkdtempSync(path.join(tmpdir(), 'viber-express-'))
    mkdirSync(path.join(dir, 'server'))
    writeFileSync(path.join(dir, 'server/package.json'), JSON.stringify({ name: 'srv', dependencies: { express: '4.0.0' } }))
    writeFileSync(
      path.join(dir, 'server/app.js'),
      [
        "const express = require('express')",
        'const app = express()',
        "app.post('/api/todos', (req, res) => {",
        '  const { title } = req.body',
        "  bus.emit('todo.created', { title })",
        "  bus.emit('debug.trace', {})",
        '  res.status(201).json({ id: 1, title, done: false })',
        '})',
        ''
      ].join('\n')
    )
    const scan = await scanRepo(dir)
    const defs = {
      ...emptyDefs('t'),
      boxes: [
        {
          id: 'srv',
          label: 'Server',
          paths: ['server'],
          spec: {
            status: 'built' as const,
            contract: [
              { kind: 'http' as const, name: 'POST /api/todos', input: '{title}', output: '{id, title, done}' },
              { kind: 'event' as const, name: 'todo.created' },
              { kind: 'event' as const, name: 'todo.deleted' }
            ]
          }
        }
      ]
    }
    const { model } = buildModel(scan, resolveImports(scan), defs, { includeProposals: false })
    const srv = model.nodes.find((n) => n.id === 'srv')!
    expect(srv.contractCheck?.['POST /api/todos']).toEqual({ status: 'ok' })
    expect(srv.contractCheck?.['todo.created']).toEqual({ status: 'ok' })
    expect(srv.contractCheck?.['todo.deleted']?.status).toBe('mismatch')
    expect((model.drift ?? []).filter((d) => d.kind === 'undeclared-event').map((d) => d.detail)).toEqual([expect.stringContaining('debug.trace')])
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('router prefixes and html pages', () => {
  it('applies include_router / app.use prefixes and links an html page to the api', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'viber-mount-'))
    const W = (rel: string, text: string): void => {
      mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
      writeFileSync(path.join(dir, rel), text)
    }
    W('backend/todo/__init__.py', '')
    W('backend/todo/app.py', 'from fastapi import FastAPI\nfrom .routes.todos import router\napp = FastAPI()\napp.include_router(router, prefix="/todos")\n')
    W('backend/todo/routes/__init__.py', '')
    W('backend/todo/routes/todos.py', 'from fastapi import APIRouter\nrouter = APIRouter()\n\n@router.get("/")\ndef read_todos():\n    return []\n\n@router.delete("/{todo_id}")\ndef delete_todo(todo_id: int):\n    return {}\n')
    W('backend/admin.py', 'from fastapi import APIRouter\nadmin = APIRouter(prefix="/admin")\n\n@admin.get("/stats")\ndef stats():\n    return {}\n')
    W('client/index.html', '<html><body>\n<script>\nasync function load() {\n  const r = await fetch("/todos/")\n}\n</script>\n</body></html>\n')
    W('server/app.js', "const express = require('express')\nconst items = require('./items')\nconst app = express()\napp.use('/api/items', items)\n")
    W('server/items.js', "const router = require('express').Router()\nrouter.get('/:id', (req, res) => res.json({}))\nmodule.exports = router\n")
    const scan = await scanRepo(dir)
    const res = resolveImports(scan)
    const routes = scan.files.flatMap((f) => f.routes.map((r) => `${r.method} ${r.path}`)).sort()
    expect(routes).toEqual(['DELETE /todos/{todo_id}', 'GET /admin/stats', 'GET /api/items/:id', 'GET /todos'])
    expect(scan.files.find((f) => f.path === 'client/index.html')?.calls.map((c) => c.url)).toEqual(['/todos/'])
    const defs = { ...emptyDefs('t'), boxes: [{ id: 'backend', label: 'API', paths: ['backend'] }, { id: 'client', label: 'Client', paths: ['client'] }] }
    const { model } = buildModel(scan, res, defs, { includeProposals: false })
    expect(model.edges.find((e) => e.source === 'client' && e.target === 'backend')?.kind).toBe('http')
    resolveImports(scan) // idempotent: prefixes are not applied twice
    expect(scan.files.flatMap((f) => f.routes.map((r) => r.path))).toContain('/todos/{todo_id}')
    rmSync(dir, { recursive: true, force: true })
  })
})
