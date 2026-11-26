import { BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { ctx } from './context'

// UI preview: thumbnails of the running app's pages on their boxes, and a live preview window
// where Alt+click on any element selects the box whose component rendered it.

/** Page routes from the model ("PAGE /garden/:id" → "/garden/1"), keyed by box. */
function pageRoutes(): { box: string; path: string }[] {
  const out: { box: string; path: string }[] = []
  for (const n of ctx.ws?.built?.model.nodes ?? []) {
    for (const r of n.routes ?? []) {
      if (!r.startsWith('PAGE ')) continue
      const p = r.slice(5).replace(/:\w+/g, '1').replace(/\*/g, '')
      if (!out.some((o) => o.box === n.id)) out.push({ box: n.id, path: p || '/' })
    }
  }
  return out.slice(0, 24)
}

export async function captureThumbnails(baseUrl: string): Promise<Record<string, string>> {
  const routes = pageRoutes()
  const win = new BrowserWindow({ show: false, width: 1280, height: 800, webPreferences: { offscreen: true, sandbox: true, javascript: true } })
  const thumbs: Record<string, string> = {}
  try {
    for (const r of routes.length ? routes : [{ box: '', path: '/' }]) {
      try {
        await win.loadURL(new URL(r.path, baseUrl).toString())
        await new Promise((res) => setTimeout(res, 1200))
        const img = await win.webContents.capturePage()
        const small = img.resize({ width: 320 })
        const box = r.box || ctx.ws?.built?.model.nodes.find((n) => n.kind === 'box' && /React|Vue|Svelte|Next|Angular/.test(n.tech ?? '') && !n.parent)?.id
        if (box) thumbs[box] = small.toDataURL()
        ctx.emit('preview:thumbs', { ...thumbs })
      } catch {
        /* page failed to load: skip */
      }
    }
  } finally {
    win.destroy()
  }
  return thumbs
}

let previewWin: BrowserWindow | null = null

export function openLivePreview(url: string): void {
  if (previewWin && !previewWin.isDestroyed()) {
    void previewWin.loadURL(url)
    previewWin.focus()
    return
  }
  previewWin = new BrowserWindow({
    width: 1100,
    height: 800,
    title: 'Viber preview — Alt+click an element to find its box',
    autoHideMenuBar: true,
    webPreferences: { preload: join(__dirname, '../preload/preview.js'), sandbox: true, contextIsolation: true }
  })
  void previewWin.loadURL(url)
  previewWin.on('closed', () => (previewWin = null))
}

/** Alt+click in the preview reports the rendering component chain; map it to a box. */
export function registerPreviewPick(): void {
  ipcMain.on('preview:pick', (_e, info: { components: string[]; text: string }) => {
    const ws = ctx.ws
    if (!ws) return
    for (const name of info.components) {
      const file = ws.allFiles().find((f) => f.symbols.some((s) => s.name === name && (s.kind === 'component' || s.kind === 'function' || s.kind === 'class')))
      const box = file ? ws.ownerOfFile(file.path) : null
      if (box && file) {
        ctx.emit('preview:picked', { box, file: file.path, component: name })
        ctx.win?.focus()
        return
      }
    }
    ctx.emit('preview:picked', { box: null, component: info.components[0] ?? null })
  })
}
