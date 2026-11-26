import { spawn } from 'child_process'
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import type { GitInfo } from '@shared/api'

// Thin git wrapper. Checkpoints snapshot the *whole working tree* (tracked + untracked, honouring
// .gitignore) into a commit object under refs/viber/, without touching the user's index or branch.

export interface GitResult {
  code: number
  stdout: string
  stderr: string
}

export function git(cwd: string, args: string[], opts: { env?: NodeJS.ProcessEnv; input?: string } = {}): Promise<GitResult> {
  return new Promise((resolve) => {
    const p = spawn('git', args, { cwd, env: { ...process.env, ...opts.env, GIT_TERMINAL_PROMPT: '0' }, windowsHide: true })
    let stdout = ''
    let stderr = ''
    p.stdout.on('data', (d) => (stdout += d))
    p.stderr.on('data', (d) => (stderr += d))
    p.on('error', (e) => resolve({ code: -1, stdout, stderr: String(e) }))
    p.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }))
    if (opts.input !== undefined) {
      p.stdin.write(opts.input)
      p.stdin.end()
    }
  })
}

export async function isRepo(cwd: string): Promise<boolean> {
  const r = await git(cwd, ['rev-parse', '--is-inside-work-tree'])
  return r.code === 0 && r.stdout.trim() === 'true'
}

/** Make a new project a git repo with a first commit, so sessions get checkpoints, undo and worktrees. */
export async function initRepo(cwd: string): Promise<{ ok: boolean; error?: string }> {
  if (await isRepo(cwd)) return { ok: true }
  const init = await git(cwd, ['init', '-b', 'main'])
  if (init.code !== 0) return { ok: false, error: init.stderr.trim() || 'git init failed' }
  await git(cwd, ['add', '-A'])
  const c = await git(cwd, ['commit', '--allow-empty', '-m', 'Start project'])
  if (c.code !== 0) return { ok: false, error: /user\.(name|email)|identity/i.test(c.stderr) ? 'Git needs your name and email first: git config --global user.name "…" and user.email "…"' : c.stderr.trim() }
  return { ok: true }
}

export async function gitInfo(cwd: string): Promise<GitInfo | null> {
  if (!(await isRepo(cwd))) return null
  const [branch, status, remote] = await Promise.all([
    git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']),
    git(cwd, ['status', '--porcelain']),
    git(cwd, ['remote', 'get-url', 'origin'])
  ])
  return {
    branch: branch.stdout.trim() || 'HEAD',
    dirty: status.stdout.split('\n').filter((l) => l.trim() && !l.includes('.arch/')).length,
    remote: remote.code === 0 ? remote.stdout.trim() : undefined
  }
}

/** Snapshot the working tree into a commit (not on any branch). Returns its sha, or null outside git. */
export async function createCheckpoint(cwd: string, label: string): Promise<string | null> {
  if (!(await isRepo(cwd))) return null
  const tmpIndex = path.join(os.tmpdir(), `viber-index-${process.pid}-${Date.now()}`)
  const env = { GIT_INDEX_FILE: tmpIndex }
  try {
    const head = await git(cwd, ['rev-parse', '--verify', 'HEAD'])
    if (head.code === 0) await git(cwd, ['read-tree', 'HEAD'], { env })
    await git(cwd, ['add', '-A', '.'], { env })
    const tree = (await git(cwd, ['write-tree'], { env })).stdout.trim()
    if (!tree) return null
    const args = ['commit-tree', tree, '-m', `viber checkpoint: ${label}`]
    if (head.code === 0) args.splice(2, 0, '-p', head.stdout.trim())
    const sha = (await git(cwd, args, { env: { GIT_AUTHOR_NAME: 'Viber', GIT_AUTHOR_EMAIL: 'viber@localhost', GIT_COMMITTER_NAME: 'Viber', GIT_COMMITTER_EMAIL: 'viber@localhost' } })).stdout.trim()
    if (sha) await git(cwd, ['update-ref', `refs/viber/checkpoints/${label.replace(/[^\w.-]/g, '-')}`, sha])
    return sha || null
  } finally {
    await fs.rm(tmpIndex, { force: true }).catch(() => {})
  }
}

/** File content at a commit, or null if the file did not exist there. */
export async function showAt(cwd: string, sha: string, rel: string): Promise<string | null> {
  const r = await git(cwd, ['show', `${sha}:${rel}`])
  return r.code === 0 ? r.stdout : null
}

export async function commitFiles(cwd: string, files: string[], message: string): Promise<{ ok: boolean; sha?: string; error?: string }> {
  if (!files.length) return { ok: false, error: 'nothing to commit' }
  const add = await git(cwd, ['add', '-A', '--', ...files])
  if (add.code !== 0) return { ok: false, error: add.stderr.trim() }
  const c = await git(cwd, ['commit', '-m', message, '--', ...files])
  if (c.code !== 0) return { ok: false, error: (c.stderr || c.stdout).trim() }
  const sha = (await git(cwd, ['rev-parse', 'HEAD'])).stdout.trim()
  return { ok: true, sha }
}

export interface LogEntry {
  sha: string
  author: string
  time: number
  subject: string
  files: string[]
}

export async function log(cwd: string, n: number): Promise<LogEntry[]> {
  const r = await git(cwd, ['log', `-n${n}`, '--name-only', '--no-merges', '--format=%x1e%H%x09%an%x09%at%x09%s'])
  if (r.code !== 0) return []
  return r.stdout
    .split('\x1e')
    .filter((c) => c.trim())
    .map((chunk) => {
      const [head, ...rest] = chunk.split('\n')
      const [sha, author, time, subject] = head.split('\t')
      return { sha, author, time: Number(time) * 1000, subject, files: rest.map((l) => l.trim()).filter(Boolean) }
    })
}

export async function branches(cwd: string): Promise<{ current: string; all: string[] }> {
  const [cur, all] = await Promise.all([git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']), git(cwd, ['branch', '--format=%(refname:short)'])])
  return { current: cur.stdout.trim(), all: all.stdout.split('\n').map((s) => s.trim()).filter(Boolean) }
}

export async function addWorktree(cwd: string, dir: string, branch: string): Promise<GitResult> {
  return git(cwd, ['worktree', 'add', '-b', branch, dir])
}

export async function removeWorktree(cwd: string, dir: string): Promise<GitResult> {
  return git(cwd, ['worktree', 'remove', '--force', dir])
}

/** Line-level diff counts via LCS, with a cheap fallback for big files. */
export function diffCounts(before: string, after: string): { added: number; removed: number } {
  // Compare content, not line endings (git may check files out as CRLF on Windows).
  const a = before ? before.replace(/\r\n/g, '\n').split('\n') : []
  const b = after ? after.replace(/\r\n/g, '\n').split('\n') : []
  // Trim common prefix/suffix first: edits are usually local.
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let ea = a.length
  let eb = b.length
  while (ea > start && eb > start && a[ea - 1] === b[eb - 1]) (ea--, eb--)
  const A = a.slice(start, ea)
  const B = b.slice(start, eb)
  if (A.length * B.length > 4_000_000) return { added: B.length, removed: A.length }
  const prev = new Array(B.length + 1).fill(0)
  for (let i = A.length - 1; i >= 0; i--) {
    let diag = 0
    for (let j = B.length - 1; j >= 0; j--) {
      const tmp = prev[j]
      prev[j] = A[i] === B[j] ? diag + 1 : Math.max(prev[j], prev[j + 1])
      diag = tmp
    }
  }
  // prev[0] now holds the LCS length (row-reused DP).
  const common = prev[0]
  return { added: B.length - common, removed: A.length - common }
}
