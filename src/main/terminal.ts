import os from 'os'
import type { IPty } from 'node-pty'
import { ctx } from './context'

// Embedded terminals (node-pty). Run any agent's interactive CLI here: with the Viber MCP server
// connected, the map still shows its intent, plan and edits.

const terms = new Map<string, IPty>()

export async function createTerminal(id: string, cwd: string, cols: number, rows: number): Promise<void> {
  const pty = await import('node-pty')
  const shell = process.platform === 'win32' ? 'powershell.exe' : process.env.SHELL || (os.platform() === 'darwin' ? '/bin/zsh' : '/bin/bash')
  const p = pty.spawn(shell, [], { name: 'xterm-256color', cols, rows, cwd, env: { ...process.env, VIBER: '1' } as Record<string, string> })
  terms.set(id, p)
  p.onData((data) => ctx.emit('term:data', { id, data }))
  p.onExit(({ exitCode }) => {
    terms.delete(id)
    ctx.emit('term:exit', { id, exitCode })
  })
}

export function writeTerminal(id: string, data: string): void {
  terms.get(id)?.write(data)
}

export function resizeTerminal(id: string, cols: number, rows: number): void {
  try {
    terms.get(id)?.resize(Math.max(2, cols), Math.max(2, rows))
  } catch {
    /* terminal already gone */
  }
}

export function killTerminal(id: string): void {
  terms.get(id)?.kill()
  terms.delete(id)
}

export function killAllTerminals(): void {
  for (const id of [...terms.keys()]) killTerminal(id)
}
