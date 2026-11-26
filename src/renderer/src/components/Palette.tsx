import { useEffect, useMemo, useRef, useState } from 'react'
import { Box, Command, FileCode, Route, Search, Braces } from 'lucide-react'
import type { SearchHit } from '@shared/api'
import { useStore } from '../store'

// Ctrl/Cmd+K: search the map by meaning-ish (boxes, routes, symbols, files) and run commands.
// Results light up on the map instead of opening a list of files.

interface Cmd {
  id: string
  title: string
  hint?: string
  when?: () => boolean
  run: () => void
}

function commands(): Cmd[] {
  const st = useStore.getState
  const ws = (): boolean => st().mode === 'workspace'
  const invoke = (ch: string, ...a: unknown[]) => () => void window.viber.invoke(ch, ...a)
  return [
    { id: 'open', title: 'Open folder…', run: invoke('app:openFolder') },
    { id: 'locate', title: 'Bug → box: locate an error or stack trace', when: ws, run: () => st().setModal({ kind: 'locate' }) },
    { id: 'actor', title: 'Declare an actor', when: ws, run: () => st().setModal({ kind: 'actor' }) },
    { id: 'guard', title: 'Add a guardrail', when: ws, run: () => st().setModal({ kind: 'guardrail' }) },
    { id: 'rescan', title: 'Rescan repository', when: ws, run: invoke('ws:rescan') },
    { id: 'init', title: 'Re-initialize (propose a fresh model)', when: ws, run: invoke('ws:initialize') },
    { id: 'z1', title: 'Zoom: System', run: () => st().setZoom(1) },
    { id: 'z2', title: 'Zoom: Service', run: () => st().setZoom(2) },
    { id: 'z3', title: 'Zoom: Component', run: () => st().setZoom(3) },
    { id: 'model', title: 'Show model panel', when: ws, run: () => useStore.setState({ leftTab: 'model' }) },
    { id: 'session', title: 'Show session panel', run: () => useStore.setState({ leftTab: 'session' }) },
    { id: 'settings', title: 'Settings: models, providers, budgets', run: () => st().setModal({ kind: 'settings' }) },
    { id: 'clearfocus', title: 'Clear actor focus and highlights', run: () => (st().setActorFocus(null), st().setHighlight([])) },
    { id: 'demo', title: 'Open the demo session', run: () => st().enterDemo() },
    { id: 'close', title: 'Close workspace', when: ws, run: () => (void window.viber.invoke('app:close'), st().leaveToWelcome()) }
  ]
}

const ICON = { box: Box, symbol: Braces, file: FileCode, route: Route, text: Search }

export function Palette() {
  const { setModal, select, openCode, setHighlight } = useStore.getState()
  const mode = useStore((s) => s.mode)
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<SearchHit[]>([])
  const [active, setActive] = useState(0)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)

  const cmds = useMemo(() => commands().filter((c) => !c.when || c.when()), [])
  const matchedCmds = cmds.filter((c) => !q || c.title.toLowerCase().includes(q.toLowerCase().replace(/^>\s*/, '')))

  useEffect(() => {
    if (mode !== 'workspace' || !q.trim() || q.startsWith('>')) return setHits([])
    clearTimeout(timer.current)
    timer.current = setTimeout(async () => {
      const r = await window.viber.invoke<SearchHit[]>('ws:search', q).catch(() => [])
      setHits(r)
      setHighlight([...new Set(r.slice(0, 12).map((h) => h.nodeId).filter((x): x is string => !!x))])
    }, 120)
  }, [q, mode, setHighlight])

  const items: ({ type: 'cmd'; cmd: Cmd } | { type: 'hit'; hit: SearchHit })[] = [
    ...hits.slice(0, 14).map((hit) => ({ type: 'hit' as const, hit })),
    ...matchedCmds.slice(0, q ? 6 : 15).map((cmd) => ({ type: 'cmd' as const, cmd }))
  ]

  const pick = (i: number): void => {
    const it = items[i]
    if (!it) return
    setModal(null)
    if (it.type === 'cmd') return it.cmd.run()
    const h = it.hit
    if (h.nodeId && (h.kind === 'symbol' || h.kind === 'file') && h.file) openCode(h.nodeId, h.file)
    else if (h.nodeId) select({ kind: 'node', id: h.nodeId })
  }

  return (
    <div className="modal-backdrop top" onMouseDown={() => setModal(null)}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()}>
        <div className="palette-input">
          <Search size={15} />
          <input
            autoFocus
            value={q}
            placeholder={mode === 'workspace' ? 'Search boxes, routes, symbols, files… or > for commands' : 'Type a command…'}
            onChange={(e) => (setQ(e.target.value), setActive(0))}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') (e.preventDefault(), setActive((a) => Math.min(items.length - 1, a + 1)))
              else if (e.key === 'ArrowUp') (e.preventDefault(), setActive((a) => Math.max(0, a - 1)))
              else if (e.key === 'Enter') pick(active)
              else if (e.key === 'Escape') setModal(null)
            }}
          />
        </div>
        <div className="palette-list">
          {items.map((it, i) => {
            if (it.type === 'cmd')
              return (
                <div key={it.cmd.id} className={`palette-item ${i === active ? 'on' : ''}`} onMouseEnter={() => setActive(i)} onClick={() => pick(i)}>
                  <Command size={13} />
                  <span>{it.cmd.title}</span>
                </div>
              )
            const Icon = ICON[it.hit.kind]
            return (
              <div key={`${it.hit.kind}${it.hit.title}${i}`} className={`palette-item ${i === active ? 'on' : ''}`} onMouseEnter={() => setActive(i)} onClick={() => pick(i)}>
                <Icon size={13} />
                <span className={it.hit.kind === 'symbol' || it.hit.kind === 'file' ? 'mono' : ''}>{it.hit.title}</span>
                <span className="palette-detail">{it.hit.detail ?? it.hit.file ?? ''}</span>
              </div>
            )
          })}
          {items.length === 0 && <div className="palette-empty">No matches</div>}
        </div>
      </div>
    </div>
  )
}
