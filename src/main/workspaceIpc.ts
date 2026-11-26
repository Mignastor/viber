import { app, dialog } from 'electron'
import { promises as fs } from 'fs'
import path from 'path'
import type { DefsOp, RecentWorkspace } from '@shared/api'
import { ctx } from './context'
import { Workspace } from './workspace'
import { checkTemplate, fromTemplate, toTemplate, type BoxTemplate } from './boxTemplate'

const recentFile = (): string => path.join(app.getPath('userData'), 'recent.json')

async function readRecent(): Promise<RecentWorkspace[]> {
  try {
    return JSON.parse(await fs.readFile(recentFile(), 'utf8'))
  } catch {
    return []
  }
}

async function remember(root: string): Promise<void> {
  const list = (await readRecent()).filter((r) => r.root !== root)
  list.unshift({ root, name: path.basename(root), openedAt: Date.now() })
  await fs.mkdir(path.dirname(recentFile()), { recursive: true })
  await fs.writeFile(recentFile(), JSON.stringify(list.slice(0, 12)))
}

export async function openWorkspace(root: string): Promise<void> {
  const st = await fs.stat(root)
  if (!st.isDirectory()) throw new Error('Not a folder: ' + root)
  const ws = await Workspace.open(root)
  ws.on('model', (snap) => ctx.emit('ws:model', snap))
  ws.on('progress', (p) => ctx.emit('ws:progress', p))
  ctx.setWorkspace(ws)
  await remember(root)
  ctx.emit('ws:opened', { root, name: ws.name, initialized: ws.initialized })
  // Initialised repos load straight into the map; new ones wait for the user to press Initialize.
  if (ws.initialized) await ws.fullScan()
}

export function registerWorkspaceIpc(): void {
  ctx.handle('app:recent', async () => {
    const list = await readRecent()
    const alive = await Promise.all(list.map((r) => fs.stat(r.root).then(() => r, () => null)))
    return alive.filter(Boolean)
  })
  ctx.handle('app:openFolder', async () => {
    const r = await dialog.showOpenDialog(ctx.win!, { properties: ['openDirectory'], title: 'Open a repository' })
    if (r.canceled || !r.filePaths[0]) return null
    await openWorkspace(r.filePaths[0])
    return r.filePaths[0]
  })
  ctx.handle('app:openPath', async (root: string) => {
    await openWorkspace(root)
    return root
  })
  ctx.handle('app:close', () => ctx.setWorkspace(null))

  ctx.handle('box:export', async (id: string, withCode: boolean) => {
    const ws = ctx.requireWs()
    const n = ws.built?.model.nodes.find((x) => x.id === id)
    if (!n) return { error: 'No such box.' }
    const code: Record<string, string> = {}
    if (withCode) for (const f of n.files) code[f] = await fs.readFile(path.join(ws.root, f), 'utf8').catch(() => '')
    let tpl: BoxTemplate
    try {
      tpl = toTemplate(ws.built!.model, n, withCode ? code : undefined)
    } catch (e) {
      return { error: (e as Error).message }
    }
    const r = await dialog.showSaveDialog(ctx.win!, { title: 'Export box template', defaultPath: `${tpl.name}.box`, filters: [{ name: 'Viber box template', extensions: ['box'] }] })
    if (r.canceled || !r.filePath) return null
    await fs.writeFile(r.filePath, JSON.stringify(tpl, null, 2))
    return { path: r.filePath }
  })
  ctx.handle('box:import', async (parent?: string) => {
    const ws = ctx.requireWs()
    const r = await dialog.showOpenDialog(ctx.win!, { title: 'Import box template', properties: ['openFile'], filters: [{ name: 'Viber box template', extensions: ['box', 'json'] }] })
    if (r.canceled || !r.filePaths[0]) return null
    let tpl: BoxTemplate
    try {
      tpl = JSON.parse(await fs.readFile(r.filePaths[0], 'utf8'))
    } catch {
      return { error: 'That file is not valid JSON.' }
    }
    const bad = checkTemplate(tpl)
    if (bad) return { error: bad }
    const { ops, files, id } = fromTemplate(tpl, ws.built!.model, parent)
    // Never overwrite: refuse when any file of the template already exists.
    for (const rel of Object.keys(files))
      if (await fs.stat(path.join(ws.root, rel)).then(() => true, () => false)) return { error: `${rel} already exists; import refused so nothing is overwritten.` }
    for (const [rel, text] of Object.entries(files)) {
      const abs = path.join(ws.root, rel)
      if (!abs.startsWith(path.resolve(ws.root) + path.sep)) return { error: 'The template has file paths outside the repo.' }
      await fs.mkdir(path.dirname(abs), { recursive: true })
      await fs.writeFile(abs, text)
    }
    await ws.apply({ op: 'batch', ops })
    if (Object.keys(files).length) await ws.fullScan()
    return { id, files: Object.keys(files).length, requires: tpl.requires ?? [] }
  })
  ctx.handle('ws:snapshot', () => ctx.ws?.snapshot() ?? null)
  ctx.handle('ws:initialize', () => ctx.requireWs().initialize())
  ctx.handle('ws:gitInit', async () => {
    const ws = ctx.requireWs()
    const { initRepo } = await import('./git')
    const r = await initRepo(ws.root)
    await ws.refreshGit()
    return r
  })
  ctx.handle('ws:rescan', () => ctx.requireWs().fullScan())
  ctx.handle('ws:save', () => ctx.requireWs().save())
  ctx.handle('ws:discard', () => ctx.requireWs().discardDraft())
  ctx.handle('ws:apply', (op: DefsOp) => ctx.requireWs().apply(op))
  ctx.handle('ws:layout', (zoom: string, layout: Record<string, { x: number; y: number; w: number; h: number }>) => ctx.requireWs().saveLayout(zoom, layout))
  ctx.handle('ws:read', (rel: string) => ctx.requireWs().readFile(rel))
  ctx.handle('ws:search', (q: string) => ctx.requireWs().search(q))
  ctx.handle('ws:locate', (text: string) => ctx.requireWs().locate(text))
}
