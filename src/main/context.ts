import { BrowserWindow, ipcMain } from 'electron'
import type { Workspace } from './workspace'
import type { SessionManager } from './sessions'

// Shared state for the main-process modules: the window, the open workspace, and event emission.

type Handler = (...args: any[]) => unknown

class AppContext {
  win: BrowserWindow | null = null
  ws: Workspace | null = null
  sessions: SessionManager | null = null
  private wsListeners: ((ws: Workspace | null) => void)[] = []

  emit(event: string, payload?: unknown): void {
    if (this.win && !this.win.isDestroyed()) this.win.webContents.send(event, payload)
  }

  handle(channel: string, fn: Handler): void {
    ipcMain.handle(channel, (_e, ...args) => fn(...args))
  }

  requireWs(): Workspace {
    if (!this.ws) throw new Error('No workspace is open')
    return this.ws
  }

  setWorkspace(ws: Workspace | null): void {
    this.sessions?.dispose()
    this.sessions = null
    this.ws?.dispose()
    this.ws = ws
    for (const l of this.wsListeners) l(ws)
  }

  onWorkspace(l: (ws: Workspace | null) => void): void {
    this.wsListeners.push(l)
  }
}

export const ctx = new AppContext()
