import type { CodeSymbol, ContractCheck, ContractItem } from '@shared/model'
import type { Route } from './detect'

// Typed contracts: a contract item may say what goes in and what comes out. This compares that
// with the code that serves it (handler parameters, request/response models, function signatures).
// Anything we cannot resolve is "unverified", never a false alarm.

export interface Shape {
  /** A named type, e.g. "SkipRequest". */
  type?: string
  fields: string[]
}

/** "{zone: str, reason?: str}", "zone, reason", "SkipRequest", "Plan[]" → a shape. */
export function parseShape(s?: string): Shape | null {
  if (!s?.trim()) return null
  const raw = s.trim()
  const t = raw
    .replace(/\[\]$/, '')
    .replace(/^(?:list|List|Array|Optional|Promise)\s*[[<](.*)[\]>]$/, '$1')
    .trim()
  // "Plan", or any single name inside a list wrapper ("List[todo]", "todo[]"): a type, not a field.
  if (/^[A-Z]\w*$/.test(t) || (t !== raw && /^\w+$/.test(t))) return { type: t, fields: [] }
  const fields = t.includes(':') ? [...new Set([...t.matchAll(/(\w+)\??\s*:/g)].map((m) => m[1]))] : t.split(/[\s,{}()]+/).filter((w) => /^\w+$/.test(w))
  return fields.length ? { fields } : null // "{}" or "none": nothing to check
}

interface Param {
  name: string
  type?: string
  injected: boolean
}

const INJECTED_TYPES = /^(Request|Response|WebSocket|Session|AsyncSession|BackgroundTasks|HTTPConnection|Db|Database|Connection)$/
const INJECTED_NAMES = /^(self|cls|request|req|res|response|db|session|background_tasks|ctx|context|next)$/

/** Parameters of a signature such as `async def skip(body: SkipRequest, db: Session = Depends(get_db))`. */
export function paramsOf(signature: string): Param[] {
  const open = signature.indexOf('(')
  if (open < 0) return []
  let depth = 0
  let end = open
  for (let i = open; i < signature.length; i++) {
    const c = signature[i]
    if ('([{<'.includes(c)) depth++
    else if (')]}>'.includes(c) && --depth === 0) {
      end = i
      break
    }
  }
  const inner = signature.slice(open + 1, end)
  const parts: string[] = []
  let cur = ''
  depth = 0
  for (const c of inner) {
    if ('([{<'.includes(c)) depth++
    if (')]}>'.includes(c)) depth--
    if (c === ',' && depth === 0) (parts.push(cur), (cur = ''))
    else cur += c
  }
  if (cur.trim()) parts.push(cur)
  return parts
    .map((p) => p.trim())
    .filter((p) => p && p !== '*' && p !== '/' && !p.startsWith('**'))
    .map((p) => {
      const m = p.match(/^\*?(\w+)\??\s*(?::\s*([^=]+))?(?:=\s*(.*))?$/)
      const name = m?.[1] ?? p
      const type = m?.[2]?.trim().replace(/^(?:Annotated|Optional)\[(\w+).*\]$/, '$1')
      // A name like "req" only means "framework-injected" when untyped: `req: ChatRequest` is the body.
      const injected = (INJECTED_NAMES.test(name) && (!type || name === 'self' || name === 'cls')) || (!!type && INJECTED_TYPES.test(type.split(/[[\s|]/)[0])) || /Depends\(|Security\(/.test(m?.[3] ?? '') || /Depends\(/.test(type ?? '')
      return { name, type, injected }
    })
}

/** `-> Plan`, `-> list[Plan]`, `): Promise<Plan[]>` → "Plan". */
export function returnTypeOf(signature: string): string | undefined {
  const m = signature.match(/->\s*([\w[\], |.]+)\s*$/) ?? signature.match(/\)\s*:\s*([\w<>[\], |.]+)\s*$/)
  if (!m) return undefined
  const inner = m[1].replace(/^(?:list|List|Optional|Promise|Array)\s*[[<]\s*(.*?)\s*[\]>]$/, '$1').replace(/\[\]$/, '').trim()
  return /^[A-Z]\w*$/.test(inner) && !['None', 'Any', 'JSONResponse', 'Response', 'HTMLResponse', 'StreamingResponse', 'FileResponse', 'dict', 'Dict'].includes(inner) ? inner : undefined
}

const diff = (declared: string[], code: string[]): { missing: string[]; extra: string[] } => ({
  missing: declared.filter((f) => !code.includes(f)),
  extra: code.filter((f) => !declared.includes(f))
})

function compareShape(side: 'input' | 'output', declared: Shape, codeType: string | undefined, codeFields: string[] | undefined): ContractCheck {
  if (declared.type) {
    if (!codeType) return { status: 'unverified', detail: `${side}: no ${declared.type} type found in the code` }
    return codeType.toLowerCase() === declared.type.toLowerCase() ? { status: 'ok' } : { status: 'mismatch', detail: `${side}: the code uses ${codeType}, the contract says ${declared.type}` }
  }
  if (!codeFields) return { status: 'unverified', detail: `${side}: the code's ${side} shape could not be read` }
  const { missing, extra } = diff(declared.fields, codeFields)
  if (!missing.length && !extra.length) return { status: 'ok' }
  const parts = [missing.length ? `the code lacks ${missing.join(', ')}` : '', extra.length ? `the code also has ${extra.join(', ')}` : ''].filter(Boolean)
  return { status: 'mismatch', detail: `${side}: ${parts.join('; ')}` }
}

const merge = (checks: ContractCheck[]): ContractCheck => {
  const bad = checks.filter((c) => c.status === 'mismatch')
  if (bad.length) return { status: 'mismatch', detail: bad.map((c) => c.detail).join(' · ') }
  const unv = checks.filter((c) => c.status === 'unverified')
  if (unv.length) return { status: 'unverified', detail: unv.map((c) => c.detail).join(' · ') }
  return { status: 'ok' }
}

/** Compare an HTTP contract item with its route handler. */
export function checkHttp(item: ContractItem, route: Route, handler: CodeSymbol | undefined, typeFields: (name: string) => string[] | undefined): ContractCheck {
  const input = parseShape(item.input)
  const output = parseShape(item.output)
  if (!input && !output) return { status: 'ok' }
  if (!handler && !route.io) return { status: 'unverified', detail: 'no handler function found next to the route' }
  const checks: ContractCheck[] = []
  const pathParams = [...route.path.matchAll(/[{:<](?:\w+:)?(\w+)[}>]?/g)].map((m) => m[1])
  if (input) {
    // Typed parameters (FastAPI, Spring…) first; else what the handler body reads (req.body.x, { x } = req.body).
    const params = handler ? paramsOf(handler.signature).filter((p) => !p.injected && !/^(req|res|c|ctx|next)$/.test(p.name)) : []
    const body = params.find((p) => p.type && typeFields(p.type))
    // A parameter typed with a class we cannot read (ORM model, imported type): don't guess.
    const opaque = !body && params.find((p) => p.type && /^[A-Z]\w*$/.test(p.type))
    if (opaque) checks.push({ status: 'unverified', detail: `input: the fields of ${opaque.type} could not be read` })
    let fields: string[] | undefined = [...new Set(params.flatMap((p) => (p === body ? typeFields(p.type!)! : pathParams.includes(p.name) ? [] : [p.name])))]
    if (!body && !fields.length) fields = route.io?.input
    if (!opaque) checks.push(compareShape('input', { type: input.type, fields: input.fields.filter((f) => !pathParams.includes(f)) }, body?.type, fields))
  }
  if (output) {
    const type = route.responseModel ?? (handler ? returnTypeOf(handler.signature) : undefined)
    checks.push(compareShape('output', output, type, type ? typeFields(type) : route.io?.output))
  }
  return merge(checks)
}

/** Compare a function contract item ("plan_irrigation(zones, forecast)") with the function in the code. */
export function checkFunction(item: ContractItem, fn: CodeSymbol | undefined, typeFields: (name: string) => string[] | undefined): ContractCheck {
  const name = item.name.match(/^\s*([\w.]+)/)?.[1]?.split('.').pop()
  if (!name) return { status: 'unverified' }
  if (!fn) return { status: 'mismatch', detail: `no function ${name} in this box` }
  const checks: ContractCheck[] = []
  const declaredParams = item.name.includes('(') ? parseShape(item.name.slice(item.name.indexOf('(') + 1, item.name.lastIndexOf(')'))) : parseShape(item.input)
  if (declaredParams) {
    const code = paramsOf(fn.signature)
      .filter((p) => p.name !== 'self' && p.name !== 'cls')
      .map((p) => p.name)
    const { missing, extra } = diff(declaredParams.fields, code)
    if (missing.length || extra.length)
      checks.push({ status: 'mismatch', detail: `parameters: contract (${declaredParams.fields.join(', ')}), code (${code.join(', ')})` })
  }
  const output = parseShape(item.output)
  if (output) {
    const type = returnTypeOf(fn.signature)
    checks.push(compareShape('output', output, type, type ? typeFields(type) : undefined))
  }
  return merge(checks)
}
