import { useState } from 'react'
import { Monitor, Moon, Sun } from 'lucide-react'
import { getPref, setPref, type ThemePref } from '../theme'

const NEXT: Record<ThemePref, ThemePref> = { system: 'light', light: 'dark', dark: 'system' }
const LABEL: Record<ThemePref, string> = { system: 'Theme: follow system', light: 'Theme: light', dark: 'Theme: dark' }

export function ThemeToggle({ className = '' }: { className?: string }) {
  const [pref, setP] = useState<ThemePref>(getPref())
  const Icon = pref === 'light' ? Sun : pref === 'dark' ? Moon : Monitor
  return (
    <button
      className={`icon-btn ${className}`}
      title={`${LABEL[pref]} (click to change)`}
      aria-label={LABEL[pref]}
      onClick={() => {
        const n = NEXT[pref]
        setPref(n)
        setP(n)
      }}
    >
      <Icon size={15} />
    </button>
  )
}
