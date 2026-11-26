import type { ArchEdge, ArchNode } from './model'

// Session events: what happened during an agent session, in order. The renderer derives all
// session state (highlights, fence, plan, tests, review) from this list with a pure reducer.
// In the demo they are scripted; live they come from the watcher, the MCP server and runners.

export interface ContextItem {
  label: string
  detail: string
  tokens: number
}

export interface ContractChange {
  added: string[]
  removed: string[]
}

export interface Classification {
  node: ArchNode
  edges: ArchEdge[]
  /** Existing box the file could be attached to instead of creating a new one. */
  attachTo: string
  reason: string
}

interface Base {
  id: string
  /** Playback duration before the next event, at 1× speed. */
  ms: number
  /** Tokens this step costs with Viber. */
  tokens: number
  /** Estimated tokens the same step costs an agent exploring on its own. */
  naive: number
}

export type SimEvent = Base &
  (
    | { t: 'task'; prompt: string; scope: string[] }
    | { t: 'context'; items: ContextItem[]; naiveNote: string }
    | { t: 'intent'; agent: string; nodes: string[]; summary: string }
    | {
        t: 'plan'
        steps: string[]
        addNodes: ArchNode[]
        addEdges: ArchEdge[]
        edgeChanges: Record<string, ContractChange>
        fence: string[]
      }
    | { t: 'approval' }
    | {
        t: 'edit'
        file: string
        /** Demo: which hand-written version of the file. Live: 'disk'. */
        version: string
        note: string
        edges?: string[]
        classify?: Classification
        /** Live mode: diff counts computed by the main process against the session checkpoint. */
        added?: number
        removed?: number
        created?: boolean
        deleted?: boolean
      }
    | { t: 'contracts'; changes: Record<string, ContractChange>; newEdges: ArchEdge[] }
    | { t: 'runtime'; boxes: string[]; text: string; level: 'error' | 'info' }
    | { t: 'message'; role: 'agent' | 'system' | 'user'; text: string }
    | { t: 'tool'; name: string; detail: string }
    | { t: 'error'; text: string }
    | {
        t: 'tests'
        selected: number
        total: number
        results: Record<string, { passed: number; failed: number }>
        failures: string[]
      }
    | { t: 'done'; summary: string }
  )


type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

/** An event as produced by the main process, before it gets an id and a playback duration. */
export type EventInput = DistributiveOmit<SimEvent, 'id' | 'ms'> & { id?: string; ms?: number }
