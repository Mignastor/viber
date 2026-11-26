import { dryRun } from './dryRun'
import { cliStatuses, openTerminal, testCli } from './agentStatus'
import type { CliId } from './cliAgents'
import { shell } from 'electron'
import path from 'path'
import type { AgentKind, StartSessionInput } from '@shared/api'
import { ctx } from './context'
import { SessionManager } from './sessions'
import { finishSession, startSession, stopSession } from './agents'
import { branches, commitFiles, git } from './git'
import { mcpUrl, mcpPort, writeAgentInstructions, writeMcpConfig } from './mcp'
import { detectRunConfigs, startRun, stopRun, stopAllRuns, type RunConfig } from './runner'
import { otlpPort, resetRuntime } from './runtime'
import { createTerminal, killTerminal, resizeTerminal, writeTerminal } from './terminal'
import { getSettings, secretStatus, setSecret, setSettings, type Settings } from './settings'
import { describeBoxes, history } from './insights'
import { captureThumbnails, openLivePreview } from './preview'
import { answerQuestion, dismissQuestion, listQuestions } from './questions'
import { decideAcp, listAcps, startFollowUps } from './acp'
import { architect, type ArchitectTurn } from './architect'
import { getBuildState, planBuild, startBuild, stopBuild } from './orchestrator'
import type { DefsOp } from '@shared/api'

export function registerSessionIpc(): void {
  // A session manager per open workspace, created once its first scan has finished.
  ctx.onWorkspace((ws) => {
    if (!ws) return
    const attach = async (): Promise<void> => {
      if (ctx.sessions || ctx.ws !== ws) return
      const sm = new SessionManager(ws)
      ctx.sessions = sm
      sm.on('event', (e) => ctx.emit('session:event', e))
      sm.on('list', (list) => ctx.emit('session:list', list))
      sm.on('fileChanged', () => void ws.refreshGit())
      await sm.init()
    }
    ws.once('model', () => void attach())
  })

  ctx.handle('session:list', () => ctx.sessions?.list() ?? [])
  ctx.handle('session:events', (id: string) => ctx.sessions?.get(id)?.events ?? [])
  ctx.handle('session:start', (input: StartSessionInput) => startSession(input))
  ctx.handle('session:stop', (id: string) => stopSession(id))
  ctx.handle('session:finish', (id: string) => finishSession(id))
  ctx.handle('session:decide', (id: string, approved: boolean, feedback?: string) => ctx.sessions?.decidePlan(id, approved, feedback))
  ctx.handle('session:base', (rel: string, sessionId?: string) => ctx.sessions?.baseContent(sessionId ?? activeSessionId(), rel) ?? '')
  ctx.handle('session:current', (rel: string, sessionId?: string) => ctx.sessions?.currentContent(sessionId ?? activeSessionId(), rel) ?? '')
  ctx.handle('session:revert', (files: string[], sessionId?: string) => ctx.sessions?.revert(sessionId ?? activeSessionId(), files))
  ctx.handle('session:setActive', (id: string) => (active = id))
  ctx.handle('session:discardWorktree', (id: string) => ctx.sessions?.discardWorktree(id))
  ctx.handle('session:mergeWorktree', async (id: string) => {
    const s = ctx.sessions?.get(id)
    const ws = ctx.requireWs()
    if (!s?.info.worktree) return { ok: false, error: 'not a worktree session' }
    // Commit whatever the agent left in the worktree, then merge its branch into the current one.
    await git(s.root, ['add', '-A'])
    await git(s.root, ['commit', '-m', `viber: ${s.info.title}`])
    const r = await git(ws.root, ['merge', '--no-ff', '-m', `Merge ${s.info.worktree.branch}: ${s.info.title}`, s.info.worktree.branch])
    return r.code === 0 ? { ok: true } : { ok: false, error: (r.stderr || r.stdout).trim() }
  })

  ctx.handle('git:commit', (files: string[], message: string) => commitFiles(activeRoot(), files, message))
  ctx.handle('git:branches', () => branches(ctx.requireWs().root))
  ctx.handle('git:checkout', async (branch: string) => {
    const r = await git(ctx.requireWs().root, ['checkout', branch])
    if (r.code === 0) await ctx.requireWs().fullScan()
    return r.code === 0 ? { ok: true } : { ok: false, error: r.stderr.trim() }
  })
  ctx.handle('git:createPr', async () => {
    // Opens the host's "new pull request" page for the current branch; nothing is posted for you.
    const ws = ctx.requireWs()
    const remote = (await git(ws.root, ['remote', 'get-url', 'origin'])).stdout.trim()
    const branch = (await git(ws.root, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim()
    const m = remote.match(/github\.com[:/](.+?)(\.git)?$/)
    if (!m) return { ok: false, error: 'Only GitHub remotes are supported for now.' }
    await git(ws.root, ['push', '-u', 'origin', branch])
    await shell.openExternal(`https://github.com/${m[1]}/compare/${encodeURIComponent(branch)}?expand=1`)
    return { ok: true }
  })
  ctx.handle('git:history', (n?: number) => history(n))

  ctx.handle('agents:status', () => ({ mcpUrl: mcpUrl(), mcpPort: mcpPort(), otlpPort: otlpPort() }))
  ctx.handle('agents:writeMcpConfig', () => writeMcpConfig(ctx.requireWs().root))
  ctx.handle('agents:writeInstructions', (file: 'CLAUDE.md' | 'AGENTS.md') => writeAgentInstructions(ctx.requireWs().root, file))

  ctx.handle('run:configs', () => detectRunConfigs())
  ctx.handle('run:start', (cfg: RunConfig) => startRun(cfg))
  ctx.handle('run:stop', (id: string) => stopRun(id))
  ctx.handle('runtime:reset', () => resetRuntime())

  ctx.handle('term:create', (id: string, cols: number, rows: number) => createTerminal(id, activeRoot(), cols, rows))
  ctx.handle('term:write', (id: string, data: string) => writeTerminal(id, data))
  ctx.handle('term:resize', (id: string, cols: number, rows: number) => resizeTerminal(id, cols, rows))
  ctx.handle('term:kill', (id: string) => killTerminal(id))

  ctx.handle('settings:get', async () => ({ settings: await getSettings(), secrets: await secretStatus() }))
  ctx.handle('settings:set', (patch: Partial<Settings>) => setSettings(patch))
  ctx.handle('settings:ollamaModels', async () => {
    const base = (await getSettings()).providers.ollama.baseUrl.replace(/\/v1\/?$/, '')
    try {
      const r = await fetch(base + '/api/tags', { signal: AbortSignal.timeout(2500) })
      const j = (await r.json()) as { models?: { name: string }[] }
      return (j.models ?? []).map((m) => m.name)
    } catch {
      return []
    }
  })
  ctx.handle('settings:secret', (name: 'anthropicKey' | 'openaiKey', value: string | null) => setSecret(name, value))

  ctx.handle('insights:describe', () => describeBoxes((done, total) => ctx.emit('ws:progress', { phase: 'Describing boxes', done, total })))
  ctx.handle('preview:thumbs', (url: string) => captureThumbnails(url))
  ctx.handle('preview:open', (url: string) => openLivePreview(url))
  ctx.handle('questions:list', () => listQuestions())
  ctx.handle('questions:answer', (id: string, answer: string, asRule: boolean) => answerQuestion(id, answer, asRule))
  ctx.handle('questions:dismiss', (id: string) => dismissQuestion(id))
  ctx.handle('agents:cli', () => cliStatuses())
  ctx.handle('agents:openTerminal', (command: string) => openTerminal(command))
  ctx.handle('agents:test', (id: CliId) => testCli(id))
  ctx.handle('design:dryRun', (input: { journeyId?: string; scenario?: string }) => dryRun(input))
  ctx.handle('acp:list', () => listAcps())
  ctx.handle('acp:decide', (id: string, approved: boolean, feedback?: string) => decideAcp(id, approved, feedback))
  ctx.handle('acp:followUps', async (id: string) => {
    const acp = (await listAcps()).find((a) => a.id === id)
    return acp ? startFollowUps(acp, 'all') : []
  })
  ctx.handle('design:architect', (history: ArchitectTurn[]) => architect(history))
  ctx.handle('design:preview', (ops: DefsOp[]) => ctx.requireWs().preview(ops))
  ctx.handle('build:plan', (ids?: string[]) => planBuild(ids))
  ctx.handle('build:state', () => getBuildState())
  ctx.handle('build:start', (opts: { ids?: string[]; agent: AgentKind; maxParallel?: number }) => {
    // Runs in the background; progress arrives as build:state events.
    void startBuild(opts).catch((e) => ctx.emit('build:error', String((e as Error).message ?? e)))
  })
  ctx.handle('build:stop', () => stopBuild())
  ctx.handle('app:reveal', (rel: string) => shell.showItemInFolder(path.join(ctx.requireWs().root, rel)))
}

let active = 'watch'
const activeSessionId = (): string => (ctx.sessions?.get(active) ? active : 'watch')
const activeRoot = (): string => ctx.sessions?.get(activeSessionId())?.root ?? ctx.requireWs().root

export function shutdown(): void {
  stopAllRuns()
}
