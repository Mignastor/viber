import { Splitter, useSavedPanelWidths } from './components/Splitter'
import type { AgentKind } from '@shared/api'
import { useEffect } from 'react'
import { ReactFlowProvider } from '@xyflow/react'
import { Loader2, Map as MapIcon, ScanSearch } from 'lucide-react'
import type { ScanProgress, SessionInfo, WorkspaceSnapshot } from '@shared/api'
import type { SimEvent } from '@shared/events'
import { bumpFiles } from './files'
import { BottomPanel } from './components/BottomPanel'
import type { BuildState, RuntimeStats } from './store'
import type { Acp, JourneyTestResult, Question } from '@shared/model'
import { DesignPanel } from './components/DesignPanel'
import { BuildPanel } from './components/BuildPanel'
import { TopBar } from './components/TopBar'
import { SessionPanel } from './components/SessionPanel'
import { ModelPanel } from './components/ModelPanel'
import { Canvas } from './components/Canvas'
import { Inspector } from './components/Inspector'
import { Welcome } from './components/Welcome'
import { Modals, PickingBanner } from './components/Modals'
import { useStore } from './store'
import { scenario } from './sim/scenario'
import { isBlocked } from './sim/reducer'

/** Advances the simulated demo session while playing; waits at gates that need the user. */
function usePlayer(): void {
  const step = useStore((s) => s.step)
  const playing = useStore((s) => s.playing)
  const speed = useStore((s) => s.speed)
  const decisions = useStore((s) => s.decisions)
  const mode = useStore((s) => s.mode)

  useEffect(() => {
    if (mode !== 'demo' || !playing || step === 0 || step >= scenario.length) return
    if (isBlocked(scenario, step, decisions)) return
    const ms = scenario[step - 1].ms / speed
    const t = setTimeout(() => useStore.getState().advance(), ms)
    return () => clearTimeout(t)
  }, [step, playing, speed, decisions, mode])
}

/** Main-process events → store. */
function useMainEvents(): void {
  useEffect(() => {
    const st = useStore.getState
    const offs = [
      window.viber.on('ws:opened', (info: { root: string; name: string; initialized: boolean }) => {
        useStore.setState({ opened: info, mode: 'workspace', snapshot: null, sessions: [], activeSession: 'watch', liveEvents: [], step: 0, busy: info.initialized ? 'Scanning…' : null, error: null })
      }),
      window.viber.on('ws:model', (snap: WorkspaceSnapshot) => {
        const first = !st().snapshot
        st().setSnapshot(snap)
        if (first) {
          void window.viber.invoke<Question[]>('questions:list').then((questions) => useStore.setState({ questions }))
          void window.viber.invoke<Acp[]>('acp:list').then((acps) => useStore.setState({ acps }))
        }
        useStore.setState({ progress: null, busy: null })
        // Journeys or their test files may have changed with the model.
        void window.viber.invoke<Record<string, JourneyTestResult>>('journeys:results').then((journeyResults) => useStore.setState({ journeyResults })).catch(() => {})
      }),
      window.viber.on('journeys:results', (journeyResults: Record<string, JourneyTestResult>) => useStore.setState({ journeyResults })),
      window.viber.on('ws:progress', (p: ScanProgress) => st().setProgress(p)),
      window.viber.on('session:list', (list: SessionInfo[]) => useStore.setState({ sessions: list })),
      window.viber.on('session:event', ({ sessionId, event }: { sessionId: string; event: SimEvent }) => {
        if (event.t === 'edit') bumpFiles()
        if (sessionId === st().activeSession) st().pushLive(event)
        // A new agent session takes focus when it starts talking.
        else if (event.t === 'task') void st().setActiveSession(sessionId)
      }),
      window.viber.on('runtime:stats', (r: RuntimeStats) => useStore.setState({ runtime: r })),
      window.viber.on('questions:list', (questions: Question[]) => useStore.setState({ questions })),
      window.viber.on('acp:list', (acps: Acp[]) => useStore.setState({ acps })),
      window.viber.on('build:state', (build: BuildState) => useStore.setState({ build })),
      window.viber.on('preview:thumbs', (thumbs: Record<string, string>) => useStore.setState({ thumbs })),
      window.viber.on('preview:picked', (p: { box: string | null; file?: string; component: string | null }) => {
        if (p.box) {
          st().openCode(p.box, p.file)
          st().setHighlight([p.box])
        }
      })
    ]
    return () => offs.forEach((off) => off())
  }, [])
}

function useDefaults(): void {
  useEffect(() => {
    window.viber
      .invoke<{ settings: { agent: AgentKind } }>('settings:get')
      .then((r) => useStore.setState({ agent: r.settings.agent }))
      .catch(() => {})
  }, [])
}

function useShortcuts(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const mod = e.ctrlKey || e.metaKey
      const st = useStore.getState()
      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        st.setModal(st.modal?.kind === 'palette' ? null : { kind: 'palette' })
      } else if (mod && e.shiftKey && e.key.toLowerCase() === 'b' && st.mode === 'workspace') {
        e.preventDefault()
        st.setModal({ kind: 'locate' })
      } else if (e.key === 'Escape' && !st.modal) {
        if (st.picking) st.stopPicking()
        else if (st.actorFocus || st.highlight.length) (st.setActorFocus(null), st.setHighlight([]))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}

function InitPanel() {
  const opened = useStore((s) => s.opened)
  const busy = useStore((s) => s.busy)
  const progress = useStore((s) => s.progress)
  const error = useStore((s) => s.error)
  if (!opened) return null
  const init = async (): Promise<void> => {
    useStore.setState({ busy: 'Scanning…', error: null })
    try {
      await window.viber.invoke('ws:initialize')
    } catch (e) {
      useStore.setState({ busy: null, error: String((e as Error).message ?? e) })
    }
  }
  return (
    <div className="init-panel">
      <div className="init-card">
        <MapIcon size={28} className="accent" />
        <h2>{opened.name}</h2>
        {busy ? (
          <>
            <p className="muted">
              <Loader2 size={14} className="spin" /> {progress?.phase ?? busy}
              {progress && progress.total > 0 ? ` · ${progress.done}/${progress.total}` : ''}
            </p>
            {progress && progress.total > 0 && (
              <div className="progress">
                <div style={{ width: `${(100 * progress.done) / progress.total}%` }} />
              </div>
            )}
          </>
        ) : (
          <>
            <p className="muted">This repository has no architecture map yet.</p>
            <button className="btn primary big" onClick={init}>
              <ScanSearch size={16} /> Initialize
            </button>
            <ul className="init-steps">
              <li>Parses the code locally and finds modules, imports, routes and entry points</li>
              <li>Proposes boxes, actors (who uses the system) and external services</li>
              <li>You curate the draft, then it is saved to .arch/model.yaml</li>
            </ul>
          </>
        )}
        {error && <p className="welcome-error">{error}</p>}
      </div>
    </div>
  )
}

function LeftPanel() {
  const mode = useStore((s) => s.mode)
  const tab = useStore((s) => s.leftTab)
  const openQuestions = useStore((s) => s.questions.filter((q) => !q.answer).length + s.acps.filter((a) => a.status === 'pending').length)
  const building = useStore((s) => s.build?.running)
  if (mode !== 'workspace') return <SessionPanel />
  const tabBtn = (id: typeof tab, label: string, badge?: number | string) => (
    <button className={tab === id ? 'on' : ''} onClick={() => useStore.setState({ leftTab: id })}>
      {label}
      {badge ? <span className="count">{badge}</span> : null}
    </button>
  )
  return (
    <aside className="left">
      <div className="panel-head tabs">
        {tabBtn('session', 'Session')}
        {tabBtn('design', 'Design', openQuestions || undefined)}
        {tabBtn('build', 'Build', building ? '…' : undefined)}
        {tabBtn('model', 'Model')}
      </div>
      {tab === 'session' && <SessionPanel embedded />}
      {tab === 'design' && <DesignPanel />}
      {tab === 'build' && <BuildPanel />}
      {tab === 'model' && <ModelPanel />}
    </aside>
  )
}

export function App() {
  usePlayer()
  useSavedPanelWidths()
  useMainEvents()
  useShortcuts()
  useDefaults()
  const mode = useStore((s) => s.mode)
  const snapshot = useStore((s) => s.snapshot)
  const busy = useStore((s) => s.busy)
  const progress = useStore((s) => s.progress)

  if (mode === 'welcome')
    return (
      <>
        <Welcome />
        <Modals />
      </>
    )

  return (
    <ReactFlowProvider>
      <div className="app">
        <TopBar />
        <div className="main">
          {mode === 'workspace' && !snapshot ? (
            <InitPanel />
          ) : (
            <>
              <LeftPanel />
              <Splitter side="left" />
              <div className="center">
                <div className="center-main">
                  <Canvas />
                </div>
                <BottomPanel />
                <PickingBanner />
                {busy && snapshot && (
                  <div className="busy-chip">
                    <Loader2 size={13} className="spin" /> {progress?.phase ?? busy}
                    {progress && progress.total > 0 ? ` ${progress.done}/${progress.total}` : ''}
                  </div>
                )}
              </div>
              <Splitter side="right" />
              <Inspector />
            </>
          )}
        </div>
      </div>
      <Modals />
    </ReactFlowProvider>
  )
}
