// The architecture model shared by the engine (main process) and the UI (renderer).
// Box/actor definitions live in `.arch/model.yaml` (committed, human-curated). Everything derived
// from code — symbols, edges, stats — is recomputed on every scan and cached in `.arch/cache/`.

export type NodeKind = 'box' | 'actor' | 'external' | 'datastore'
export type ActorType = 'user' | 'admin' | 'cron' | 'cli' | 'webhook' | 'system' | 'client'

export const ACTOR_TYPES: ActorType[] = ['user', 'admin', 'client', 'cli', 'cron', 'webhook', 'system']

export interface CodeSymbol {
  name: string
  signature: string
  file: string
  line?: number
  endLine?: number
  kind?: 'function' | 'class' | 'method' | 'interface' | 'type' | 'const' | 'component' | 'route'
  exported?: boolean
  /** First sentence of the symbol's docstring / leading comment. */
  doc?: string
  /** Field names of a class / interface / type (pydantic models, dataclasses, TS interfaces). */
  fields?: string[]
  /** Deepest nesting of control flow (if/for/while/try/…) inside a function. */
  nesting?: number
}

/** Checked code-style rules (project default, overridable per box). */
export interface CodeStyle {
  maxFunctionLines?: number
  maxNesting?: number
  /** Public (exported) functions need a docstring / leading comment. */
  publicDocs?: boolean
}

/** What a box does to the world beyond returning values. */
export type EffectKind = 'network' | 'filesystem' | 'database' | 'queue' | 'process' | 'env' | 'global-state'

/** How a contract item compares with the code that serves it. */
export interface ContractCheck {
  status: 'ok' | 'mismatch' | 'unverified'
  detail?: string
}

export interface ArchNode {
  id: string
  label: string
  kind: NodeKind
  parent?: string
  actorType?: ActorType
  tech?: string
  purpose: string
  /** Files owned by this node (derived for boxes; may be listed explicitly). */
  files: string[]
  /** Path prefixes owned by this box (from model.yaml). */
  paths?: string[]
  symbols: CodeSymbol[]
  tests?: string[]
  /** Per-box memory: invariants and conventions fed to agents when this box is in scope. */
  rules?: string[]
  /** HTTP routes (or other entry points) exposed by a box, or reached by an actor. */
  routes?: string[]
  /** Declared by the user in model.yaml (actors, manual boxes). */
  declared?: boolean
  /** Detected by the engine and not yet accepted by the user. */
  proposed?: boolean
  /** Why the engine proposed this node (shown in the curation step). */
  evidence?: string[]
  stats?: { files: number; lines: number; lang?: string }
  spec?: BoxSpec
  /** Side effects found in the code: kind and where (file:line, what). */
  effects?: { kind: EffectKind; at: string[] }[]
  /** Contract item name → how it compares with the code. */
  contractCheck?: Record<string, ContractCheck>
  /** Effective code style (project default + box override). */
  style?: CodeStyle
}

export type EdgeKind = 'uses' | 'http' | 'call' | 'sql' | 'event' | 'external'

export interface ArchEdge {
  id: string
  source: string
  target: string
  kind: EdgeKind
  label: string
  /** Endpoints, function signatures, message schemas crossing this edge. */
  contract: string[]
  /** Number of underlying file-level dependencies. */
  weight?: number
  declared?: boolean
  /** Designed but not (yet) present in code. */
  planned?: boolean
  /** Present in code but not designed (when the source box has a designed contract). */
  undeclared?: boolean
}

export interface Guardrail {
  id: string
  /** Box ids (or actor ids). A dependency from any descendant of `from` to any descendant of `to` is a violation. */
  from: string
  to: string
  reason?: string
}

export interface Violation {
  guardrail: string
  edge: string
  source: string
  target: string
}

export interface ArchModel {
  name: string
  nodes: ArchNode[]
  edges: ArchEdge[]
  guardrails?: Guardrail[]
  violations?: Violation[]
  journeys?: Journey[]
  drift?: DriftItem[]
  /** Project-wide code style. */
  style?: CodeStyle
}

export type ZoomLevel = 1 | 2 | 3

export const ZOOM_LABELS: Record<ZoomLevel, string> = {
  1: 'System',
  2: 'Service',
  3: 'Component'
}

// ── Design: the map as a spec ───────────────────────────────────────────────────────────

export type BoxStatus = 'planned' | 'building' | 'built' | 'verified'
export type Autonomy = 'ask' | 'tell' | 'auto'

export interface ContractItem {
  kind: 'http' | 'event' | 'function' | 'queue' | 'data'
  /** "POST /api/orders", "order.created", "issue(userId)", "table orders"… */
  name: string
  input?: string
  output?: string
  note?: string
}

export interface BoxSpec {
  /** One sentence: what this box is responsible for. */
  responsibility?: string
  /** What it must not do (keeps boxes isolated). */
  outOfScope?: string[]
  /** What this box offers to others: the only way in. */
  contract?: ContractItem[]
  /** Done means these hold (and the tests written for them pass). */
  acceptance?: string[]
  status?: BoxStatus
  /** How much the agent may do on its own for this box. */
  autonomy?: Autonomy
  decisions?: { date: string; text: string }[]
  /** Side effects this box may have. Once set, anything else the code does is drift. */
  sideEffects?: EffectKind[]
  /** Overrides the project's code style for this box. */
  style?: CodeStyle
}

/** A dependency the human designed (it may not exist in code yet). */
export interface DeclaredEdge {
  id: string
  from: string
  to: string
  kind: ArchEdge['kind']
  /** Contract items used across this edge (names from the target's contract). */
  uses: string[]
  note?: string
}

export interface JourneyStep {
  box: string
  action: string
}

/** An actor's path through the system: becomes an end-to-end acceptance test. */
export interface Journey {
  id: string
  actor: string
  name: string
  steps: JourneyStep[]
  /** The end-to-end test that plays this journey on the real code (repo-relative), once written. */
  test?: string
}

/** The last run of a journey's end-to-end test. */
export interface JourneyTestResult {
  id: string
  /** missing: no test yet. notrun: written, never run. blocked: Viber may not run its test runner. */
  status: 'pass' | 'fail' | 'missing' | 'notrun' | 'blocked' | 'writing'
  file?: string
  command?: string
  /** Failure lines from the test output. */
  failures?: string[]
  at?: number
}

export interface DriftItem {
  kind: 'undeclared-dependency' | 'missing-dependency' | 'missing-route' | 'undeclared-route' | 'out-of-scope' | 'contract-mismatch' | 'undeclared-effect' | 'style' | 'undeclared-event'
  source: string
  target?: string
  detail: string
}

export interface Question {
  id: string
  /** Box or edge the question is about. */
  anchor?: string
  sessionId?: string
  text: string
  options?: string[]
  answer?: string
  createdAt: number
  answeredAt?: number
  /** Turn the answer into a rule on the anchored box. */
  asRule?: boolean
}

/** Architectural Change Proposal: an agent asks to change a box's contract. */
export interface Acp {
  id: string
  /** Provider box whose contract changes. */
  box: string
  /** Box that needs the change (the requesting side), if any. */
  consumer?: string
  add: string[]
  remove: string[]
  reason: string
  sessionId?: string
  status: 'pending' | 'approved' | 'rejected'
  feedback?: string
  /** Other boxes that use this contract and may need updating. */
  consumers?: string[]
  followUps?: string[]
  createdAt: number
  decidedAt?: number
}
