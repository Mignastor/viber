import { useEffect, useRef, useState } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { Eye, Image, Play, RotateCcw, Square, TerminalSquare, X } from 'lucide-react'
import { useStore } from '../store'
import { cssVar, useTheme } from '../theme'

const termTheme = () => ({
  background: cssVar('--term-bg'),
  foreground: cssVar('--text'),
  cursor: cssVar('--accent'),
  selectionBackground: cssVar('--border-2')
})

// Bottom panel: a real terminal (run any agent CLI here) and the app's run configurations.

interface RunConfig {
  id: string
  label: string
  command: string
  cwd: string
  kind: 'dev' | 'test' | 'build' | 'other'
}

export function BottomPanel() {
  const bottom = useStore((s) => s.bottom)
  const mode = useStore((s) => s.mode)
  if (mode !== 'workspace' || !bottom) return null
  return (
    <div className="bottom-panel">
      <div className="panel-head tabs">
        <button className={bottom === 'terminal' ? 'on' : ''} onClick={() => useStore.setState({ bottom: 'terminal' })}>
          <TerminalSquare size={13} /> Terminal
        </button>
        <button className={bottom === 'run' ? 'on' : ''} onClick={() => useStore.setState({ bottom: 'run' })}>
          <Play size={13} /> Run
        </button>
        <span className="spacer" />
        <button className="icon-btn" onClick={() => useStore.setState({ bottom: null })} aria-label="Close panel">
          <X size={13} />
        </button>
      </div>
      <div className="bottom-body">
        <div style={{ display: bottom === 'terminal' ? 'flex' : 'none' }} className="fill">
          <TerminalView />
        </div>
        <div style={{ display: bottom === 'run' ? 'flex' : 'none' }} className="fill">
          <RunView />
        </div>
      </div>
    </div>
  )
}

function TerminalView() {
  const host = useRef<HTMLDivElement>(null)
  const xterm = useRef<XTerm | null>(null)
  const theme = useTheme()
  useEffect(() => {
    if (xterm.current) xterm.current.options.theme = termTheme()
  }, [theme])
  useEffect(() => {
    if (!host.current) return
    const id = 'term-' + Math.random().toString(36).slice(2, 7)
    const term = new XTerm({
      fontFamily: "'JetBrains Mono', 'Cascadia Code', Consolas, monospace",
      fontSize: 12.5,
      theme: termTheme(),
      cursorBlink: true
    })
    xterm.current = term
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host.current)
    fit.fit()
    const offData = window.viber.on('term:data', (m: { id: string; data: string }) => m.id === id && term.write(m.data))
    const offExit = window.viber.on('term:exit', (m: { id: string }) => m.id === id && term.write('\r\n[process exited]\r\n'))
    void window.viber.invoke('term:create', id, term.cols, term.rows).catch((e) => term.write(`Could not start a terminal: ${String(e)}\r\n`))
    const sub = term.onData((d) => void window.viber.invoke('term:write', id, d))
    const ro = new ResizeObserver(() => {
      try {
        fit.fit()
        void window.viber.invoke('term:resize', id, term.cols, term.rows)
      } catch {
        /* hidden */
      }
    })
    ro.observe(host.current)
    return () => {
      ro.disconnect()
      sub.dispose()
      offData()
      offExit()
      void window.viber.invoke('term:kill', id)
      term.dispose()
    }
  }, [])
  return <div className="term-host" ref={host} />
}

function RunView() {
  const [configs, setConfigs] = useState<RunConfig[]>([])
  const [running, setRunning] = useState<Record<string, boolean>>({})
  const [selected, setSelected] = useState<string | null>(null)
  const [logs, setLogs] = useState<Record<string, string[]>>({})
  const [urls, setUrls] = useState<Record<string, string>>({})
  const runtime = useStore((s) => s.runtime)
  const logRef = useRef<HTMLPreElement>(null)

  useEffect(() => {
    window.viber.invoke<RunConfig[]>('run:configs').then((c) => {
      setConfigs(c)
      setSelected((s) => s ?? c[0]?.id ?? null)
    })
    const offs = [
      window.viber.on('run:output', (m: { id: string; line: string }) =>
        setLogs((l) => ({ ...l, [m.id]: [...(l[m.id] ?? []).slice(-1500), m.line] }))
      ),
      window.viber.on('run:status', (m: { id: string; running: boolean; code?: number }) => {
        setRunning((r) => ({ ...r, [m.id]: m.running }))
        if (!m.running) setLogs((l) => ({ ...l, [m.id]: [...(l[m.id] ?? []), `── exited${m.code !== undefined ? ` (${m.code})` : ''}`] }))
      }),
      window.viber.on('run:url', (m: { id: string; url: string }) => setUrls((u) => ({ ...u, [m.id]: m.url })))
    ]
    return () => offs.forEach((o) => o())
  }, [])

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight })
  }, [logs, selected])

  const cfg = configs.find((c) => c.id === selected)
  const url = selected ? urls[selected] : undefined
  const totalHits = runtime ? Object.values(runtime.boxes).reduce((a, b) => a + b.count, 0) : 0

  return (
    <div className="run-view">
      <div className="run-list">
        {configs.map((c) => (
          <div key={c.id} className={`run-item ${selected === c.id ? 'on' : ''}`} onClick={() => setSelected(c.id)}>
            <i className={`run-dot ${running[c.id] ? 'live' : ''}`} />
            <span>{c.label}</span>
            {running[c.id] ? (
              <button className="icon-btn tiny" onClick={(e) => (e.stopPropagation(), void window.viber.invoke('run:stop', c.id))} title="Stop">
                <Square size={11} />
              </button>
            ) : (
              <button className="icon-btn tiny" onClick={(e) => (e.stopPropagation(), setSelected(c.id), void window.viber.invoke('run:start', c))} title="Run">
                <Play size={11} />
              </button>
            )}
          </div>
        ))}
        {configs.length === 0 && <p className="muted small pad">No run scripts found (package.json, pyproject, go.mod, Cargo.toml, compose).</p>}
        <div className="run-runtime">
          <span className="muted small">
            Runtime: {totalHits} request{totalHits === 1 ? '' : 's'} seen
          </span>
          <button className="icon-btn tiny" title="Reset runtime counters" onClick={() => void window.viber.invoke('runtime:reset')}>
            <RotateCcw size={11} />
          </button>
        </div>
      </div>
      <div className="run-output">
        <div className="run-toolbar">
          <span className="mono muted">{cfg ? `${cfg.cwd ? cfg.cwd + ' $ ' : '$ '}${cfg.command}` : ''}</span>
          <span className="spacer" />
          {url && (
            <>
              <span className="mono small">{url}</span>
              <button className="btn small" onClick={() => void window.viber.invoke('preview:thumbs', url)} title="Screenshot each page onto its box">
                <Image size={12} /> Thumbnails
              </button>
              <button className="btn small" onClick={() => void window.viber.invoke('preview:open', url)} title="Open the app; Alt+click any element to find its box">
                <Eye size={12} /> Live preview
              </button>
            </>
          )}
        </div>
        <pre className="run-log" ref={logRef}>
          {(selected && logs[selected]?.join('\n')) || 'Output appears here. Stack traces light up their boxes in red; request logs light up routes.'}
        </pre>
      </div>
    </div>
  )
}
