import type { ActorType, ArchModel, BoxSpec, CodeStyle, DeclaredEdge, Guardrail, Journey } from './model'

// Typed contract between the renderer and the main process.

export interface ScanProgress {
  phase: string
  done: number
  total: number
}

export interface ActorInput {
  id?: string
  label: string
  type: ActorType
  description?: string
  reaches?: string[]
  routes?: string[]
}

export type DefsOp =
  | { op: 'rename'; id: string; label: string }
  | { op: 'setPurpose'; id: string; purpose: string }
  | { op: 'setRules'; id: string; rules: string[] }
  | { op: 'setTech'; id: string; tech: string }
  | { op: 'mergeInto'; id: string; target: string }
  | { op: 'setParent'; id: string; parent: string | null }
  | { op: 'remove'; id: string }
  | { op: 'accept'; id: string }
  | { op: 'acceptAll' }
  | { op: 'addBox'; label: string; paths: string[]; parent?: string; id?: string; tech?: string; spec?: BoxSpec }
  | { op: 'setSpec'; id: string; spec: BoxSpec }
  | { op: 'setStyle'; style: CodeStyle }
  | { op: 'setTech'; id: string; tech: string }
  | { op: 'upsertEdge'; edge: DeclaredEdge }
  | { op: 'removeEdge'; id: string }
  | { op: 'upsertJourney'; journey: Journey }
  | { op: 'removeJourney'; id: string }
  | { op: 'batch'; ops: DefsOp[] }
  | { op: 'addPaths'; id: string; paths: string[] }
  | { op: 'upsertActor'; actor: ActorInput }
  | { op: 'upsertService'; service: { id?: string; label: string; kind: 'external' | 'datastore'; tech?: string; purpose?: string; match?: string[] } }
  | { op: 'upsertGuardrail'; guardrail: Guardrail }
  | { op: 'removeGuardrail'; id: string }

export interface WorkspaceSnapshot {
  root: string
  name: string
  /** model.yaml exists (initialised and saved at least once). */
  initialized: boolean
  /** Showing an unsaved draft (right after Initialize). */
  draft: boolean
  model: ArchModel
  layout: Record<string, Record<string, { x: number; y: number; w: number; h: number }>>
  unmapped: string[]
  stats: { files: number; languages: Record<string, number>; ms: number }
  git: GitInfo | null
}

export interface GitInfo {
  branch: string
  dirty: number
  ahead?: number
  remote?: string
}

export interface RecentWorkspace {
  root: string
  name: string
  openedAt: number
}

export interface SearchHit {
  kind: 'box' | 'symbol' | 'file' | 'route' | 'text'
  nodeId: string | null
  title: string
  detail?: string
  file?: string
  line?: number
  score: number
}

export interface LocateResult {
  hits: { nodeId: string; file: string; line?: number; symbol?: string; reason: string; score: number }[]
  summary: string
}

export type AgentKind = 'claude-code' | 'codex' | 'gemini' | 'builtin' | 'external'

export interface SessionInfo {
  id: string
  title: string
  agent: AgentKind
  status: 'running' | 'waiting' | 'done' | 'stopped' | 'error' | 'watching'
  /** Working directory: the repo root, or a git worktree for isolated parallel sessions. */
  cwd: string
  worktree?: { dir: string; branch: string }
  scope: string[]
  color: string
  startedAt: number
  tokens: { input: number; output: number; cacheRead: number; costUsd?: number }
  model?: string
  ambient?: boolean
}

export interface StartSessionInput {
  prompt: string
  scope: string[]
  agent: AgentKind
  isolate?: boolean
  model?: string
  /** Approve plans automatically (benchmarks, unattended runs). */
  autoApprove?: boolean
  /** Benchmark baseline: the agent alone, without Viber's map, tools or context pack. */
  baseline?: boolean
}
