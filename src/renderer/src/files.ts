import { useEffect, useState } from 'react'
import { useStore } from './store'
import { fileContent } from './model/code'

// File text for the code view. Demo: hand-written versions. Workspace: read from disk (current)
// or from the session checkpoint (base), refreshed whenever the watcher reports a change.

let rev = 0
const listeners = new Set<() => void>()
export function bumpFiles(): void {
  rev++
  for (const l of listeners) l()
}

function useRev(): number {
  const [r, setR] = useState(rev)
  useEffect(() => {
    const l = (): void => setR(rev)
    listeners.add(l)
    return () => void listeners.delete(l)
  }, [])
  return r
}

export function useFileText(path: string | null, version: string): string | null {
  const mode = useStore((s) => s.mode)
  const r = useRev()
  const [text, setText] = useState<string | null>(null)
  useEffect(() => {
    if (!path) return setText(null)
    if (mode === 'demo') return setText(fileContent(path, version))
    let alive = true
    const channel = version === 'base' ? 'session:base' : 'ws:read'
    window.viber
      .invoke<string>(channel, path)
      .then((t) => alive && setText(t))
      .catch(() => alive && setText(version === 'base' ? '' : `// Could not read ${path}`))
    return () => {
      alive = false
    }
  }, [path, version, mode, r])
  return text
}
