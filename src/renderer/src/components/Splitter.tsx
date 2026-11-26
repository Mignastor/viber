import { useEffect } from 'react'

// Drag handles between the side panels and the map. Widths live in CSS variables (so the layout stays
// in CSS) and are remembered per viewer. Double-click resets.

const KEY = { left: 'viber.leftWidth', right: 'viber.rightWidth' } as const
const VAR = { left: '--left-w', right: '--right-w' } as const
const DEFAULT = { left: 300, right: 380 } as const

const clamp = (w: number): number => Math.round(Math.max(240, Math.min(w, Math.max(320, window.innerWidth * 0.6))))

function apply(side: 'left' | 'right', w: number | null): void {
  if (w === null) document.documentElement.style.removeProperty(VAR[side])
  else document.documentElement.style.setProperty(VAR[side], `${clamp(w)}px`)
}

/** Restore saved widths once (call from the app root). */
export function useSavedPanelWidths(): void {
  useEffect(() => {
    for (const side of ['left', 'right'] as const) {
      try {
        const v = Number(localStorage.getItem(KEY[side]))
        if (v) apply(side, v)
      } catch {
        /* storage unavailable: defaults */
      }
    }
  }, [])
}

export function Splitter({ side }: { side: 'left' | 'right' }) {
  const start = (e: React.PointerEvent<HTMLDivElement>): void => {
    e.preventDefault()
    const el = e.currentTarget
    el.setPointerCapture(e.pointerId)
    el.classList.add('dragging')
    let last = 0
    const move = (ev: PointerEvent): void => {
      last = side === 'left' ? ev.clientX : window.innerWidth - ev.clientX
      apply(side, last)
    }
    const up = (): void => {
      el.classList.remove('dragging')
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      try {
        if (last) localStorage.setItem(KEY[side], String(clamp(last)))
      } catch {
        /* not remembered */
      }
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
  }
  const reset = (): void => {
    apply(side, null)
    try {
      localStorage.removeItem(KEY[side])
    } catch {
      /* nothing saved */
    }
  }
  return <div className={`splitter splitter-${side}`} onPointerDown={start} onDoubleClick={reset} title={`Drag to resize (double-click: ${DEFAULT[side]}px)`} role="separator" aria-orientation="vertical" />
}
