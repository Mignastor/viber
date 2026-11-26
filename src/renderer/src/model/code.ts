import { sampleModel } from './sample'

// Simulated file contents for the sample project. Files the session edits have several versions;
// the simulation says which version is current.

export type FileVersions = Record<string, string> // version key → content; 'base' is the original

const tokensBase = `import jwt from 'jsonwebtoken'
import { config } from '../config'

export interface Claims {
  sub: string
  iat: number
  exp: number
}

const ACCESS_TTL = '7d'

/** Sign an access token for the given user. */
export function issue(userId: string): string {
  return jwt.sign({ sub: userId }, config.jwtSecret, { expiresIn: ACCESS_TTL })
}

/** Verify a token and return its claims, or null if invalid/expired. */
export function verify(token: string): Claims | null {
  try {
    return jwt.verify(token, config.jwtSecret) as Claims
  } catch {
    return null
  }
}
`

const tokensV1 = `import jwt from 'jsonwebtoken'
import { config } from '../config'
import { randomToken } from '../lib/crypto/hash'
import * as refreshStore from './refreshStore'

export interface Claims {
  sub: string
  iat: number
  exp: number
}

export interface TokenPair {
  accessToken: string
  refreshToken: string
}

const ACCESS_TTL = '15m'
const REFRESH_TTL_DAYS = 30

/** Issue a short-lived access token plus a long-lived refresh token. */
export async function issue(userId: string): Promise<TokenPair> {
  const accessToken = jwt.sign({ sub: userId }, config.jwtSecret, { expiresIn: ACCESS_TTL })
  const refreshToken = randomToken()
  await refreshStore.save(userId, refreshToken, REFRESH_TTL_DAYS)
  return { accessToken, refreshToken }
}

/** Exchange a refresh token for a new pair. The old refresh token is revoked (rotation). */
export async function rotate(refreshToken: string): Promise<TokenPair | null> {
  const record = await refreshStore.find(refreshToken)
  if (!record) return null
  await refreshStore.revoke(record.id)
  return issue(record.userId)
}

/** Verify a token and return its claims, or null if invalid/expired. */
export function verify(token: string): Claims | null {
  try {
    return jwt.verify(token, config.jwtSecret) as Claims
  } catch {
    return null
  }
}
`

const tokensV2 = tokensV1.replace(
  `  if (!record) return null\n`,
  `  if (!record || record.revokedAt || record.expiresAt < new Date()) return null\n`
)

const loginBase = `import bcrypt from 'bcryptjs'
import { db } from '../db'
import { issue } from './tokens'
import { createSession } from './sessions'

export class InvalidCredentials extends Error {}

/** Check credentials and return a signed access token. */
export async function login(email: string, password: string): Promise<string> {
  const user = await db.oneOrNone('SELECT id, password_hash FROM users WHERE email = $1', [email])
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    throw new InvalidCredentials()
  }
  await createSession(user.id)
  return issue(user.id)
}
`

const loginV1 = `import bcrypt from 'bcryptjs'
import { db } from '../db'
import { issue, rotate, type TokenPair } from './tokens'
import { createSession } from './sessions'

export class InvalidCredentials extends Error {}

/** Check credentials and return an access + refresh token pair. */
export async function login(email: string, password: string): Promise<TokenPair> {
  const user = await db.oneOrNone('SELECT id, password_hash FROM users WHERE email = $1', [email])
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    throw new InvalidCredentials()
  }
  await createSession(user.id)
  return issue(user.id)
}

/** Exchange a refresh token for a fresh pair. Throws if it is unknown, expired or revoked. */
export async function refresh(refreshToken: string): Promise<TokenPair> {
  const pair = await rotate(refreshToken)
  if (!pair) throw new InvalidCredentials()
  return pair
}
`

const authRoutesBase = `import type { FastifyInstance } from 'fastify'
import { login, InvalidCredentials } from '../../auth/login'
import type { Deps } from '../server'

export function authRoutes(app: FastifyInstance, _deps: Deps): void {
  app.post<{ Body: { email: string; password: string } }>(
    '/auth/login',
    { schema: { body: { type: 'object', required: ['email', 'password'] } } },
    async (req, reply) => {
      try {
        const token = await login(req.body.email, req.body.password)
        return { token }
      } catch (err) {
        if (err instanceof InvalidCredentials) return reply.code(401).send({ error: 'invalid_credentials' })
        throw err
      }
    }
  )
}
`

const authRoutesV1 = `import type { FastifyInstance } from 'fastify'
import { login, refresh, InvalidCredentials } from '../../auth/login'
import type { Deps } from '../server'

export function authRoutes(app: FastifyInstance, _deps: Deps): void {
  app.post<{ Body: { email: string; password: string } }>(
    '/auth/login',
    { schema: { body: { type: 'object', required: ['email', 'password'] } } },
    async (req, reply) => {
      try {
        return await login(req.body.email, req.body.password)
      } catch (err) {
        if (err instanceof InvalidCredentials) return reply.code(401).send({ error: 'invalid_credentials' })
        throw err
      }
    }
  )

  app.post<{ Body: { refreshToken: string } }>(
    '/auth/refresh',
    { schema: { body: { type: 'object', required: ['refreshToken'] } } },
    async (req, reply) => {
      try {
        return await refresh(req.body.refreshToken)
      } catch (err) {
        if (err instanceof InvalidCredentials) return reply.code(401).send({ error: 'invalid_refresh_token' })
        throw err
      }
    }
  )
}
`

const clientBase = `import type { Plant } from './types'

const BASE = import.meta.env.VITE_API_URL
let token: string | null = localStorage.getItem('token')

export async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(BASE + path, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: \`Bearer \${token}\` } : {}),
      ...init.headers
    }
  })
  if (!res.ok) throw new Error(\`\${res.status} \${path}\`)
  return res.status === 204 ? (undefined as T) : res.json()
}

export const api = {
  async login(email: string, password: string): Promise<void> {
    const res = await request<{ token: string }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password })
    })
    token = res.token
    localStorage.setItem('token', token)
  },
  plants: () => request<Plant[]>('/plants'),
  logCare: (id: string, action: string) =>
    request<void>(\`/plants/\${id}/care\`, { method: 'POST', body: JSON.stringify({ action }) })
}
`

const clientV1 = `import type { Plant } from './types'

const BASE = import.meta.env.VITE_API_URL
let accessToken: string | null = localStorage.getItem('accessToken')
let refreshToken: string | null = localStorage.getItem('refreshToken')

interface TokenPair {
  accessToken: string
  refreshToken: string
}

function store(pair: TokenPair): void {
  accessToken = pair.accessToken
  refreshToken = pair.refreshToken
  localStorage.setItem('accessToken', pair.accessToken)
  localStorage.setItem('refreshToken', pair.refreshToken)
}

async function refreshTokens(): Promise<boolean> {
  if (!refreshToken) return false
  const res = await fetch(BASE + '/auth/refresh', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refreshToken })
  })
  if (!res.ok) return false
  store(await res.json())
  return true
}

export async function request<T>(path: string, init: RequestInit = {}, retried = false): Promise<T> {
  const res = await fetch(BASE + path, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(accessToken ? { authorization: \`Bearer \${accessToken}\` } : {}),
      ...init.headers
    }
  })
  if (res.status === 401 && !retried && (await refreshTokens())) {
    return request<T>(path, init, true)
  }
  if (!res.ok) throw new Error(\`\${res.status} \${path}\`)
  return res.status === 204 ? (undefined as T) : res.json()
}

export const api = {
  async login(email: string, password: string): Promise<void> {
    store(
      await request<TokenPair>('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password })
      })
    )
  },
  plants: () => request<Plant[]>('/plants'),
  logCare: (id: string, action: string) =>
    request<void>(\`/plants/\${id}/care\`, { method: 'POST', body: JSON.stringify({ action }) })
}
`

const gardenBase = `import { useEffect, useState } from 'react'
import { api } from '../api/client'
import type { Plant } from '../api/types'
import { PlantCard } from '../components/PlantCard'

export function GardenView(): JSX.Element {
  const [plants, setPlants] = useState<Plant[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api.plants().then(setPlants).catch((e) => setError(String(e)))
  }, [])

  if (error) return <p className="error">{error}</p>

  return (
    <main className="garden">
      {plants.map((p) => (
        <PlantCard key={p.id} plant={p} onCare={(a) => api.logCare(p.id, a)} />
      ))}
    </main>
  )
}
`

const gardenV1 = `import { useEffect, useState } from 'react'
import type { Plant } from '../api/types'
import { api } from '../api/client'
import { PlantCard } from '../components/PlantCard'

export const GardenView = (): JSX.Element => {
  const [plants, setPlants] = useState<Plant[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api
      .plants()
      .then(setPlants)
      .catch((e: unknown) => setError(String(e)))
  }, [])

  if (error) {
    return <p className="error">{error}</p>
  }

  return (
    <main className="garden">
      {plants.map((plant) => (
        <PlantCard key={plant.id} plant={plant} onCare={(action) => api.logCare(plant.id, action)} />
      ))}
    </main>
  )
}
`

const refreshStoreV1 = `import { db } from '../db'
import { sha256 } from '../lib/crypto/hash'

export interface RefreshRecord {
  id: string
  userId: string
  expiresAt: Date
  revokedAt: Date | null
}

/** Store a refresh token. Only its SHA-256 hash is persisted. */
export async function save(userId: string, token: string, ttlDays: number): Promise<void> {
  await db.none(
    \`INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
     VALUES ($1, $2, now() + make_interval(days => $3))\`,
    [userId, sha256(token), ttlDays]
  )
}

/** Look a token up by hash. Returns revoked and expired records too; callers decide. */
export async function find(token: string): Promise<RefreshRecord | null> {
  return db.oneOrNone(
    \`SELECT id, user_id AS "userId", expires_at AS "expiresAt", revoked_at AS "revokedAt"
     FROM refresh_tokens WHERE token_hash = $1\`,
    [sha256(token)]
  )
}

export async function revoke(id: string): Promise<void> {
  await db.none('UPDATE refresh_tokens SET revoked_at = now() WHERE id = $1', [id])
}

export async function revokeAllForUser(userId: string): Promise<void> {
  await db.none('UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [userId])
}
`

const migrationV1 = `-- 0007: refresh tokens for long-lived sessions
CREATE TABLE refresh_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX refresh_tokens_user_idx ON refresh_tokens (user_id) WHERE revoked_at IS NULL;
`

const hashV1 = `import { createHash, randomBytes } from 'node:crypto'

/** 256-bit URL-safe random token. */
export function randomToken(): string {
  return randomBytes(32).toString('base64url')
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
`

export const fileVersions: Record<string, FileVersions> = {
  'src/auth/tokens.ts': { base: tokensBase, v1: tokensV1, v2: tokensV2 },
  'src/auth/login.ts': { base: loginBase, v1: loginV1 },
  'src/http/routes/auth.ts': { base: authRoutesBase, v1: authRoutesV1 },
  'web/src/api/client.ts': { base: clientBase, v1: clientV1 },
  'web/src/pages/GardenView.tsx': { base: gardenBase, v1: gardenV1 },
  'src/auth/refreshStore.ts': { v1: refreshStoreV1 },
  'db/migrations/0007_refresh_tokens.sql': { v1: migrationV1 },
  'src/lib/crypto/hash.ts': { v1: hashV1 }
}

/** For files without hand-written content, render a stub from the model's symbols. */
function stub(path: string): string {
  const syms = sampleModel.nodes.flatMap((n) => n.symbols).filter((s) => s.file === path)
  if (path.endsWith('.sql')) {
    return `-- ${path}\n` + syms.map((s) => `-- ${s.signature}`).join('\n') + '\n'
  }
  if (path.endsWith('.yaml')) return `# ${path}\nschedule: "0 6 * * *"\ncommand: node dist/reminders/run.js\n`
  const body = syms
    .map((s) => `export function ${s.signature.replace(/^function /, '')} {\n  // …\n}\n`)
    .join('\n')
  return `// ${path}\n// (sample content, not generated by an agent)\n\n${body}`
}

/** Content of a file at a given version ('base' when unchanged). */
export function fileContent(path: string, version = 'base'): string {
  const v = fileVersions[path]
  if (v && v[version] !== undefined) return v[version]
  if (v && version === 'base') return ''
  return stub(path)
}

export function languageOf(path: string): string {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
    js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
    py: 'python', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', kts: 'kotlin', cs: 'csharp',
    php: 'php', rb: 'ruby', swift: 'swift', sql: 'sql', yaml: 'yaml', yml: 'yaml', json: 'json',
    md: 'markdown', css: 'css', scss: 'scss', html: 'html', vue: 'html', svelte: 'html', toml: 'ini', sh: 'shell'
  }
  return map[ext] ?? 'plaintext'
}

/** Line-level diff counts via LCS. Files are small, so O(n·m) is fine. */
export function diffCounts(before: string, after: string): { added: number; removed: number } {
  const a = before ? before.split('\n') : []
  const b = after.split('\n')
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
  const common = dp[0][0]
  return { added: b.length - common, removed: a.length - common }
}
