import { useEffect, useState } from 'react'
import { Check, CircleAlert, Copy, Download, FileText, LogIn, Loader2, Plug, RefreshCw, Zap } from 'lucide-react'
import { useStore } from '../store'
import { Dialog } from './Modals'

type ProviderId = 'anthropic' | 'openai' | 'ollama'

interface Settings {
  agent: 'claude-code' | 'codex' | 'gemini' | 'builtin' | 'external'
  claudePath: string
  codexPath: string
  geminiPath: string
  providers: {
    anthropic: { model: string }
    openai: { baseUrl: string; model: string }
    ollama: { baseUrl: string; model: string }
  }
  roles: { edit: ProviderId; describe: ProviderId; design: DesignProvider }
  budgetTokens: number
  allowedCommands: string[]
  mcpPort: number
  otlpPort: number
  languageServers: boolean
}

type DesignProvider = 'auto' | 'claude-code' | 'codex' | 'gemini' | ProviderId
const DESIGN_LABEL: Record<DesignProvider, string> = {
  auto: 'Auto: the first signed-in agent',
  'claude-code': 'Claude Code (your Claude plan)',
  codex: 'Codex (your ChatGPT plan)',
  gemini: 'Gemini (your Google account)',
  anthropic: 'Claude API (key)',
  openai: 'OpenAI-compatible (key)',
  ollama: 'Ollama (local)'
}

const PROVIDER_LABEL: Record<ProviderId, string> = { anthropic: 'Claude (Anthropic API)', openai: 'OpenAI-compatible', ollama: 'Ollama (local)' }

export function SettingsDialog() {
  const { setModal } = useStore.getState()
  const [s, setS] = useState<Settings | null>(null)
  const [secrets, setSecrets] = useState<{ anthropicKey: boolean; openaiKey: boolean }>({ anthropicKey: false, openaiKey: false })
  const [keys, setKeys] = useState({ anthropicKey: '', openaiKey: '' })
  const [saved, setSaved] = useState(false)
  const [ollamaModels, setOllamaModels] = useState<string[]>([])

  useEffect(() => {
    window.viber.invoke<{ settings: Settings; secrets: typeof secrets }>('settings:get').then((r) => {
      setS(r.settings)
      setSecrets(r.secrets)
    })
    window.viber.invoke<string[]>('settings:ollamaModels').then(setOllamaModels).catch(() => {})
  }, [])
  if (!s) return null

  const save = async (): Promise<void> => {
    await window.viber.invoke('settings:set', s)
    for (const k of ['anthropicKey', 'openaiKey'] as const) if (keys[k]) await window.viber.invoke('settings:secret', k, keys[k])
    useStore.setState({ agent: s.agent })
    setSaved(true)
    setTimeout(() => setModal(null), 500)
  }
  const prov = (patch: Partial<Settings['providers']>): void => setS({ ...s, providers: { ...s.providers, ...patch } })

  return (
    <Dialog title="Settings" onClose={() => setModal(null)} wide>
      <div className="form two-col">
        <section>
          <h4>Agents</h4>
          <label>
            Default agent
            <select value={s.agent} onChange={(e) => setS({ ...s, agent: e.target.value as Settings['agent'] })}>
              <option value="claude-code">Claude Code (CLI, headless)</option>
              <option value="codex">Codex (CLI, headless)</option>
              <option value="gemini">Gemini (CLI, headless)</option>
              <option value="builtin">Viber agent (built-in loop)</option>
              <option value="external">My own agent (Viber watches)</option>
            </select>
          </label>
          <label>
            Claude Code command <span className="muted small">(uses your Claude plan: run "claude" once and /login)</span>
            <input value={s.claudePath} onChange={(e) => setS({ ...s, claudePath: e.target.value })} />
          </label>
          <label>
            Codex command <span className="muted small">(uses your ChatGPT plan: npm i -g @openai/codex, then "codex login")</span>
            <input value={s.codexPath} onChange={(e) => setS({ ...s, codexPath: e.target.value })} />
          </label>
          <label>
            Gemini command <span className="muted small">(uses your Google account: npm i -g @google/gemini-cli, then run "gemini" once)</span>
            <input value={s.geminiPath} onChange={(e) => setS({ ...s, geminiPath: e.target.value })} />
          </label>
          <label>
            Commands agents may run <span className="muted small">(one prefix per line, e.g. npm test, pytest)</span>
            <textarea className="mono" rows={3} value={s.allowedCommands.join('\n')} onChange={(e) => setS({ ...s, allowedCommands: e.target.value.split('\n').map((x) => x.trim()).filter(Boolean) })} />
          </label>
          <label>
            Token budget per task (built-in agent, 0 = none)
            <input type="number" min={0} step={10000} value={s.budgetTokens} onChange={(e) => setS({ ...s, budgetTokens: Number(e.target.value) || 0 })} />
          </label>
          <label className="check-row">
            <input type="checkbox" checked={s.languageServers} onChange={(e) => setS({ ...s, languageServers: e.target.checked })} />
            <span>
              Exact references from language servers <span className="muted small">(TypeScript and Python bundled; Rust and Go when rust-analyzer / gopls are installed. Agents get the type errors their edits introduce. Uses more memory.)</span>
            </span>
          </label>
        </section>
        <section>
          <h4>Models</h4>
          <label>
            Architect (design chat)
            <select value={s.roles.design} onChange={(e) => setS({ ...s, roles: { ...s.roles, design: e.target.value as DesignProvider } })}>
              {(Object.keys(DESIGN_LABEL) as DesignProvider[]).map((p) => (
                <option key={p} value={p}>
                  {DESIGN_LABEL[p]}
                </option>
              ))}
            </select>
          </label>
          <label>
            Editing code (Viber agent)
            <select value={s.roles.edit} onChange={(e) => setS({ ...s, roles: { ...s.roles, edit: e.target.value as ProviderId } })}>
              {(Object.keys(PROVIDER_LABEL) as ProviderId[]).map((p) => (
                <option key={p} value={p}>
                  {PROVIDER_LABEL[p]}
                </option>
              ))}
            </select>
          </label>
          <label>
            Writing box descriptions
            <select value={s.roles.describe} onChange={(e) => setS({ ...s, roles: { ...s.roles, describe: e.target.value as ProviderId } })}>
              {(Object.keys(PROVIDER_LABEL) as ProviderId[]).map((p) => (
                <option key={p} value={p}>
                  {PROVIDER_LABEL[p]}
                </option>
              ))}
            </select>
          </label>
          <div className="provider">
            <strong>Claude</strong>
            <label>
              Model
              <input value={s.providers.anthropic.model} onChange={(e) => prov({ anthropic: { model: e.target.value } })} />
            </label>
            <label>
              API key {secrets.anthropicKey && <span className="ok small"><Check size={11} /> set</span>}
              <input type="password" autoComplete="off" placeholder={secrets.anthropicKey ? '•••••• (leave empty to keep)' : 'sk-ant-… or use ANTHROPIC_API_KEY / ant auth login'} value={keys.anthropicKey} onChange={(e) => setKeys({ ...keys, anthropicKey: e.target.value })} />
            </label>
          </div>
          <div className="provider">
            <strong>Ollama</strong>
            <label>
              Base URL
              <input value={s.providers.ollama.baseUrl} onChange={(e) => prov({ ollama: { ...s.providers.ollama, baseUrl: e.target.value } })} />
            </label>
            <label>
              Model
              <input list="ollama-models" value={s.providers.ollama.model} placeholder="qwen2.5-coder:14b" onChange={(e) => prov({ ollama: { ...s.providers.ollama, model: e.target.value } })} />
              <datalist id="ollama-models">
                {ollamaModels.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
              {ollamaModels.length > 0 && <span className="muted small">Installed: {ollamaModels.join(', ')}</span>}
              {ollamaModels.length === 0 && <span className="muted small">Ollama not reachable at this URL.</span>}
            </label>
          </div>
          <div className="provider">
            <strong>OpenAI-compatible (vLLM, LM Studio, OpenAI)</strong>
            <label>
              Base URL
              <input value={s.providers.openai.baseUrl} onChange={(e) => prov({ openai: { ...s.providers.openai, baseUrl: e.target.value } })} />
            </label>
            <label>
              Model
              <input value={s.providers.openai.model} onChange={(e) => prov({ openai: { ...s.providers.openai, model: e.target.value } })} />
            </label>
            <label>
              API key {secrets.openaiKey && <span className="ok small"><Check size={11} /> set</span>}
              <input type="password" autoComplete="off" value={keys.openaiKey} onChange={(e) => setKeys({ ...keys, openaiKey: e.target.value })} />
            </label>
          </div>
        </section>
      </div>
      <p className="muted small pad-x">Keys are encrypted with your OS keychain and never leave the app's main process.</p>
      <div className="modal-foot">
        <button className="btn" onClick={() => setModal(null)}>
          Cancel
        </button>
        <button className="btn primary" onClick={save}>
          {saved ? <Check size={13} /> : null} Save
        </button>
      </div>
    </Dialog>
  )
}

/** Connect external agents (Claude Code, Cursor, …) to this repo's map over MCP. */
export function AgentsDialog() {
  const { setModal } = useStore.getState()
  const [status, setStatus] = useState<{ mcpUrl: string; otlpPort: number } | null>(null)
  const [done, setDone] = useState<string[]>([])
  useEffect(() => {
    window.viber.invoke<{ mcpUrl: string; otlpPort: number }>('agents:status').then(setStatus)
  }, [])
  const doIt = async (what: string, fn: () => Promise<unknown>): Promise<void> => {
    await fn()
    setDone((d) => [...d, what])
  }
  return (
    <Dialog title="Connect agents" onClose={() => setModal(null)}>
      <div className="form">
        <CodingAgents />
        <h4>Agents you run yourself (Cursor, a terminal…)</h4>
        <p className="small">
          Any MCP-capable agent can use Viber's map tools (overview, boxes, symbols, impact, intent and plan approval). Edits from <em>any</em> agent show up on the map anyway; MCP adds intent, plans and cheaper context.
        </p>
        <div className="mcp-url">
          <Plug size={13} />
          <code>{status?.mcpUrl ?? '…'}</code>
          <button className="icon-btn tiny" onClick={() => status && void navigator.clipboard.writeText(status.mcpUrl)} title="Copy">
            <Copy size={11} />
          </button>
        </div>
        <button className="btn" onClick={() => doIt('mcp', () => window.viber.invoke('agents:writeMcpConfig'))}>
          {done.includes('mcp') ? <Check size={13} /> : <FileText size={13} />} Write .mcp.json in the repo (Claude Code, Cursor)
        </button>
        <button className="btn" onClick={() => doIt('claude', () => window.viber.invoke('agents:writeInstructions', 'CLAUDE.md'))}>
          {done.includes('claude') ? <Check size={13} /> : <FileText size={13} />} Add Viber instructions to CLAUDE.md
        </button>
        <button className="btn" onClick={() => doIt('agents', () => window.viber.invoke('agents:writeInstructions', 'AGENTS.md'))}>
          {done.includes('agents') ? <Check size={13} /> : <FileText size={13} />} Add Viber instructions to AGENTS.md
        </button>
        <p className="muted small">
          Runtime overlay: send traces with <code>OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:{status?.otlpPort ?? 4318}</code> and <code>OTEL_EXPORTER_OTLP_PROTOCOL=http/json</code>. Apps started from the Run panel get the protocol variable automatically.
        </p>
      </div>
      <div className="modal-foot">
        <button className="btn primary" onClick={() => setModal(null)}>
          Done
        </button>
      </div>
    </Dialog>
  )
}

interface CliStatus {
  id: 'claude-code' | 'codex' | 'gemini'
  label: string
  plan: string
  installed: boolean
  signedIn: boolean | null
  install: string
  signIn: string
  signInHint: string
}

/** The coding-agent CLIs on this machine: install, sign in with a plan, test. */
export function CodingAgents() {
  const [list, setList] = useState<CliStatus[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [result, setResult] = useState<Record<string, { ok: boolean; text: string }>>({})
  const [hint, setHint] = useState<Record<string, string>>({})
  const refresh = (): void => void window.viber.invoke<CliStatus[]>('agents:cli').then(setList)
  useEffect(refresh, [])
  // Coming back from the sign-in window: check again.
  useEffect(() => {
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [])
  const run = (c: CliStatus, cmd: string, note: string): void => {
    void window.viber.invoke('agents:openTerminal', cmd)
    setHint((h) => ({ ...h, [c.id]: note }))
  }
  const test = async (c: CliStatus): Promise<void> => {
    setBusy(c.id)
    const r = await window.viber.invoke<{ ok: boolean; text: string }>('agents:test', c.id)
    setResult((x) => ({ ...x, [c.id]: { ok: r.ok, text: r.ok ? 'Connected: it answered.' : r.text.replace(/^NO_AGENT: /, '') } }))
    setBusy(null)
    refresh()
  }
  return (
    <div className="coding-agents">
      <h4>
        Coding agents <span className="muted small">use your existing plan, no API key needed</span>
        <button className="icon-btn tiny" onClick={refresh} title="Check again" aria-label="Check again">
          <RefreshCw size={11} />
        </button>
      </h4>
      {!list && <p className="muted small">Checking…</p>}
      {list?.map((c) => {
        const state = !c.installed ? 'missing' : c.signedIn === false ? 'signed-out' : c.signedIn ? 'ready' : 'unknown'
        return (
          <div key={c.id} className={`agent-row ${state}`}>
            <div className="agent-head">
              <strong>{c.label}</strong>
              <span className="muted small">{c.plan}</span>
              <span className={`agent-state ${state}`}>{state === 'missing' ? 'not installed' : state === 'signed-out' ? 'not signed in' : state === 'ready' ? 'signed in' : 'installed'}</span>
            </div>
            <div className="card-actions">
              {!c.installed && (
                <button className="btn small" onClick={() => run(c, c.install, 'Installing in the window that opened. When it finishes, close it and press Sign in.')}>
                  <Download size={12} /> Install
                </button>
              )}
              {c.installed && (
                <button className={`btn small ${state === 'signed-out' ? 'primary' : ''}`} onClick={() => run(c, c.signIn, c.signInHint)}>
                  <LogIn size={12} /> Sign in
                </button>
              )}
              {c.installed && (
                <button className="btn small" disabled={busy === c.id} onClick={() => void test(c)} title="Send a tiny request to check it works">
                  {busy === c.id ? <Loader2 size={12} className="spin" /> : <Zap size={12} />} Test
                </button>
              )}
            </div>
            {hint[c.id] && <p className="muted small">{hint[c.id]}</p>}
            {result[c.id] && (
              <p className={`small ${result[c.id].ok ? 'ok' : 'bad'}`}>
                {result[c.id].ok ? <Check size={11} /> : <CircleAlert size={11} />} {result[c.id].text}
              </p>
            )}
          </div>
        )
      })}
    </div>
  )
}
