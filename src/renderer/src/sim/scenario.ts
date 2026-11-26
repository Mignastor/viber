import type { SimEvent } from '@shared/events'

// A scripted agent session. In the real product these events come from the file watcher (edits),
// the MCP intent channel (intent, plan) and the test runner. The IDE never trusts the agent's own
// story: edits are mapped to boxes by file path, not by what the agent says.

export type { ContextItem, ContractChange, Classification, SimEvent } from '@shared/events'

export const AGENT_NAME = 'Claude Code'

export const TASK_PROMPT = 'Add refresh tokens so users stay logged in for 30 days'

export const scenario: SimEvent[] = [
  { id: 'task', t: 'task', ms: 700, tokens: 40, naive: 40, prompt: TASK_PROMPT, scope: ['auth'] },
  {
    id: 'context',
    t: 'context',
    ms: 1800,
    tokens: 0, // counted per item
    naive: 31200,
    naiveNote: '≈ 14 whole-file reads + 9 greps to find the auth code',
    items: [
      { label: 'Architecture overview', detail: 'cached prompt prefix · zoom: Service', tokens: 1400 },
      { label: 'Auth · purpose + contracts', detail: 'box summary from .arch/model.yaml', tokens: 600 },
      { label: 'Symbols (signatures only)', detail: 'issue · verify · login · createSession · revokeAll', tokens: 850 },
      { label: 'Callers (1 hop)', detail: 'HTTP API → /auth/login', tokens: 380 },
      { label: 'Edge contract', detail: 'API Client → HTTP API', tokens: 260 },
      { label: 'Mapped tests', detail: 'tokens.test.ts · login.test.ts · auth.test.ts', tokens: 540 }
    ]
  },
  {
    id: 'intent',
    t: 'intent',
    ms: 1600,
    tokens: 320,
    naive: 320,
    agent: AGENT_NAME,
    nodes: ['tokenService', 'loginHandler', 'http'],
    summary: 'About to change Auth: add rotating refresh tokens with a new /auth/refresh route.'
  },
  {
    id: 'plan',
    t: 'plan',
    ms: 1400,
    tokens: 1900,
    naive: 6200,
    steps: [
      'Migration 0007: refresh_tokens table (hashed tokens)',
      'New RefreshTokenStore inside Auth',
      'TokenService.issue() returns {access, refresh}; add rotate()',
      'LoginHandler.refresh() + POST /auth/refresh',
      'API Client: on 401, refresh once and retry'
    ],
    addNodes: [
      {
        id: 'refreshStore',
        parent: 'auth',
        label: 'RefreshTokenStore',
        kind: 'box',
        purpose: 'Persists hashed refresh tokens; supports lookup, rotation and revocation.',
        files: ['src/auth/refreshStore.ts'],
        symbols: [
          { name: 'save', signature: 'save(userId: string, token: string, ttlDays: number): Promise<void>', file: 'src/auth/refreshStore.ts' },
          { name: 'find', signature: 'find(token: string): Promise<RefreshRecord | null>', file: 'src/auth/refreshStore.ts' },
          { name: 'revoke', signature: 'revoke(id: string): Promise<void>', file: 'src/auth/refreshStore.ts' }
        ],
        tests: ['src/auth/refreshStore.test.ts']
      }
    ],
    addEdges: [
      {
        id: 'e_token_refresh',
        source: 'tokenService',
        target: 'refreshStore',
        kind: 'call',
        label: 'save() · find() · revoke()',
        contract: ['save(userId, token, ttlDays): Promise<void>', 'find(token): Promise<RefreshRecord | null>', 'revoke(id): Promise<void>']
      },
      {
        id: 'e_refresh_db',
        source: 'refreshStore',
        target: 'db',
        kind: 'sql',
        label: 'refresh_tokens',
        contract: ['INSERT/SELECT/UPDATE refresh_tokens']
      }
    ],
    edgeChanges: {
      e_api_http: {
        removed: ['POST /auth/login {email, password} → {token}'],
        added: [
          'POST /auth/login {email, password} → {accessToken, refreshToken}',
          'POST /auth/refresh {refreshToken} → {accessToken, refreshToken}'
        ]
      },
      e_http_login: {
        removed: ['login(email: string, password: string): Promise<string>'],
        added: ['login(email: string, password: string): Promise<TokenPair>', 'refresh(refreshToken: string): Promise<TokenPair>']
      },
      e_login_token: {
        removed: ['issue(userId: string): string'],
        added: ['issue(userId: string): Promise<TokenPair>', 'rotate(refreshToken: string): Promise<TokenPair | null>']
      }
    },
    fence: ['auth', 'http', 'apiClient', 'db']
  },
  { id: 'approval', t: 'approval', ms: 600, tokens: 0, naive: 0 },
  {
    id: 'edit-migration',
    t: 'edit',
    ms: 1500,
    tokens: 700,
    naive: 4100,
    file: 'db/migrations/0007_refresh_tokens.sql',
    version: 'v1',
    note: 'Created refresh_tokens table'
  },
  {
    id: 'edit-hash',
    t: 'edit',
    ms: 1700,
    tokens: 450,
    naive: 2600,
    file: 'src/lib/crypto/hash.ts',
    version: 'v1',
    note: 'Added randomToken() and sha256() helpers',
    classify: {
      node: {
        id: 'cryptoUtils',
        parent: 'backend',
        label: 'Crypto utils',
        kind: 'box',
        purpose: 'Random token generation and hashing helpers.',
        files: ['src/lib/crypto/hash.ts'],
        symbols: [
          { name: 'randomToken', signature: 'randomToken(): string', file: 'src/lib/crypto/hash.ts' },
          { name: 'sha256', signature: 'sha256(value: string): string', file: 'src/lib/crypto/hash.ts' }
        ]
      },
      edges: [
        { id: 'e_token_crypto', source: 'tokenService', target: 'cryptoUtils', kind: 'call', label: 'randomToken()', contract: ['randomToken(): string'] },
        { id: 'e_refresh_crypto', source: 'refreshStore', target: 'cryptoUtils', kind: 'call', label: 'sha256()', contract: ['sha256(value): string'] }
      ],
      attachTo: 'auth',
      reason: 'Only imported by Auth today, but generic enough to be shared.'
    }
  },
  {
    id: 'edit-refreshStore',
    t: 'edit',
    ms: 1900,
    tokens: 1300,
    naive: 5200,
    file: 'src/auth/refreshStore.ts',
    version: 'v1',
    note: 'Implemented save / find / revoke',
    edges: ['e_refresh_db', 'e_refresh_crypto']
  },
  {
    id: 'edit-tokens',
    t: 'edit',
    ms: 2000,
    tokens: 1600,
    naive: 7400,
    file: 'src/auth/tokens.ts',
    version: 'v1',
    note: 'issue() now returns a TokenPair; added rotate()',
    edges: ['e_token_refresh', 'e_login_token', 'e_token_crypto']
  },
  {
    id: 'edit-login',
    t: 'edit',
    ms: 1700,
    tokens: 1100,
    naive: 6100,
    file: 'src/auth/login.ts',
    version: 'v1',
    note: 'login() returns a pair; added refresh()',
    edges: ['e_http_login', 'e_login_token']
  },
  {
    id: 'edit-routes',
    t: 'edit',
    ms: 1700,
    tokens: 1200,
    naive: 6800,
    file: 'src/http/routes/auth.ts',
    version: 'v1',
    note: 'Added POST /auth/refresh',
    edges: ['e_api_http', 'e_http_login']
  },
  {
    id: 'edit-garden',
    t: 'edit',
    ms: 1900,
    tokens: 900,
    naive: 3900,
    file: 'web/src/pages/GardenView.tsx',
    version: 'v1',
    note: 'Reformatted GardenView (not in the plan)'
  },
  {
    id: 'edit-client',
    t: 'edit',
    ms: 1900,
    tokens: 1400,
    naive: 6600,
    file: 'web/src/api/client.ts',
    version: 'v1',
    note: 'Store both tokens; refresh once on 401 and retry',
    edges: ['e_api_http']
  },
  {
    id: 'tests-1',
    t: 'tests',
    ms: 2200,
    tokens: 600,
    naive: 4800,
    selected: 23,
    total: 214,
    results: {
      tokenService: { passed: 6, failed: 1 },
      refreshStore: { passed: 3, failed: 0 },
      loginHandler: { passed: 4, failed: 0 },
      http: { passed: 5, failed: 0 },
      apiClient: { passed: 4, failed: 0 }
    },
    failures: ['tokens.test.ts › rotate() rejects a revoked refresh token']
  },
  {
    id: 'edit-tokens-fix',
    t: 'edit',
    ms: 1600,
    tokens: 700,
    naive: 3900,
    file: 'src/auth/tokens.ts',
    version: 'v2',
    note: 'rotate() now rejects revoked and expired tokens',
    edges: ['e_token_refresh']
  },
  {
    id: 'tests-2',
    t: 'tests',
    ms: 1800,
    tokens: 300,
    naive: 4800,
    selected: 23,
    total: 214,
    results: {
      tokenService: { passed: 7, failed: 0 },
      refreshStore: { passed: 3, failed: 0 },
      loginHandler: { passed: 4, failed: 0 },
      http: { passed: 5, failed: 0 },
      apiClient: { passed: 4, failed: 0 }
    },
    failures: []
  },
  {
    id: 'done',
    t: 'done',
    ms: 0,
    tokens: 250,
    naive: 1200,
    summary: 'Refresh tokens implemented. 23/23 affected tests pass. Ready for review.'
  }
]
