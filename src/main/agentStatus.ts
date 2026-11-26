import { spawn } from 'child_process'
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import { getSecret, getSettings } from './settings'
import { cliComplete, resolveExecutable, signInFailed, type CliId } from './cliAgents'

// Which coding-agent CLIs are on this machine and signed in, so people can use their Claude, ChatGPT or
// Google plan without API keys, and connect them from Viber (install / sign in / test).

export interface CliStatus {
  id: CliId
  label: string
  plan: string
  installed: boolean
  /** true / false when we can tell from local credentials, null when we can't (e.g. macOS keychain). */
  signedIn: boolean | null
  install: string
  signIn: string
  signInHint: string
}

const exists = (p: string): Promise<boolean> => fs.stat(p).then(() => true, () => false)

async function installed(cmd: string): Promise<boolean> {
  const exe = await resolveExecutable(cmd)
  return path.isAbsolute(exe) && (await exists(exe))
}

/**
 * Claude Code's stored login: signed in when there is an access token that has not expired, or a refresh
 * token to renew it. Only the presence of the fields and the expiry dates are read, never their values.
 * null when the file is missing (on macOS the login lives in the keychain instead).
 */
async function claudeSignedIn(file: string): Promise<boolean | null> {
  try {
    const o = JSON.parse(await fs.readFile(file, 'utf8')).claudeAiOauth ?? {}
    const now = Date.now()
    const access = typeof o.accessToken === 'string' && o.accessToken.length > 0 && (!o.expiresAt || o.expiresAt > now)
    const refresh = typeof o.refreshToken === 'string' && o.refreshToken.length > 0 && (!o.refreshTokenExpiresAt || o.refreshTokenExpiresAt > now)
    return access || refresh
  } catch {
    return null
  }
}

export async function cliStatuses(): Promise<CliStatus[]> {
  const s = await getSettings()
  const home = os.homedir()
  const codexHome = process.env.CODEX_HOME ?? path.join(home, '.codex')
  const claudeCreds = !!process.env.ANTHROPIC_API_KEY || (await claudeSignedIn(path.join(home, '.claude', '.credentials.json')))
  const list: CliStatus[] = [
    {
      id: 'claude-code',
      label: 'Claude Code',
      plan: 'your Claude plan (Pro / Max)',
      installed: await installed(s.claudePath),
      signedIn: claudeCreds === null ? (process.platform === 'darwin' ? null : false) : claudeCreds,
      install: 'npm install -g @anthropic-ai/claude-code',
      signIn: s.claudePath,
      signInHint: 'In the window that opens, type /login and follow the browser sign-in, then close it.'
    },
    {
      id: 'codex',
      label: 'Codex',
      plan: 'your ChatGPT plan',
      installed: await installed(s.codexPath),
      signedIn: (await exists(path.join(codexHome, 'auth.json'))) || !!process.env.OPENAI_API_KEY,
      install: 'npm install -g @openai/codex',
      signIn: `${s.codexPath} login`,
      signInHint: 'Choose "Sign in with ChatGPT" and finish in the browser.'
    },
    {
      id: 'gemini',
      label: 'Gemini',
      plan: 'your Google account (free tier)',
      installed: await installed(s.geminiPath),
      signedIn: (await exists(path.join(home, '.gemini', 'oauth_creds.json'))) || !!process.env.GEMINI_API_KEY,
      install: 'npm install -g @google/gemini-cli',
      signIn: s.geminiPath,
      signInHint: 'Choose "Login with Google" and finish in the browser, then close the window.'
    }
  ]
  // Credentials on disk can be expired: a failed request wins until the next success.
  for (const c of list) if (signInFailed.has(c.id)) c.signedIn = false
  return list
}

/** Open a real terminal window running a command (sign-ins need a browser and an interactive terminal). */
export function openTerminal(command: string): void {
  const opts = { detached: true, stdio: 'ignore' as const, windowsHide: false }
  if (process.platform === 'win32') {
    // A script file avoids every quoting rule of the two cmd.exe layers (start, then the window).
    const script = path.join(os.tmpdir(), `viber-terminal-${Date.now()}.cmd`)
    void fs.writeFile(script, `@echo off\r\n${command}\r\n`).then(() => spawn('cmd.exe', ['/c', 'start', '"Viber"', 'cmd', '/k', `"${script}"`], { ...opts, shell: false, windowsVerbatimArguments: true }).unref())
  }
  else if (process.platform === 'darwin') spawn('osascript', ['-e', `tell application "Terminal" to do script ${JSON.stringify(command)}`, '-e', 'tell application "Terminal" to activate'], opts).unref()
  else spawn('x-terminal-emulator', ['-e', 'bash', '-lc', `${command}; exec bash`], opts).unref()
}

/** A tiny real request through the CLI, to prove it is installed and signed in. */
export async function testCli(id: CliId): Promise<{ ok: boolean; text: string }> {
  try {
    const t = await cliComplete(id, 'You are a connection test.', 'Reply with exactly: OK', os.tmpdir())
    return { ok: true, text: t.trim().slice(0, 120) || 'OK' }
  } catch (e) {
    return { ok: false, text: (e as Error).message }
  }
}

/** Where design answers (architect) come from: the setting, or the first ready option when it is "auto". */
export async function designProvider(): Promise<CliId | 'anthropic' | 'ollama' | 'openai'> {
  const s = await getSettings()
  if (s.roles.design !== 'auto') return s.roles.design
  for (const c of await cliStatuses()) if (c.installed && c.signedIn !== false) return c.id
  if ((await getSecret('anthropicKey')) || process.env.ANTHROPIC_API_KEY) return 'anthropic'
  if (s.providers.ollama.model) {
    // Only when the configured model is actually pulled.
    const tags = await fetch(s.providers.ollama.baseUrl.replace(/\/v1\/?$/, '') + '/api/tags', { signal: AbortSignal.timeout(1500) }).then((r) => (r.ok ? r.json() : null), () => null)
    if (tags?.models?.some((m: { name: string }) => m.name === s.providers.ollama.model)) return 'ollama'
  }
  throw new Error('NO_AGENT: No coding agent is connected yet. Open "Connect agents" (plug icon) to sign in with your Claude, ChatGPT or Google account.')
}
