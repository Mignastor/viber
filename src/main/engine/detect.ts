// Text-level detectors: HTTP routes, outbound HTTP calls, entry points (CLI, cron, queues),
// frameworks and well-known external services. Regexes, not parsers: they only need to be
// right often enough to *propose* things that the user then confirms.

export interface Route {
  method: string
  path: string
  line: number
  /** Function that serves it (when it sits right below the route declaration). */
  handler?: string
  /** Handler signature, when the handler is not a top-level symbol (e.g. nested in an app factory). */
  handlerSig?: string
  /** FastAPI response_model, when declared. */
  responseModel?: string
  /** Fields read from the request body and keys of the response object, read from the handler body. */
  io?: { input?: string[]; output?: string[] }
  /** Variable the route hangs off (app, router, bp…). */
  obj?: string
  /** Path within its own router (own prefix applied, mount prefix not). */
  base?: string
}

export interface Mount {
  prefix: string
  /** Mounted router expression, e.g. "router" or "todos.router". */
  target: string
  /** Import spec the router comes from, when known. */
  module?: string
}

const joinPath = (a: string, b: string): string => ('/' + [a, b].map((s) => s.replace(/^\/+|\/+$/g, '')).filter(Boolean).join('/')) || '/'

/** Router prefixes declared in a file (APIRouter(prefix=…), Blueprint(url_prefix=…)) and routers it mounts elsewhere. */
export function detectRouting(text: string, routes: Route[], importNames: Record<string, string[]>): Mount[] {
  const lines = text.split('\n')
  for (const r of routes) {
    r.obj = lines[r.line - 1]?.match(/@?\s*([\w$]+)\s*\.\s*(?:get|post|put|patch|delete|route|api_route|websocket|all|options|head)\s*\(/i)?.[1]
    r.base = r.path
  }
  // Own prefixes.
  for (const m of text.matchAll(/([\w$]+)\s*=\s*(?:APIRouter|Blueprint)\s*\(([^)]*)\)/g)) {
    const p = m[2].match(/(?:url_)?prefix\s*=\s*['"]([^'"]*)['"]/)?.[1]
    if (p) for (const r of routes) if (r.obj === m[1]) r.base = r.path = joinPath(p, r.path)
  }
  for (const m of text.matchAll(/(?:const|let|var)\s+([\w$]+)\s*=\s*(?:new\s+)?(?:Hono|Elysia)\s*\(\s*\{[^}]*basePath\s*:\s*['"]([^'"]+)['"]/g))
    for (const r of routes) if (r.obj === m[1]) r.base = r.path = joinPath(m[2], r.path)
  // Mounts: include_router(x, prefix=…), register_blueprint(x, url_prefix=…), app.use('/p', x), app.route('/p', x).
  const requires = new Map<string, string>()
  for (const m of text.matchAll(/(?:const|let|var)\s+([\w$]+)\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)/g)) requires.set(m[1], m[2])
  const moduleOf = (target: string): string | undefined => {
    const head = target.split('.')[0]
    if (requires.has(head)) return requires.get(head)
    for (const [spec, names] of Object.entries(importNames)) if (names.includes(head)) return target.includes('.') && !spec.endsWith(head) ? `${spec}.${head}` : spec
    return undefined
  }
  const mounts: Mount[] = []
  for (const m of text.matchAll(/\.(?:include_router|register_blueprint)\s*\(\s*([\w.]+)\s*(?:,([^)]*))?\)/g)) {
    const prefix = m[2]?.match(/(?:url_)?prefix\s*=\s*['"]([^'"]*)['"]/)?.[1]
    if (prefix) mounts.push({ prefix, target: m[1], module: moduleOf(m[1]) })
  }
  for (const m of text.matchAll(/\.(?:use|route)\s*\(\s*['"`](\/[^'"`]*)['"`]\s*,\s*([\w$.]+)\s*\)/g)) mounts.push({ prefix: m[1], target: m[2], module: moduleOf(m[2]) })
  return mounts
}

/** Apply mount prefixes to the mounted routers' routes (idempotent: always recomputed from base). */
export function applyMounts(files: { path: string; routes: Route[]; mounts?: Mount[] }[], resolve: (from: string, spec: string) => string | null): void {
  const byPath = new Map(files.map((f) => [f.path, f]))
  for (const f of files) for (const r of f.routes) if (r.base !== undefined) r.path = r.base
  for (const f of files) {
    for (const m of f.mounts ?? []) {
      const target = m.module ? resolve(f.path, m.module) : f.path
      const t = target ? byPath.get(target) : undefined
      if (!t) continue
      const obj = m.target.split('.').pop()!
      // A module with a single router object is that router, whatever name it was imported under.
      const single = t !== f && new Set(t.routes.map((r) => r.obj)).size <= 1
      for (const r of t.routes) if (r.obj === obj || single) r.path = joinPath(m.prefix, r.base ?? r.path)
    }
  }
}

/** Keys of the object literal starting at text[open] ('{'). */
export function objectKeys(text: string, open: number): string[] {
  let depth = 0
  let end = open
  for (let i = open; i < text.length; i++) {
    const c = text[i]
    if (c === '{' || c === '[' || c === '(') depth++
    else if ((c === '}' || c === ']' || c === ')') && --depth === 0) {
      end = i
      break
    }
  }
  const inner = text.slice(open + 1, end)
  const parts: string[] = []
  let cur = ''
  depth = 0
  for (const c of inner) {
    if ('{[('.includes(c)) depth++
    if ('}])'.includes(c)) depth--
    if (c === ',' && depth === 0) (parts.push(cur), (cur = ''))
    else cur += c
  }
  parts.push(cur)
  return [
    ...new Set(
      parts
        .map((p) => p.trim())
        .filter((p) => p && !p.startsWith('...') && !p.startsWith('**'))
        .map((p) => p.match(/^['"]?([\w$]+)['"]?\s*:/)?.[1] ?? p.match(/^([\w$]+)$/)?.[1])
        .filter((k): k is string => !!k)
    )
  ]
}

/** What a handler body reads from the request and returns (JS/Express/Hono and Python dict returns). */
export function handlerIo(body: string): { input?: string[]; output?: string[] } {
  const input = new Set<string>()
  for (const m of body.matchAll(/\breq(?:uest)?\.(?:body|query)\.(\w+)/g)) input.add(m[1])
  for (const m of body.matchAll(/\{([\w$\s,:=]+)\}\s*=\s*(?:await\s+)?(?:req(?:uest)?\.(?:body|query)|c\.req\.json\(\))/g))
    for (const k of m[1].split(',')) {
      const name = k.trim().split(/\s*[:=]\s*/)[0]
      if (/^\w+$/.test(name)) input.add(name)
    }
  // Response objects: res.json({…}), res.status(201).json({…}), c.json({…}), return {…}. Error replies (4xx/5xx) don't count.
  let output: string[] | undefined
  for (const m of body.matchAll(/(?:\.(?:json|send)\s*\(\s*|\breturn\s+)\{/g)) {
    const before = body.slice(Math.max(0, m.index! - 40), m.index!)
    if (/status\s*\(\s*[45]\d\d\s*\)\s*$/.test(before) || /HTTPException|abort\(/.test(before)) continue
    const keys = objectKeys(body, m.index! + m[0].length - 1)
    if (keys.length && (!output || keys.length > output.length)) output = keys
  }
  return { input: input.size ? [...input] : undefined, output }
}

export interface Message {
  topic: string
  line: number
}

/** Event / queue topics a file publishes and listens to. Template parts become "*". */
export function detectMessages(text: string): { emits: Message[]; listens: Message[] } {
  const norm = (t: string): string => t.replace(/\$\{[^}]*\}|\{[^}]*\}/g, '*')
  const grab = (re: RegExp): Message[] => [...text.matchAll(re)].map((m) => ({ topic: norm(m[1]), line: lineAt(text, m.index!) }))
  return {
    emits: grab(/\.(?:emit|publish|publish_event|send_event|send_task|produce|enqueue)\s*\(\s*(?:topic\s*=\s*|subject\s*=\s*)?f?['"`]([^'"`]+)['"`]/g).concat(
      grab(/basic_publish\s*\([^)]*?routing_key\s*=\s*f?['"]([^'"]+)['"]/g)
    ),
    listens: grab(/\.(?:on|subscribe|consume|listen|subscriber|message_callback_add)\s*\(\s*\[?\s*(?:topic\s*=\s*)?f?['"`]([^'"`]+)['"`]/g)
  }
}

/** Topic match with wildcards on either side ("*", MQTT "+" and "#"), segments split on "/" or ".". */
export function topicsMatch(a: string, b: string): boolean {
  const sa = a.split(/[/.]/)
  const sb = b.split(/[/.]/)
  for (let i = 0; i < Math.max(sa.length, sb.length); i++) {
    if (sa[i] === '#' || sb[i] === '#') return true
    if (sa[i] === undefined || sb[i] === undefined) return false
    if (sa[i] !== sb[i] && !['*', '+'].includes(sa[i]) && !['*', '+'].includes(sb[i])) return false
  }
  return true
}

export interface HttpCall {
  method: string
  url: string
  line: number
}

export type FileFlag = 'test' | 'cli' | 'cron' | 'queue' | 'component' | 'page' | 'entry' | 'webhook' | 'admin'

const lineAt = (text: string, idx: number): number => {
  let n = 1
  for (let i = 0; i < idx && i < text.length; i++) if (text.charCodeAt(i) === 10) n++
  return n
}

const ROUTE_PATTERNS: { re: RegExp; method: (m: RegExpExecArray) => string; path: (m: RegExpExecArray) => string }[] = [
  // Express / Fastify / Koa / Hono / Elysia / chi / gin / echo / axum-ish: app.get('/x', …)
  {
    re: /\b(?:app|router|server|api|routes?|fastify|r|e|g|v\d|group|mux|hono)\s*\.\s*(get|post|put|patch|delete|options|head|all|GET|POST|PUT|PATCH|DELETE|Get|Post|Put|Patch|Delete)\s*\(\s*['"`]([^'"`]*)['"`]/g,
    method: (m) => m[1].toUpperCase(),
    path: (m) => m[2]
  },
  // Fastify/Hapi object style: { method: 'POST', url: '/x' }
  { re: /method\s*:\s*['"](GET|POST|PUT|PATCH|DELETE)['"][^}]{0,80}?(?:url|path)\s*:\s*['"]([^'"]+)['"]/g, method: (m) => m[1], path: (m) => m[2] },
  // Python decorators: FastAPI / Flask / Starlette / Sanic / Litestar
  {
    re: /@\s*\w+\s*\.\s*(get|post|put|patch|delete|route|api_route|websocket)\s*\(\s*f?['"]([^'"]*)['"]/g,
    method: (m) => (m[1] === 'route' || m[1] === 'api_route' ? 'ANY' : m[1] === 'websocket' ? 'WS' : m[1].toUpperCase()),
    path: (m) => m[2]
  },
  // Django urls.py
  { re: /\b(?:re_)?path\s*\(\s*r?['"]([^'"]*)['"]\s*,/g, method: () => 'ANY', path: (m) => '/' + m[1].replace(/^\^/, '').replace(/\$$/, '') },
  // NestJS / Spring / Micronaut decorators and annotations
  {
    re: /@(Get|Post|Put|Patch|Delete|GetMapping|PostMapping|PutMapping|PatchMapping|DeleteMapping|RequestMapping)\s*\(\s*(?:value\s*=\s*|path\s*=\s*)?['"]?([^'")]*)['"]?/g,
    method: (m) => (m[1] === 'RequestMapping' ? 'ANY' : m[1].replace('Mapping', '').toUpperCase()),
    path: (m) => m[2] || '/'
  },
  // ASP.NET attributes and minimal APIs
  { re: /\[Http(Get|Post|Put|Patch|Delete)\s*(?:\(\s*"([^"]*)"\s*\))?\]/g, method: (m) => m[1].toUpperCase(), path: (m) => m[2] ?? '' },
  { re: /\.Map(Get|Post|Put|Patch|Delete)\s*\(\s*"([^"]*)"/g, method: (m) => m[1].toUpperCase(), path: (m) => m[2] },
  // Go net/http
  { re: /\b(?:http\.)?HandleFunc\s*\(\s*"([^"]+)"/g, method: () => 'ANY', path: (m) => m[1].replace(/^(GET|POST|PUT|PATCH|DELETE)\s+/, '') },
  // Rust axum / actix
  { re: /\.route\s*\(\s*"([^"]+)"\s*,\s*(get|post|put|patch|delete)/g, method: (m) => m[2].toUpperCase(), path: (m) => m[1] },
  { re: /#\[(get|post|put|patch|delete)\s*\(\s*"([^"]+)"/g, method: (m) => m[1].toUpperCase(), path: (m) => m[2] },
  // Laravel / Rails
  { re: /Route::(get|post|put|patch|delete|any)\s*\(\s*['"]([^'"]+)['"]/g, method: (m) => m[1].toUpperCase(), path: (m) => m[2] },
  { re: /^\s*(get|post|put|patch|delete)\s+['"]([^'"]+)['"]/gm, method: (m) => m[1].toUpperCase(), path: (m) => m[2] }
]

/** File-system routing conventions (Next.js, Nuxt, SvelteKit, Remix, Astro). */
export function fileRoute(path: string): { route: Route; kind: 'api' | 'page' } | null {
  const toRoute = (segs: string): string =>
    '/' +
    segs
      .split('/')
      .filter((s) => s && !/^\(.*\)$/.test(s) && !s.startsWith('@'))
      .map((s) => s.replace(/^\[\[?\.\.\.(\w+)\]?\]$/, '*').replace(/^\[(\w+)\]$/, ':$1').replace(/^\$(\w+)$/, ':$1'))
      .join('/')
  let m = path.match(/(?:^|\/)app\/(.*?)\/?route\.(?:ts|js|tsx|jsx)$/)
  if (m) return { route: { method: 'ANY', path: toRoute(m[1]), line: 1 }, kind: 'api' }
  m = path.match(/(?:^|\/)pages\/api\/(.*?)(?:\/index)?\.(?:ts|js|tsx|jsx)$/)
  if (m) return { route: { method: 'ANY', path: '/api' + toRoute(m[1]).replace(/^\/$/, ''), line: 1 }, kind: 'api' }
  m = path.match(/(?:^|\/)app\/(.*?)\/?page\.(?:tsx|jsx|ts|js|mdx)$/)
  if (m) return { route: { method: 'PAGE', path: toRoute(m[1]), line: 1 }, kind: 'page' }
  m = path.match(/(?:^|\/)pages\/(?!api\/|_)(.*?)(?:\/index)?\.(?:tsx|jsx|vue)$/)
  if (m) return { route: { method: 'PAGE', path: toRoute(m[1]), line: 1 }, kind: 'page' }
  m = path.match(/(?:^|\/)routes\/(.*?)\/?\+(page|server)\.(?:svelte|ts|js)$/)
  if (m) return { route: { method: m[2] === 'page' ? 'PAGE' : 'ANY', path: toRoute(m[1]), line: 1 }, kind: m[2] === 'page' ? 'page' : 'api' }
  return null
}

export function detectRoutes(text: string): Route[] {
  const out: Route[] = []
  const seen = new Set<string>()
  for (const p of ROUTE_PATTERNS) {
    p.re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = p.re.exec(text))) {
      const path = p.path(m)
      if (path.length > 120 || /\s/.test(path) || (path && !/^[/\w:{}<>*.$-]/.test(path))) continue
      const r = { method: p.method(m), path: path.startsWith('/') || !path ? path || '/' : '/' + path, line: lineAt(text, m.index) }
      const key = r.method + r.path + r.line
      if (!seen.has(key)) (seen.add(key), out.push(r))
    }
  }
  return out
}

const CALL_PATTERNS: { re: RegExp; method: (m: RegExpExecArray) => string; url: (m: RegExpExecArray) => string }[] = [
  { re: /\bfetch\s*\(\s*['"`]([^'"`]+)['"`]/g, method: () => 'ANY', url: (m) => m[1] },
  {
    re: /\b(?:axios|http|https|api|client|ky|got|request|requests|httpx|session|\$http|this\.http)\s*\.\s*(get|post|put|patch|delete)\s*(?:<[^>]*>)?\s*\(\s*f?['"`]([^'"`]+)['"`]/g,
    method: (m) => m[1].toUpperCase(),
    url: (m) => m[2]
  },
  { re: /\bhttp\.(?:Get|Post|NewRequest)\s*\(\s*(?:"[A-Z]+"\s*,\s*)?"([^"]+)"/g, method: () => 'ANY', url: (m) => m[1] },
  { re: /\b(?:request|req)\s*<[^>]*>\s*\(\s*['"`]([^'"`]+)['"`]/g, method: () => 'ANY', url: (m) => m[1] },
  // Typed wrappers: request<T>('/path', …) or request('/path', …)
  { re: /\brequest\s*\(\s*['"`](\/[^'"`]*)['"`]/g, method: () => 'ANY', url: (m) => m[1] }
]

export function detectHttpCalls(text: string): HttpCall[] {
  const out: HttpCall[] = []
  for (const p of CALL_PATTERNS) {
    p.re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = p.re.exec(text))) {
      const url = p.url(m).replace(/\$\{[^}]*\}/g, ':p').replace(/\{[^}]*\}/g, ':p')
      if (!url.startsWith('/') && !/^https?:\/\//.test(url)) continue
      out.push({ method: p.method(m), url, line: lineAt(text, m.index) })
    }
  }
  return out
}

export function detectFlags(path: string, text: string): FileFlag[] {
  const flags = new Set<FileFlag>()
  const base = path.slice(path.lastIndexOf('/') + 1)
  if (
    /(^|\/)(__tests__|tests?|spec|specs|e2e|__mocks__)\//.test(path) ||
    /\.(test|spec|e2e)\.[a-z]+$/.test(base) ||
    /_test\.go$/.test(base) ||
    /^test_.*\.py$|_test\.py$/.test(base) ||
    /(Test|Tests|Spec)\.(java|kt|cs)$/.test(base)
  )
    flags.add('test')
  if (
    /#!\/usr\/bin\/env/.test(text.slice(0, 40)) ||
    /\b(commander|yargs|cac|meow|clipanion|oclif)\b|from ['"](commander|yargs)|\bargparse\b|\bimport click\b|@click\.command|\btyper\.Typer\(|\bcobra\.Command\b|\bclap::Parser\b|\bflag\.Parse\(\)/.test(text)
  )
    flags.add('cli')
  if (/\bif __name__ == ['"]__main__['"]/.test(text) || /^func main\(\)/m.test(text) || /\bstatic void Main\b|public static void main\s*\(/.test(text))
    flags.add('entry')
  if (/\b(node-cron|cron\.schedule|@Cron\(|@Scheduled\(|schedule\.every|APScheduler|BlockingScheduler|celery\.beat|beat_schedule|CronJob\(|robfig\/cron|@crontab|crontab\()/.test(text))
    flags.add('cron')
  if (/\b(new Worker\(|@Processor\(|consumer\.run\(|\.subscribe\(|@KafkaListener|@RabbitListener|@SqsListener|shared_task|@app\.task|channel\.consume\()/.test(text))
    flags.add('queue')
  if (/\.(tsx|jsx|vue|svelte)$/.test(base) && /\breturn\s*\(?\s*</.test(text)) flags.add('component')
  if (/\.(vue|svelte)$/.test(base)) flags.add('component')
  if (/(^|\/)(pages|views|screens|routes)\//.test(path) && /\.(tsx|jsx|vue|svelte)$/.test(base)) flags.add('page')
  if (/webhook/i.test(path)) flags.add('webhook')
  if (/(^|\/)admin(\/|\.|-|_)/i.test(path)) flags.add('admin')
  return [...flags]
}

// ── Well-known external services and data stores ──────────────────────────────────────────────

export interface KnownService {
  id: string
  label: string
  kind: 'external' | 'datastore'
  tech?: string
}

const S = (id: string, label: string, kind: KnownService['kind'] = 'external', tech?: string): KnownService => ({ id, label, kind, tech })

/** Package (or import path prefix) → service. Matched against package names across ecosystems. */
const PACKAGES: [RegExp, KnownService][] = [
  [/^stripe$|^stripe-go|stripe\/stripe-|^Stripe\.net$/i, S('stripe', 'Stripe')],
  [/^openai$|sashabaranov\/go-openai|^OpenAI$/i, S('openai', 'OpenAI API')],
  [/^@anthropic-ai\/sdk$|^anthropic$|anthropics\/anthropic-sdk/i, S('anthropic', 'Anthropic API')],
  [/^ollama$/i, S('ollama', 'Ollama (local LLM)')],
  [/^@google\/genai$|^@google\/generative-ai$|^google\.generativeai|^google-genai/i, S('gemini', 'Google Gemini')],
  [/^@aws-sdk\/client-s3$|^aws-sdk$|^boto3$|^botocore$|aws\/aws-sdk-go/i, S('aws', 'AWS')],
  [/^firebase(-admin)?$|^firebase_admin$/i, S('firebase', 'Firebase')],
  [/^@supabase\//i, S('supabase', 'Supabase', 'datastore', 'Postgres')],
  [/^twilio$/i, S('twilio', 'Twilio')],
  [/^@sendgrid\/|^sendgrid$|^resend$|^nodemailer$|^postmark$|^mailgun/i, S('email', 'Email provider')],
  [/^@slack\/|^slack_sdk$|^slack-go/i, S('slack', 'Slack')],
  [/^discord\.js$|^discord\.py$|^discord$/i, S('discord', 'Discord')],
  [/^@octokit\/|^PyGithub$|^github$|google\/go-github/i, S('github', 'GitHub API')],
  [/^googleapis$|^@google-cloud\/|^google\.cloud/i, S('gcp', 'Google Cloud')],
  [/^@sentry\/|^sentry[-_]sdk$|getsentry\/sentry-go/i, S('sentry', 'Sentry')],
  [/^posthog|^@segment\/|^mixpanel|^@amplitude\//i, S('analytics', 'Product analytics')],
  [/^plaid$/i, S('plaid', 'Plaid')],
  [/^@paypal\/|^paypal/i, S('paypal', 'PayPal')],
  [/^@clerk\//i, S('clerk', 'Clerk (auth)')],
  [/^auth0|^@auth0\//i, S('auth0', 'Auth0')],
  [/^algoliasearch$/i, S('algolia', 'Algolia')],
  [/^mapbox|^@mapbox\//i, S('mapbox', 'Mapbox')],
  [/^telegraf$|^python-telegram-bot$|^aiogram$/i, S('telegram', 'Telegram')],
  [/^paho[-.]mqtt|^mqtt$|eclipse\/paho/i, S('mqtt', 'MQTT broker')],
  [/^pg$|^postgres$|^pg-promise$|^psycopg2?$|^psycopg$|^asyncpg$|jackc\/pgx|lib\/pq|^Npgsql$/i, S('postgres', 'PostgreSQL', 'datastore', 'SQL')],
  [/^mysql2?$|^pymysql$|^mysqlclient$|go-sql-driver\/mysql/i, S('mysql', 'MySQL', 'datastore', 'SQL')],
  [/^sqlite3?$|^better-sqlite3$|^sqlite$|mattn\/go-sqlite3|^rusqlite$/i, S('sqlite', 'SQLite', 'datastore', 'SQL')],
  [/^@prisma\/client$|^prisma$/i, S('db', 'Database', 'datastore', 'Prisma')],
  [/^drizzle-orm$|^typeorm$|^sequelize$|^knex$|^kysely$|^@mikro-orm\//i, S('db', 'Database', 'datastore', 'SQL')],
  [/^sqlalchemy$|^sqlmodel$|^django\.db|^peewee$|^tortoise$|gorm\.io|^sqlx$|^diesel$|^EntityFramework/i, S('db', 'Database', 'datastore', 'SQL')],
  [/^mongoose$|^mongodb$|^pymongo$|^motor$|mongo-driver/i, S('mongodb', 'MongoDB', 'datastore', 'NoSQL')],
  [/^redis$|^ioredis$|^@upstash\/redis$|go-redis|^StackExchange\.Redis$/i, S('redis', 'Redis', 'datastore', 'Cache')],
  [/^bullmq$|^bull$|^bee-queue$/i, S('redis', 'Redis', 'datastore', 'Queue')],
  [/^kafkajs$|^kafka-python$|^confluent_kafka$|segmentio\/kafka-go/i, S('kafka', 'Kafka', 'external', 'Events')],
  [/^amqplib$|^pika$|^aio-pika$|rabbitmq\/amqp/i, S('rabbitmq', 'RabbitMQ', 'external', 'Queue')],
  [/^@elastic\/elasticsearch$|^elasticsearch$/i, S('elasticsearch', 'Elasticsearch', 'datastore', 'Search')],
  [/^influxdb|^@influxdata\//i, S('influxdb', 'InfluxDB', 'datastore', 'Time series')],
  [/^@pinecone-database\/|^pinecone$|^chromadb$|^qdrant|^weaviate/i, S('vectordb', 'Vector DB', 'datastore', 'Embeddings')]
]

export function knownService(pkg: string): KnownService | null {
  for (const [re, s] of PACKAGES) if (re.test(pkg)) return s
  return null
}

/** Host of an absolute URL → external service id/label. Skips localhost & example hosts. */
export function hostService(url: string): KnownService | null {
  const m = url.match(/^https?:\/\/([^/:?#]+)/)
  if (!m) return null
  const host = m[1].toLowerCase()
  if (/^(localhost|127\.|0\.0\.0\.0|example\.|.*\.local$)/.test(host) || host.includes(':p')) return null
  const parts = host.split('.')
  const core = parts.length > 2 ? parts.slice(-2).join('.') : host
  const name = core.split('.')[0]
  return { id: 'ext-' + name, label: name.charAt(0).toUpperCase() + name.slice(1) + ' API', kind: 'external', tech: host }
}

/** Frameworks visible in a manifest's dependencies → a short tech label for the box. */
const FRAMEWORKS: [RegExp, string, 'frontend' | 'backend' | 'mobile' | 'desktop' | null][] = [
  [/"next"\s*:/, 'Next.js', 'frontend'],
  [/"nuxt"\s*:/, 'Nuxt', 'frontend'],
  [/"@sveltejs\/kit"\s*:/, 'SvelteKit', 'frontend'],
  [/"@remix-run\//, 'Remix', 'frontend'],
  [/"astro"\s*:/, 'Astro', 'frontend'],
  [/"react-native"\s*:|"expo"\s*:/, 'React Native', 'mobile'],
  [/"electron"\s*:/, 'Electron', 'desktop'],
  [/"@angular\/core"\s*:/, 'Angular', 'frontend'],
  [/"vue"\s*:/, 'Vue', 'frontend'],
  [/"svelte"\s*:/, 'Svelte', 'frontend'],
  [/"react"\s*:/, 'React', 'frontend'],
  [/"@nestjs\/core"\s*:/, 'NestJS', 'backend'],
  [/"fastify"\s*:/, 'Fastify', 'backend'],
  [/"express"\s*:/, 'Express', 'backend'],
  [/"hono"\s*:/, 'Hono', 'backend'],
  [/"koa"\s*:/, 'Koa', 'backend'],
  [/fastapi/i, 'FastAPI', 'backend'],
  [/django/i, 'Django', 'backend'],
  [/flask/i, 'Flask', 'backend'],
  [/streamlit/i, 'Streamlit', 'frontend'],
  [/gin-gonic\/gin/, 'Gin', 'backend'],
  [/labstack\/echo/, 'Echo', 'backend'],
  [/go-chi\/chi/, 'chi', 'backend'],
  [/gofiber\/fiber/, 'Fiber', 'backend'],
  [/\baxum\b/, 'axum', 'backend'],
  [/actix-web/, 'Actix', 'backend'],
  [/spring-boot/, 'Spring Boot', 'backend'],
  [/laravel\/framework/, 'Laravel', 'backend'],
  [/\brails\b/, 'Rails', 'backend'],
  [/Microsoft\.AspNetCore|Sdk="Microsoft\.NET\.Sdk\.Web"/, 'ASP.NET Core', 'backend'],
  [/flutter/, 'Flutter', 'mobile']
]

export function detectFramework(manifest: string): { tech: string; role: 'frontend' | 'backend' | 'mobile' | 'desktop' | null } | null {
  for (const [re, tech, role] of FRAMEWORKS) if (re.test(manifest)) return { tech, role }
  return null
}

/** Normalise a route or URL path so client calls can be matched to server routes. */
export function normPath(p: string): string {
  let s = p.replace(/^https?:\/\/[^/]+/, '').split('?')[0]
  s = s
    .replace(/<[^>]+>/g, ':p') // flask <id>, django <int:id>
    .replace(/\{[^}]+\}/g, ':p') // fastapi {id}, spring {id}
    .replace(/:\w+/g, ':p')
    .replace(/\/+$/, '')
  return s || '/'
}

export function pathsMatch(callPath: string, routePath: string): boolean {
  const a = normPath(callPath).split('/')
  const b = normPath(routePath).split('/')
  if (b[b.length - 1] === '*') return a.length >= b.length - 1 && b.slice(0, -1).every((s, i) => s === ':p' || a[i] === ':p' || s === a[i])
  if (a.length !== b.length) return false
  return a.every((s, i) => s === b[i] || s === ':p' || b[i] === ':p')
}

// ── Side effects ──────────────────────────────────────────────────────────────────────────────

export interface Effect {
  kind: import('@shared/model').EffectKind
  line: number
  what: string
}

type EffectRule = [Effect['kind'], RegExp, string, ('python' | 'js' | 'any')?]

const EFFECT_RULES: EffectRule[] = [
  ['network', /\bfetch\s*\(\s*[`'"a-zA-Z]|\baxios\s*[.(]|\brequests\.(get|post|put|patch|delete|request|Session)\b|\bhttpx\.\w|\baiohttp\.ClientSession|\burllib\.request\b|\burlopen\(|\bhttp\.(Get|Post|NewRequest)\(|\bnew WebSocket\(|\bsocket\.socket\(|\bsmtplib\.SMTP/, 'network call'],
  ['filesystem', /\bfs\.(promises\.)?(writeFile|appendFile|mkdir|rm|rmdir|unlink|rename|copyFile|readFile|readdir|createWriteStream|createReadStream)\b|\b(writeFileSync|readFileSync|appendFileSync|mkdirSync|unlinkSync|rmSync|existsSync)\(|\bos\.(WriteFile|ReadFile|Create|Remove)\(/, 'file I/O', 'any'],
  ['filesystem', /(?<![.\w])open\s*\(|\.(write_text|read_text|write_bytes|read_bytes|mkdir|unlink|touch|rmdir)\(|\bshutil\.\w+\(|\bos\.(remove|unlink|makedirs|mkdir|rename|replace|listdir|walk|scandir)\(/, 'file I/O', 'python'],
  ['database', /\b(cursor|conn|connection|session|db)\.(execute|executemany|commit|query|add|merge|scalars)\(|\bprisma\.\w+\.(find\w*|create\w*|update\w*|delete\w*|upsert)\(|\bsqlite3\.connect\(|\.objects\.(filter|get|create|all|exclude)\(/, 'database access'],
  ['process', /\bsubprocess\.\w+\(|\bos\.(system|popen|exec\w*|spawn\w*)\(|\bchild_process\b|\b(execSync|spawnSync|execFile|execFileSync)\(|\bexec\.Command\(|\bRuntime\.getRuntime\(\)\.exec/, 'runs a subprocess'],
  ['env', /\bos\.environ\b|\bos\.getenv\(|\bprocess\.env\b|\bimport\.meta\.env\b|\bos\.Getenv\(|\bstd::env::var/, 'reads environment'],
  ['global-state', /^[ \t]+global[ \t]+\w+/m, 'mutates a module global', 'python'],
  ['global-state', /^(?:export\s+)?(?:let|var)\s+\w+\s*(?:[:=;]|$)/m, 'mutable module variable', 'js']
]

/** The top-level package of an import spec: "sqlalchemy.orm" → "sqlalchemy", "@aws-sdk/x/y" → "@aws-sdk/x". */
const topPackage = (spec: string): string => (spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split(/[./]/)[0])

/** Side effects visible in a file: text patterns plus imports of known data stores, queues and APIs. */
export function detectEffects(text: string, lang: 'python' | 'js' | 'other', imports: string[] = []): Effect[] {
  const out = new Map<Effect['kind'], Effect>()
  for (const [kind, re, what, only] of EFFECT_RULES) {
    if (out.has(kind)) continue
    if (only && only !== 'any' && only !== lang) continue
    const m = re.exec(text)
    if (m) out.set(kind, { kind, line: lineAt(text, m.index), what: `${what} (${m[0].trim().slice(0, 40)})` })
  }
  for (const spec of imports) {
    if (spec.startsWith('.')) continue
    const s = knownService(topPackage(spec)) ?? knownService(spec)
    if (!s) continue
    const kind: Effect['kind'] = s.tech === 'Queue' || s.tech === 'Events' || /^(mqtt|kafka|rabbitmq)$/.test(s.id) ? 'queue' : s.kind === 'datastore' ? 'database' : 'network'
    if (out.has(kind)) continue
    const at = text.indexOf(spec)
    out.set(kind, { kind, line: at >= 0 ? lineAt(text, at) : 1, what: `uses ${s.label} (${spec})` })
  }
  return [...out.values()]
}
