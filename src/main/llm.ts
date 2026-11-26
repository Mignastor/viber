import Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'
import { getSecret, getSettings, type ProviderId } from './settings'

// Provider-pluggable model access for the built-in agent and for writing box descriptions.
// Claude goes through the official SDK; Ollama / vLLM / LM Studio / OpenAI go through the
// OpenAI-compatible chat completions endpoint.

export interface ToolSpec {
  name: string
  description: string
  shape: z.ZodRawShape
}

export interface ToolCall {
  id: string
  name: string
  input: unknown
}

export interface TurnResult {
  text: string
  calls: ToolCall[]
  stop: 'end' | 'tools' | 'max_tokens' | 'refusal' | 'other'
  usage: { input: number; output: number; cacheRead: number }
}

export interface AgentProvider {
  readonly id: ProviderId
  readonly model: string
  step(onText?: (delta: string) => void): Promise<TurnResult>
  addToolResults(results: { id: string; content: string; isError?: boolean }[]): void
  addUserText(text: string): void
}

export function jsonSchema(shape: z.ZodRawShape): Record<string, unknown> {
  const s = z.toJSONSchema(z.object(shape)) as Record<string, unknown>
  delete s.$schema
  return s
}

// ── Claude ───────────────────────────────────────────────────────────────────────────────

class ClaudeProvider implements AgentProvider {
  readonly id = 'anthropic' as const
  private messages: Anthropic.Beta.BetaMessageParam[] = []

  constructor(
    private client: Anthropic,
    readonly model: string,
    private system: Anthropic.Beta.BetaTextBlockParam[],
    private tools: Anthropic.Beta.BetaTool[],
    user: string
  ) {
    this.messages.push({ role: 'user', content: user })
  }

  async step(onText?: (delta: string) => void): Promise<TurnResult> {
    for (let attempt = 0; ; attempt++) {
      const stream = this.client.beta.messages.stream({
        model: this.model,
        max_tokens: 64000,
        betas: ['server-side-fallback-2026-07-01'],
        // On a safety decline the API re-runs the turn on a fallback model in the same call.
        fallbacks: 'default',
        output_config: { effort: 'high' },
        system: this.system,
        ...(this.tools.length ? { tools: this.tools } : {}),
        messages: this.messages
      })
      if (onText) stream.on('text', onText)
      let msg: Anthropic.Beta.BetaMessage
      try {
        msg = await stream.finalMessage()
      } catch (err) {
        // Only an unparseable streamed tool input is retried; API errors propagate.
        if (err instanceof Anthropic.APIError || attempt >= 2) throw err
        continue
      }
      const usage = { input: msg.usage.input_tokens + (msg.usage.cache_creation_input_tokens ?? 0), output: msg.usage.output_tokens, cacheRead: msg.usage.cache_read_input_tokens ?? 0 }
      const text = msg.content.map((b) => (b.type === 'text' ? b.text : '')).join('')
      if (msg.stop_reason === 'refusal') return { text, calls: [], stop: 'refusal', usage }
      if (msg.stop_reason === 'pause_turn') {
        this.messages.push({ role: 'assistant', content: msg.content })
        continue
      }
      const calls = msg.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use').map((b) => ({ id: b.id, name: b.name, input: b.input }))
      if (msg.stop_reason === 'max_tokens') return { text, calls: [], stop: 'max_tokens', usage }
      this.messages.push({ role: 'assistant', content: msg.content })
      return { text, calls, stop: calls.length ? 'tools' : 'end', usage }
    }
  }

  addToolResults(results: { id: string; content: string; isError?: boolean }[]): void {
    // All results of one turn go back in a single user message.
    this.messages.push({ role: 'user', content: results.map((r) => ({ type: 'tool_result' as const, tool_use_id: r.id, content: r.content, is_error: r.isError || undefined })) })
  }

  addUserText(text: string): void {
    this.messages.push({ role: 'user', content: text })
  }
}

// ── OpenAI-compatible (Ollama, vLLM, LM Studio, OpenAI) ───────────────────────────────────

interface OaiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[]
  tool_call_id?: string
}

class OpenAICompatProvider implements AgentProvider {
  private messages: OaiMessage[]

  constructor(
    readonly id: 'openai' | 'ollama',
    private baseUrl: string,
    private apiKey: string | undefined,
    readonly model: string,
    system: string,
    private tools: ToolSpec[],
    user: string
  ) {
    this.messages = [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ]
  }

  async step(onText?: (delta: string) => void): Promise<TurnResult> {
    const res = await fetch(this.baseUrl.replace(/\/$/, '') + '/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}) },
      body: JSON.stringify({
        model: this.model,
        messages: this.messages,
        tools: this.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: jsonSchema(t.shape) } })),
        stream: false
      })
    })
    if (!res.ok) throw new Error(`${this.id} ${res.status}: ${(await res.text()).slice(0, 300)}`)
    const j = (await res.json()) as {
      choices: { message: OaiMessage; finish_reason: string }[]
      usage?: { prompt_tokens?: number; completion_tokens?: number }
    }
    const m = j.choices[0].message
    this.messages.push({ role: 'assistant', content: m.content ?? '', tool_calls: m.tool_calls })
    if (m.content && onText) onText(m.content)
    const calls = (m.tool_calls ?? []).map((c) => {
      let input: unknown = {}
      try {
        input = JSON.parse(c.function.arguments || '{}')
      } catch {
        input = { __invalid: c.function.arguments }
      }
      return { id: c.id, name: c.function.name, input }
    })
    const usage = { input: j.usage?.prompt_tokens ?? 0, output: j.usage?.completion_tokens ?? 0, cacheRead: 0 }
    const fr = j.choices[0].finish_reason
    return { text: m.content ?? '', calls, stop: calls.length ? 'tools' : fr === 'length' ? 'max_tokens' : 'end', usage }
  }

  addToolResults(results: { id: string; content: string; isError?: boolean }[]): void {
    for (const r of results) this.messages.push({ role: 'tool', tool_call_id: r.id, content: (r.isError ? 'ERROR: ' : '') + r.content })
  }

  addUserText(text: string): void {
    this.messages.push({ role: 'user', content: text })
  }
}

// ── Factory ──────────────────────────────────────────────────────────────────────────────

export async function createAgentProvider(
  role: 'edit' | 'describe',
  opts: { stableSystem: string; taskSystem: string; tools: ToolSpec[]; user: string; modelOverride?: string; provider?: ProviderId }
): Promise<AgentProvider> {
  const s = await getSettings()
  const pid = opts.provider ?? s.roles[role]
  if (pid === 'anthropic' && !(await getSecret('anthropicKey')) && !process.env.ANTHROPIC_API_KEY)
    throw new Error('NO_AGENT: No Claude API key is set. To use your Claude plan instead, open "Connect agents" (plug icon) and sign in to Claude Code, or pick another model in Settings.')
  if (pid === 'anthropic') {
    const key = await getSecret('anthropicKey')
    // Without a stored key the SDK resolves ANTHROPIC_API_KEY / an `ant auth login` profile itself.
    const client = new Anthropic(key ? { apiKey: key } : {})
    const system: Anthropic.Beta.BetaTextBlockParam[] = [
      // The architecture overview is stable across tasks: cache it as the prompt prefix.
      { type: 'text', text: opts.stableSystem, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: opts.taskSystem }
    ].filter((b) => b.text.trim()) as Anthropic.Beta.BetaTextBlockParam[]
    const tools: Anthropic.Beta.BetaTool[] = opts.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: jsonSchema(t.shape) as Anthropic.Beta.BetaTool.InputSchema,
      eager_input_streaming: true
    }))
    return new ClaudeProvider(client, opts.modelOverride ?? s.providers.anthropic.model, system, tools, opts.user)
  }
  const cfg = pid === 'ollama' ? s.providers.ollama : s.providers.openai
  const key = pid === 'openai' ? await getSecret('openaiKey') : undefined
  if (!cfg.model) throw new Error(`No model configured for ${pid}. Set one in Settings.`)
  return new OpenAICompatProvider(pid, cfg.baseUrl, key, opts.modelOverride ?? cfg.model, opts.stableSystem + '\n\n' + opts.taskSystem, opts.tools, opts.user)
}

/** One-shot completion (no tools), e.g. for box descriptions. */
export async function complete(role: 'edit' | 'describe', system: string, user: string, provider?: ProviderId, onText?: (delta: string) => void): Promise<{ text: string; usage: TurnResult['usage'] }> {
  const p = await createAgentProvider(role, { stableSystem: system, taskSystem: '', tools: [], user, provider })
  const r = await p.step(onText)
  return { text: r.text, usage: r.usage }
}
