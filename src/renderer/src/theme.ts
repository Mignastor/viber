import { useEffect, useState } from 'react'
import * as monaco from 'monaco-editor'

// Theme preference: follow the OS, or force light/dark. Stored per machine (a viewer convenience).

export type ThemePref = 'system' | 'light' | 'dark'
export type Theme = 'light' | 'dark'

const KEY = 'viber.theme'
const media = window.matchMedia('(prefers-color-scheme: light)')
const listeners = new Set<(t: Theme) => void>()

export function getPref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY)
    return v === 'light' || v === 'dark' ? v : 'system'
  } catch {
    return 'system'
  }
}

export function resolved(pref = getPref()): Theme {
  return pref === 'system' ? (media.matches ? 'light' : 'dark') : pref
}

function apply(): void {
  const t = resolved()
  document.documentElement.dataset.theme = t
  monaco.editor.setTheme(t === 'light' ? 'viber-light' : 'viber-dark')
  for (const l of listeners) l(t)
}

export function setPref(p: ThemePref): void {
  try {
    if (p === 'system') localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, p)
  } catch {
    /* storage unavailable: still apply for this session */
  }
  apply()
}

export function initTheme(): void {
  media.addEventListener('change', () => getPref() === 'system' && apply())
  apply()
}

export function useTheme(): Theme {
  const [t, setT] = useState<Theme>(resolved())
  useEffect(() => {
    listeners.add(setT)
    return () => void listeners.delete(setT)
  }, [])
  return t
}

/** Read a design token, for places that need a concrete colour (SVG markers, minimap, xterm). */
export function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}
