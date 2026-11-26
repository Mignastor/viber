import { setLspEnabled } from './lsp'
import { app, safeStorage } from 'electron'
import { promises as fs } from 'fs'
import path from 'path'
import type { AgentKind } from '@shared/api'

// App settings (userData/settings.json) and secrets (userData/secrets.bin, encrypted with the OS
// keychain via safeStorage). Secrets never leave the main process; the UI only learns *whether* one is set.

export type ProviderId = 'anthropic' | 'openai' | 'ollama'
/** Who answers design questions (the architect): a signed-in CLI, an API, or the first ready one. */
export type DesignProvider = 'auto' | 'claude-code' | 'codex' | 'gemini' | ProviderId

export interface Settings {
  agent: AgentKind
  claudePath: string
  /** OpenAI Codex CLI command (signs in with ChatGPT). */
  codexPath: string
  /** Google Gemini CLI command (signs in with a Google account). */
  geminiPath: string
  providers: {
    anthropic: { model: string }
    openai: { baseUrl: string; model: string }
    ollama: { baseUrl: string; model: string }
  }
  /** Which provider does what: editing code (built-in agent) and writing box descriptions. */
  roles: { edit: ProviderId; describe: ProviderId; design: DesignProvider }
  /** Stop the built-in agent after this many tokens per task (0 = no limit). */
  budgetTokens: number
  /** Command prefixes agents may run (e.g. "npm test", "pytest"). */
  allowedCommands: string[]
  mcpPort: number
  otlpPort: number
  /** Use the bundled language servers (TypeScript, Python) for exact references. */
  languageServers: boolean
}

export const DEFAULT_SETTINGS: Settings = {
  agent: 'claude-code',
  claudePath: 'claude',
  codexPath: 'codex',
  geminiPath: 'gemini',
  providers: {
    anthropic: { model: 'claude-opus-5-5' },
    openai: { baseUrl: 'https://api.openai.com/v1', model: '' },
    ollama: { baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5-coder:14b' }
  },
  roles: { edit: 'anthropic', describe: 'ollama', design: 'auto' },
  budgetTokens: 400_000,
  allowedCommands: [],
  mcpPort: 7357,
  otlpPort: 4318,
  languageServers: true
}

const settingsFile = (): string => path.join(app.getPath('userData'), 'settings.json')
const secretsFile = (): string => path.join(app.getPath('userData'), 'secrets.bin')

let cache: Settings | null = null

export async function getSettings(): Promise<Settings> {
  if (cache) return cache
  try {
    const raw = JSON.parse(await fs.readFile(settingsFile(), 'utf8'))
    cache = {
      ...DEFAULT_SETTINGS,
      ...raw,
      providers: {
        anthropic: { ...DEFAULT_SETTINGS.providers.anthropic, ...raw.providers?.anthropic },
        openai: { ...DEFAULT_SETTINGS.providers.openai, ...raw.providers?.openai },
        ollama: { ...DEFAULT_SETTINGS.providers.ollama, ...raw.providers?.ollama }
      },
      roles: { ...DEFAULT_SETTINGS.roles, ...raw.roles }
    }
  } catch {
    cache = structuredClone(DEFAULT_SETTINGS)
  }
  setLspEnabled(cache!.languageServers)
  return cache!
}

export async function setSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await getSettings()), ...patch }
  cache = next
  setLspEnabled(next.languageServers)
  await fs.mkdir(path.dirname(settingsFile()), { recursive: true })
  await fs.writeFile(settingsFile(), JSON.stringify(next, null, 2))
  return next
}

type Secrets = Partial<Record<'anthropicKey' | 'openaiKey', string>>

async function readSecrets(): Promise<Secrets> {
  try {
    const buf = await fs.readFile(secretsFile())
    return JSON.parse(safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(buf) : buf.toString('utf8'))
  } catch {
    return {}
  }
}

export async function setSecret(name: keyof Secrets, value: string | null): Promise<void> {
  const s = await readSecrets()
  if (value) s[name] = value
  else delete s[name]
  const json = JSON.stringify(s)
  await fs.mkdir(path.dirname(secretsFile()), { recursive: true })
  await fs.writeFile(secretsFile(), safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(json) : Buffer.from(json))
}

export async function getSecret(name: keyof Secrets): Promise<string | undefined> {
  return (await readSecrets())[name]
}

export async function secretStatus(): Promise<Record<keyof Secrets, boolean>> {
  const s = await readSecrets()
  return { anthropicKey: !!s.anthropicKey || !!process.env.ANTHROPIC_API_KEY, openaiKey: !!s.openaiKey }
}
