import { app, type BrowserWindow } from 'electron'
import { promises as fs } from 'fs'
import path from 'path'
import { spawn } from 'child_process'
import { ctx } from './context'
import { openWorkspace } from './workspaceIpc'

// Dev-only visual test harness: VIBER_SNAP=steps.json VIBER_SNAP_OUT=dir electron .
// Steps: { open?: path, init?: true, save?: true, js?: string, wait?: ms, shot?: name, until?: js-expr }

interface Step {
  /** Async JS run in the main process with ctx, fs (promises) and path in scope. */
  main?: string
  /** Run a command in the background (e.g. a fake agent talking to the MCP server). */
  exec?: string
  open?: string
  init?: boolean
  save?: boolean
  js?: string
  until?: string
  /** Max time to wait for `until`, in ms (default 15 s). */
  untilMs?: number
  wait?: number
  shot?: string
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export async function runSnap(win: BrowserWindow): Promise<void> {
  const steps: Step[] = JSON.parse(await fs.readFile(process.env.VIBER_SNAP!, 'utf8'))
  const out = process.env.VIBER_SNAP_OUT ?? 'snap-out'
  await fs.mkdir(out, { recursive: true })
  win.webContents.on('console-message', (e) => e.level === 'error' && console.log('[renderer]', e.message))
  await sleep(1200)
  for (const s of steps) {
    try {
      if (s.exec) {
        const child = spawn(s.exec, { shell: true, windowsHide: true })
        child.stdout.on('data', (d) => process.stdout.write('[exec] ' + d))
        child.stderr.on('data', (d) => process.stdout.write('[exec!] ' + d))
      }
      if (s.open) await openWorkspace(path.resolve(s.open))
      if (s.main) {
        const fn = new Function('ctx', 'fs', 'path', 'require', `return (async () => { ${s.main} })()`)
        const r = await fn(ctx, fs, path, require)
        if (r !== undefined) console.log('main →', JSON.stringify(r).slice(0, 1500))
      }
      if (s.init) await ctx.requireWs().initialize()
      if (s.save) await ctx.requireWs().save()
      if (s.js) {
        const r = await win.webContents.executeJavaScript(s.js)
        if (r !== undefined) console.log('js →', JSON.stringify(r).slice(0, 2000))
      }
      if (s.until) {
        const deadline = Date.now() + (s.untilMs ?? 15_000)
        while (Date.now() < deadline && !(await win.webContents.executeJavaScript(s.until))) await sleep(250)
      }
    } catch (err) {
      console.log('step error', (err as Error).message)
    }
    await sleep(s.wait ?? 400)
    if (s.shot) {
      const img = await win.webContents.capturePage()
      await fs.writeFile(path.join(out, s.shot + '.png'), img.toPNG())
      console.log('shot', s.shot)
    }
  }
  app.quit()
}
