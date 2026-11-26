import http from 'http'
import { ctx } from './context'
import { getSettings } from './settings'
import { pathsMatch } from './engine/detect'

// Runtime overlay: real traffic drawn on the map. Two sources:
//  - an OTLP/HTTP (JSON) trace receiver: point OTEL_EXPORTER_OTLP_ENDPOINT at http://127.0.0.1:<port>
//    with OTEL_EXPORTER_OTLP_PROTOCOL=http/json; spans are mapped to boxes by file, route, service,
//    database or peer host, and parent→child spans become edge traffic;
//  - request lines in the output of apps started from Viber ("GET /api/x 200 12ms").

export interface RuntimeStats {
  boxes: Record<string, { count: number; errors: number; avgMs: number }>
  edges: Record<string, { count: number; errors: number; avgMs: number }>
  since: number
}

let stats: RuntimeStats = { boxes: {}, edges: {}, since: Date.now() }
let emitTimer: ReturnType<typeof setTimeout> | null = null
let server: http.Server | null = null
let port = 0

export function otlpPort(): number {
  return port
}

export function resetRuntime(): void {
  stats = { boxes: {}, edges: {}, since: Date.now() }
  ctx.emit('runtime:stats', stats)
}

function bump(map: RuntimeStats['boxes'], id: string, ms: number | undefined, error: boolean): void {
  const s = map[id] ?? { count: 0, errors: 0, avgMs: 0 }
  s.count++
  if (error) s.errors++
  if (ms !== undefined) s.avgMs = s.avgMs + (ms - s.avgMs) / s.count
  map[id] = s
}

function scheduleEmit(): void {
  if (emitTimer) return
  emitTimer = setTimeout(() => {
    emitTimer = null
    ctx.emit('runtime:stats', stats)
  }, 500)
}

function boxForRoute(method: string, p: string): string | null {
  for (const n of ctx.ws?.built?.model.nodes ?? []) {
    if (n.routes?.some((r) => {
      const [m, rp] = r.split(' ')
      return (m === method || m === 'ANY' || method === 'ANY') && pathsMatch(p.split('?')[0], rp)
    }))
      return n.id
  }
  return null
}

/** A request seen in an app's log output. */
export function recordRuntimeHit(h: { method: string; path: string; status: number; ms?: number }): void {
  const box = boxForRoute(h.method, h.path)
  if (!box) return
  bump(stats.boxes, box, h.ms, h.status >= 500)
  // The actor facing this box made the request.
  for (const e of ctx.ws?.built?.model.edges ?? []) if (e.target === box && e.kind === 'uses') bump(stats.edges, e.id, h.ms, h.status >= 500)
  scheduleEmit()
}

type Attr = { key: string; value: { stringValue?: string; intValue?: string | number; boolValue?: boolean } }
const attrs = (list: Attr[] | undefined): Record<string, string> => Object.fromEntries((list ?? []).map((a) => [a.key, String(a.value.stringValue ?? a.value.intValue ?? a.value.boolValue ?? '')]))

function boxForSpan(a: Record<string, string>, resource: Record<string, string>, kind: number): string | null {
  const ws = ctx.ws
  const m = ws?.built?.model
  if (!ws || !m) return null
  const file = a['code.filepath'] ?? a['code.file.path']
  if (file) {
    const norm = file.replace(/\\/g, '/')
    const rel = ws.allFiles().find((f) => norm.endsWith('/' + f.path) || norm === f.path)?.path
    const o = rel ? ws.ownerOfFile(rel) : null
    if (o) return o
  }
  const route = a['http.route'] ?? a['url.path'] ?? a['http.target']
  if (route && kind === 2) {
    const b = boxForRoute(a['http.request.method'] ?? a['http.method'] ?? 'ANY', route)
    if (b) return b
  }
  if (a['db.system']) {
    const ds = m.nodes.find((n) => n.kind === 'datastore' && (n.label.toLowerCase().includes(a['db.system'].toLowerCase()) || n.id.includes(a['db.system'])))
    if (ds) return ds.id
  }
  const host = a['server.address'] ?? a['net.peer.name']
  if (host && kind === 3) {
    const ext = m.nodes.find((n) => n.kind === 'external' && (n.tech === host || host.includes(n.id.replace(/^ext[:-]/, ''))))
    if (ext) return ext.id
  }
  const svc = resource['service.name']
  if (svc) {
    const n = m.nodes.find((x) => x.kind === 'box' && !x.parent && (x.id === svc || x.label.toLowerCase() === svc.toLowerCase()))
    if (n) return n.id
  }
  return null
}

function ingest(body: any): void {
  for (const rs of body?.resourceSpans ?? []) {
    const resource = attrs(rs.resource?.attributes)
    const spanBox = new Map<string, string | null>()
    const spans: any[] = (rs.scopeSpans ?? rs.instrumentationLibrarySpans ?? []).flatMap((ss: any) => ss.spans ?? [])
    for (const sp of spans) spanBox.set(sp.spanId, boxForSpan(attrs(sp.attributes), resource, sp.kind ?? 0))
    for (const sp of spans) {
      const box = spanBox.get(sp.spanId)
      const ms = (Number(BigInt(sp.endTimeUnixNano ?? 0) - BigInt(sp.startTimeUnixNano ?? 0)) || 0) / 1e6
      const error = sp.status?.code === 2
      if (box) bump(stats.boxes, box, ms, error)
      const parent = sp.parentSpanId ? spanBox.get(sp.parentSpanId) : null
      if (box && parent && parent !== box) bump(stats.edges, `${parent}->${box}`, ms, error)
    }
  }
  scheduleEmit()
}

export async function startOtlp(): Promise<number> {
  if (server) return port
  const wanted = (await getSettings()).otlpPort
  server = http.createServer((req, res) => {
    if (req.method !== 'POST' || !req.url?.startsWith('/v1/traces')) {
      res.writeHead(req.url?.startsWith('/v1/') ? 200 : 404).end('{}')
      return
    }
    let raw = ''
    req.on('data', (d) => (raw += d))
    req.on('end', () => {
      try {
        ingest(JSON.parse(raw))
        res.writeHead(200, { 'content-type': 'application/json' }).end('{}')
      } catch {
        res.writeHead(415).end('Viber accepts OTLP/HTTP JSON (set OTEL_EXPORTER_OTLP_PROTOCOL=http/json)')
      }
    })
  })
  port = await new Promise<number>((resolve) => {
    const tryListen = (p: number): void => {
      server!.once('error', () => tryListen(0))
      server!.listen(p, '127.0.0.1', () => resolve((server!.address() as { port: number }).port))
    }
    tryListen(wanted)
  })
  return port
}
