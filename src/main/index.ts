import { stopAllLsp } from './lsp'
import { getSettings } from './settings'
import { app, BrowserWindow, shell } from 'electron'
import { join } from 'path'
import { ctx } from './context'
import { registerWorkspaceIpc } from './workspaceIpc'
import { runSnap } from './devSnap'
import { registerSessionIpc, shutdown } from './sessionIpc'
import { startMcp } from './mcp'
import { startOtlp } from './runtime'
import { registerPreviewPick } from './preview'
import { killAllTerminals } from './terminal'
import { maybeRunBench } from './bench'

const SNAP = !app.isPackaged && !!process.env.VIBER_SNAP
// Test runs keep their own settings and recent list, so they never touch the user's.
if (SNAP || (!app.isPackaged && process.env.VIBER_BENCH)) app.setPath('userData', join(app.getPath('temp'), 'viber-dev-userdata'))

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1100,
    minHeight: 700,
    title: 'Viber',
    backgroundColor: '#0a0e13',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      ...(SNAP ? { offscreen: true, backgroundThrottling: false } : {})
    }
  })
  ctx.win = win

  if (SNAP) {
    win.webContents.setFrameRate(30)
    win.webContents.once('did-finish-load', () => void runSnap(win))
  } else win.once('ready-to-show', () => win.show())

  // Never navigate the app window to external pages; open them in the OS browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('http://localhost') && !url.startsWith('file://')) e.preventDefault()
  })

  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  ctx.onWorkspace(() => stopAllLsp())
  app.on('will-quit', () => stopAllLsp())
  void getSettings()
  registerWorkspaceIpc()
  registerSessionIpc()
  registerPreviewPick()
  void startMcp()
  void startOtlp()
  // Headless benchmark mode: no window.
  if (maybeRunBench()) return
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  shutdown()
  killAllTerminals()
  ctx.setWorkspace(null)
  if (process.platform !== 'darwin') app.quit()
})
