import { useEffect, useState } from 'react'
import { FolderOpen, History, Play, Plug, Sparkles } from 'lucide-react'
import type { RecentWorkspace } from '@shared/api'
import { useStore } from '../store'
import { ThemeToggle } from './ThemeToggle'

export function Welcome() {
  const [recent, setRecent] = useState<RecentWorkspace[]>([])
  const error = useStore((s) => s.error)
  const { enterDemo, setError } = useStore.getState()

  useEffect(() => {
    window.viber.invoke<RecentWorkspace[]>('app:recent').then(setRecent).catch(() => {})
  }, [])

  const open = async (root?: string): Promise<void> => {
    setError(null)
    try {
      if (root) await window.viber.invoke('app:openPath', root)
      else await window.viber.invoke('app:openFolder')
    } catch (e) {
      setError(String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    }
  }

  return (
    <div className="welcome">
      <ThemeToggle className="welcome-theme" />
      <div className="welcome-card">
        <div className="welcome-brand">
          <span className="logo">◆</span> Viber
        </div>
        <p className="welcome-tag">See your codebase as a living architecture map. Point at it, prompt, review by box.</p>

        <div className="welcome-actions">
          <button className="btn primary big" onClick={() => open()}>
            <FolderOpen size={16} /> Open folder…
          </button>
          <button className="btn big" onClick={enterDemo}>
            <Play size={16} /> Try the demo session
          </button>
          <button className="btn big" onClick={() => useStore.getState().setModal({ kind: 'agents' })}>
            <Plug size={16} /> Connect agents
          </button>
        </div>
        {error && <p className="welcome-error">{error}</p>}

        {recent.length > 0 && (
          <div className="recent">
            <h3>
              <History size={13} /> Recent
            </h3>
            {recent.map((r) => (
              <button key={r.root} className="recent-item" onClick={() => open(r.root)}>
                <strong>{r.name}</strong>
                <span className="mono muted">{r.root}</span>
              </button>
            ))}
          </div>
        )}

        <div className="welcome-how">
          <Sparkles size={14} />
          <div>
            Open any repository. Viber reads the code (nothing leaves your machine), proposes boxes, actors and
            external services, and lets you curate them. The result is saved to <code>.arch/model.yaml</code> in the repo.
          </div>
        </div>
      </div>
    </div>
  )
}
