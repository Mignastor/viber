import { useMemo } from 'react'
import { create } from 'zustand'
import type { Acp, ArchModel, Question, ZoomLevel } from '@shared/model'
import type { ActorInput, AgentKind, DefsOp, ScanProgress, SessionInfo, WorkspaceSnapshot } from '@shared/api'
import { sampleModel } from './model/sample'
import { scenario, TASK_PROMPT, type SimEvent } from './sim/scenario'
import { reduce, type CandidateResolution, type Decisions, type WarningResolution } from './sim/reducer'
import type { Layout } from './graph/layout'
import type { ReviewStatus } from './graph/view'

export type Selection = { kind: 'node' | 'edge'; id: string } | null
export type InspectorTab = 'details' | 'code' | 'review'
export type Mode = 'welcome' | 'demo' | 'workspace'
export type Modal =
  | { kind: 'actor'; actorId?: string; preset?: { reaches?: string[] } }
  | { kind: 'locate' }
  | { kind: 'palette' }
  | { kind: 'settings' }
  | { kind: 'guardrail' }
  | { kind: 'agents' }
  | { kind: 'newBox'; parent?: string }
  | { kind: 'edge'; from: string; to: string }
  | { kind: 'journey'; id?: string }
  | null

export interface BuildBoxState {
  id: string
  label: string
  wave: number
  state: 'waiting' | 'running' | 'built' | 'verified' | 'failed' | 'review'
  sessionId?: string
  note?: string
}

export interface BuildState {
  running: boolean
  waves: string[][]
  boxes: Record<string, BuildBoxState>
}

export interface RuntimeStats {
  boxes: Record<string, { count: number; errors: number; avgMs: number }>
  edges: Record<string, { count: number; errors: number; avgMs: number }>
  since: number
}

export interface HistoryState {
  commits: { sha: string; author: string; time: number; subject: string; boxes: string[]; files: number }[]
  boxes: Record<string, { commits: number; authors: string[]; lastTime: number; lastAuthor: string }>
  /** Window of commits shown as heat: [from, to) indexes into commits (newest first). */
  range: [number, number]
}

interface Store {
  mode: Mode
  /** A repo that is open but may not be scanned/initialised yet. */
  opened: { root: string; name: string; initialized: boolean } | null
  snapshot: WorkspaceSnapshot | null
  leftTab: 'session' | 'model' | 'design' | 'build'
  progress: ScanProgress | null
  busy: string | null
  error: string | null

  /** Session events: the scripted scenario in demo mode, live agent/watcher events otherwise. */
  liveEvents: SimEvent[]
  step: number
  /** Live mode: keep the step pinned to the latest event. */
  follow: boolean
  playing: boolean
  speed: 1 | 2 | 4
  zoom: ZoomLevel
  selection: Selection
  scope: string[]
  promptText: string
  decisions: Decisions
  reviews: Record<string, ReviewStatus>
  tab: InspectorTab
  codeFile: string | null
  layouts: Partial<Record<ZoomLevel, Layout>>
  committed: boolean
  fit: { n: number; nodeId?: string }
  /** Highlight everything one actor faces and reaches. */
  actorFocus: string | null
  /** Picking boxes on the map for a dialog (e.g. which boxes an actor reaches). */
  picking: { purpose: 'actorReaches'; picked: string[] } | null
  modal: Modal
  /** Actor being edited; survives while the dialog is hidden for picking boxes on the map. */
  actorDraft: ActorInput | null
  /** Boxes to make glow (search results, bug → box hits). */
  highlight: string[]
  setHighlight: (ids: string[]) => void

  sessions: SessionInfo[]
  activeSession: string
  agent: AgentKind
  isolate: boolean
  runtime: RuntimeStats | null
  thumbs: Record<string, string>
  history: HistoryState | null
  /** Explain mode: an ordered walk through boxes, with the current index. */
  explain: {
    actor: string
    path: string[]
    i: number
    title?: string
    actions?: string[]
    /** Dry run: what crosses each step (aligned with path; index 0 is the actor). */
    dry?: ({ message?: string; payload?: string; effect?: string; problem?: string } | null)[]
    gaps?: string[]
    /** A scenario that is not a saved journey yet. */
    scenario?: { actor: string; name: string; steps: { box: string; action: string }[] }
  } | null
  /** The architect conversation (see architectChat.ts). */
  archTurns: import('./architectChat').ArchTurn[]
  archBusy: boolean
  archError: string | null
  /** What the prompt bar does: change the design (architect) or the code (an agent). */
  promptMode: 'design' | 'code'
  bottom: 'terminal' | 'run' | null
  setActiveSession: (id: string) => Promise<void>

  /** Design tools on the canvas. */
  designTool: 'box' | 'connect' | null
  connectFrom: string | null
  /** A diagram diff being previewed (from the architect), with the ops that produce it. */
  preview: { model: ArchModel; ops: DefsOp[] } | null
  questions: Question[]
  acps: Acp[]
  build: BuildState | null

  enterDemo: () => void
  leaveToWelcome: () => void
  setSnapshot: (s: WorkspaceSnapshot) => void
  setProgress: (p: ScanProgress | null) => void
  setBusy: (b: string | null) => void
  setError: (e: string | null) => void
  pushLive: (e: SimEvent) => void
  clearLive: () => void

  run: () => void
  togglePlay: () => void
  stepForward: () => void
  advance: () => void
  seek: (step: number) => void
  reset: () => void
  setSpeed: (s: 1 | 2 | 4) => void
  setZoom: (z: ZoomLevel, focus?: string) => void
  select: (sel: Selection, additive?: boolean) => void
  toggleScope: (id: string) => void
  setScope: (ids: string[]) => void
  setPromptText: (t: string) => void
  approvePlan: () => void
  rejectPlan: (feedback?: string) => void
  resolveWarning: (eventId: string, r: WarningResolution) => void
  resolveCandidate: (eventId: string, r: CandidateResolution) => void
  setReview: (nodeIds: string[], r: ReviewStatus | null) => void
  setTab: (t: InspectorTab) => void
  openCode: (nodeId: string, file?: string) => void
  setLayout: (z: ZoomLevel, l: Layout) => void
  moveNode: (z: ZoomLevel, id: string, x: number, y: number) => void
  commit: () => void
  setActorFocus: (id: string | null) => void
  startPicking: (picked: string[]) => void
  togglePicked: (id: string) => void
  stopPicking: () => void
  setModal: (m: Modal) => void
}

const freshDecisions = (): Decisions => ({ planApproved: false, warnings: {}, candidates: {} })

const sessionReset = {
  step: 0,
  playing: false,
  decisions: freshDecisions(),
  reviews: {},
  committed: false,
  tab: 'details' as InspectorTab,
  codeFile: null,
  liveEvents: [] as SimEvent[],
  follow: true
}

export const useStore = create<Store>((set, get) => ({
  mode: 'welcome',
  opened: null,
  snapshot: null,
  leftTab: 'session',
  progress: null,
  busy: null,
  error: null,
  liveEvents: [],
  step: 0,
  follow: true,
  playing: false,
  speed: 1,
  zoom: 2,
  selection: null,
  scope: [],
  promptText: '',
  decisions: freshDecisions(),
  reviews: {},
  tab: 'details',
  codeFile: null,
  layouts: {},
  committed: false,
  fit: { n: 0 },
  actorFocus: null,
  picking: null,
  modal: null,
  actorDraft: null,
  highlight: [],
  setHighlight: (highlight) => set({ highlight }),

  sessions: [],
  activeSession: 'watch',
  agent: 'claude-code',
  isolate: false,
  runtime: null,
  thumbs: {},
  history: null,
  explain: null,
  archTurns: [],
  archBusy: false,
  archError: null,
  promptMode: 'design',
  bottom: null,
  designTool: null,
  connectFrom: null,
  preview: null,
  questions: [],
  acps: [],
  build: null,
  setActiveSession: async (id) => {
    const events = await window.viber.invoke<SimEvent[]>('session:events', id).catch(() => [] as SimEvent[])
    void window.viber.invoke('session:setActive', id)
    set({ ...sessionReset, activeSession: id, liveEvents: events, step: events.length, follow: true })
  },

  enterDemo: () =>
    set({
      ...sessionReset,
      mode: 'demo',
      snapshot: null,
      selection: { kind: 'node', id: 'auth' },
      scope: ['auth'],
      promptText: TASK_PROMPT,
      layouts: {},
      zoom: 2,
      actorFocus: null,
      fit: { n: get().fit.n + 1 }
    }),
  leaveToWelcome: () => set({ ...sessionReset, archTurns: [], archError: null, mode: 'welcome', opened: null, sessions: [], activeSession: 'watch', runtime: null, thumbs: {}, history: null, explain: null, bottom: null, snapshot: null, selection: null, scope: [], layouts: {}, actorFocus: null, progress: null, busy: null }),
  setSnapshot: (snapshot) => {
    const first = get().mode !== 'workspace' || get().snapshot?.root !== snapshot.root
    const pinned = snapshot.layout ?? {}
    set({
      snapshot,
      mode: 'workspace',
      ...(snapshot.draft ? { leftTab: 'model' as const } : {}),
      ...(first
        ? {
            ...sessionReset,
            selection: null,
            scope: [],
            promptText: '',
            zoom: 2 as ZoomLevel,
            actorFocus: null,
            layouts: Object.fromEntries(Object.entries(pinned).map(([k, v]) => [Number(k), v])) as Store['layouts'],
            fit: { n: get().fit.n + 1 }
          }
        : {})
    })
  },
  setProgress: (progress) => set({ progress }),
  setBusy: (busy) => set({ busy }),
  setError: (error) => set({ error }),
  pushLive: (e) =>
    set((s) => {
      const liveEvents = [...s.liveEvents, e]
      return { liveEvents, step: s.follow ? liveEvents.length : s.step }
    }),
  clearLive: () => set({ ...sessionReset }),

  run: () => {
    if (get().mode === 'demo') set({ step: 1, playing: true, decisions: freshDecisions(), reviews: {}, committed: false })
  },
  togglePlay: () => {
    const { step, playing, mode } = get()
    if (mode !== 'demo') return
    if (step === 0) return get().run()
    if (step >= scenario.length) return
    set({ playing: !playing })
  },
  stepForward: () => {
    get().advance()
    set({ playing: false })
  },
  advance: () => {
    const { step } = get()
    const total = eventsTotal()
    if (step >= total) return set({ playing: false })
    const next = step + 1
    set({ step: next, playing: next < total && get().playing, ...(get().mode === 'demo' && next === total ? { tab: 'review' as const } : {}) })
  },
  seek: (step) => {
    const total = eventsTotal()
    const s = Math.max(0, Math.min(total, step))
    set({ step: s, playing: false, follow: s >= total })
  },
  reset: () =>
    set({
      ...sessionReset,
      layouts: get().mode === 'demo' ? {} : get().layouts,
      fit: { n: get().fit.n + 1 }
    }),
  setSpeed: (speed) => set({ speed }),
  setZoom: (zoom, focus) => set({ zoom, fit: { n: get().fit.n + 1, nodeId: focus } }),
  select: (selection, additive) => {
    const { designTool, connectFrom } = get()
    if (designTool === 'connect' && selection?.kind === 'node') {
      if (!connectFrom) return set({ connectFrom: selection.id, selection })
      if (connectFrom !== selection.id) set({ modal: { kind: 'edge', from: connectFrom, to: selection.id }, connectFrom: null, designTool: null })
      return
    }
    const picking = get().picking
    if (picking && selection?.kind === 'node') return get().togglePicked(selection.id)
    if (additive && selection?.kind === 'node') return get().toggleScope(selection.id)
    set({ selection, ...(selection?.kind === 'node' && get().step === 0 ? { scope: [selection.id] } : {}) })
    if (get().tab === 'code' && selection?.kind !== 'node') set({ tab: 'details' })
  },
  toggleScope: (id) => {
    const scope = get().scope
    set({ scope: scope.includes(id) ? scope.filter((s) => s !== id) : [...scope, id], selection: { kind: 'node', id } })
  },
  setScope: (scope) => set({ scope }),
  setPromptText: (promptText) => set({ promptText }),
  approvePlan: () => {
    if (get().mode === 'workspace') void window.viber.invoke('session:decide', get().activeSession, true)
    set((s) => ({ decisions: { ...s.decisions, planApproved: true }, playing: s.mode === 'demo' }))
  },
  rejectPlan: (feedback) => {
    if (get().mode !== 'workspace') return get().reset()
    void window.viber.invoke('session:decide', get().activeSession, false, feedback ?? '')
  },
  resolveWarning: (eventId, r) => {
    const st = get()
    if (st.mode === 'workspace' && r === 'revert') {
      const ev = st.liveEvents.find((e) => e.id === eventId)
      if (ev?.t === 'edit') void window.viber.invoke('session:revert', [ev.file], st.activeSession)
    }
    set((s) => ({ decisions: { ...s.decisions, warnings: { ...s.decisions.warnings, [eventId]: r } } }))
  },
  resolveCandidate: (eventId, r) => {
    const st = get()
    if (st.mode === 'workspace') {
      const ev = st.liveEvents.find((e) => e.id === eventId)
      const c = ev?.t === 'edit' ? ev.classify : undefined
      if (c && r === 'create') void window.viber.invoke('ws:apply', { op: 'addBox', id: c.node.id, label: c.node.label, paths: c.node.paths ?? [c.node.id] })
      if (c && r === 'attach' && c.attachTo) void window.viber.invoke('ws:apply', { op: 'addPaths', id: c.attachTo, paths: c.node.paths ?? [c.node.id] })
    }
    set((s) => ({ decisions: { ...s.decisions, candidates: { ...s.decisions.candidates, [eventId]: r } } }))
  },
  setReview: (ids, r) =>
    set((s) => {
      const reviews = { ...s.reviews }
      for (const id of ids) {
        if (r) reviews[id] = r
        else delete reviews[id]
      }
      return { reviews }
    }),
  setTab: (tab) => set({ tab }),
  openCode: (nodeId, file) => set({ selection: { kind: 'node', id: nodeId }, tab: 'code', codeFile: file ?? null }),
  setLayout: (z, l) => {
    set((s) => ({ layouts: { ...s.layouts, [z]: l } }))
    persistLayout(z, l)
  },
  moveNode: (z, id, x, y) => {
    const l = get().layouts[z]
    if (!l?.[id]) return
    const next = { ...l, [id]: { ...l[id], x, y } }
    set((s) => ({ layouts: { ...s.layouts, [z]: next } }))
    persistLayout(z, next)
  },
  commit: () => set({ committed: true }),
  setActorFocus: (actorFocus) => set({ actorFocus }),
  startPicking: (picked) => set({ picking: { purpose: 'actorReaches', picked } }),
  togglePicked: (id) =>
    set((s) => (s.picking ? { picking: { ...s.picking, picked: s.picking.picked.includes(id) ? s.picking.picked.filter((x) => x !== id) : [...s.picking.picked, id] } } : {})),
  stopPicking: () => set({ picking: null }),
  setModal: (modal) => set({ modal })
}))

function eventsTotal(): number {
  const s = useStore.getState()
  return s.mode === 'demo' ? scenario.length : s.liveEvents.length
}

// Pinned positions live in the repo (.arch/layout.json); debounce writes while dragging.
let layoutTimer: ReturnType<typeof setTimeout> | null = null
function persistLayout(z: ZoomLevel, l: Layout): void {
  if (useStore.getState().mode !== 'workspace') return
  if (layoutTimer) clearTimeout(layoutTimer)
  layoutTimer = setTimeout(() => void window.viber.invoke('ws:layout', String(z), l).catch(() => {}), 600)
}

// Exposed for the visual test harness (scripts/snap.cjs, VIBER_SNAP) and debugging.
;(window as unknown as { __store: unknown }).__store = useStore

const EMPTY: ArchModel = { name: '', nodes: [], edges: [] }

/** The architecture model on screen: the sample in demo mode, the open repo otherwise. */
export function useModel(): ArchModel {
  const mode = useStore((s) => s.mode)
  const snapshot = useStore((s) => s.snapshot)
  const preview = useStore((s) => s.preview)
  return mode === 'demo' ? sampleModel : (preview?.model ?? snapshot?.model ?? EMPTY)
}

/** All session events (demo script or live), for the feed. */
export function useEvents(): SimEvent[] {
  const mode = useStore((s) => s.mode)
  const live = useStore((s) => s.liveEvents)
  return mode === 'demo' ? scenario : live
}

/** The session state derived from the events played so far. */
export function useSim() {
  const model = useModel()
  const events = useEvents()
  const step = useStore((s) => s.step)
  const decisions = useStore((s) => s.decisions)
  return useMemo(() => reduce(model, events.slice(0, step), decisions), [model, events, step, decisions])
}
