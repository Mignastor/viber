import type { ArchModel, ArchNode } from './model'

// Which language a box should be written in, when only agents write the code. Boxes talk through
// contracts, so each one can use what fits its job: what agents write most reliably, what checks their
// work (types, compiler), what costs the fewest tokens, and where the code has to run.

export type BoxRole = 'ui' | 'ai' | 'compute' | 'worker' | 'cli' | 'api'

export interface TechAdvice {
  role: BoxRole
  tech: string
  reason: string
}

const ROLE_WORDS: [BoxRole, RegExp][] = [
  ['ui', /\b(ui|page|pages|screen|dashboard|frontend|front-end|client|form|forms|view|views|web app|website|interface|widget|component library)\b/i],
  ['ai', /\b(llm|ai|ml|machine learning|model inference|embedding|embeddings|chat ?bot|classif\w*|predict\w*|recommend\w*|vision|speech|transcri\w*|nlp|rag|prompt\w*)\b/i],
  ['compute', /\b(simulat\w*|optimi[sz]\w*|render\w*|image processing|video|audio|codec|physics|real-?time|high[- ]performance|compress\w*|solver|path ?finding|signal processing|cryptograph\w*|number crunching|game engine)\b/i],
  ['worker', /\b(worker|background|job|jobs|queue|cron|scheduled|batch|consumer|ingest\w*|pipeline)\b/i],
  ['cli', /\b(cli|command[- ]line|terminal tool)\b/i]
]

/** What kind of component a box is, from its spec, contract and who uses it. */
export function boxRole(n: ArchNode, model: ArchModel): BoxRole {
  const text = [n.label, n.purpose, n.spec?.responsibility, ...(n.spec?.contract ?? []).map((c) => `${c.name} ${c.note ?? ''}`)].filter(Boolean).join(' ')
  const facesPeople = model.edges.some((e) => e.target === n.id && e.kind === 'uses' && ['user', 'admin'].includes(model.nodes.find((a) => a.id === e.source)?.actorType ?? ''))
  for (const [role, re] of ROLE_WORDS) if (re.test(text)) return role === 'worker' && facesPeople ? 'ui' : role
  if (facesPeople && !(n.spec?.contract ?? []).some((c) => c.kind === 'http' && /\/api\//.test(c.name))) return 'ui'
  if ((n.spec?.contract ?? []).some((c) => c.kind === 'event' || c.kind === 'queue') && !(n.spec?.contract ?? []).some((c) => c.kind === 'http')) return 'worker'
  return 'api'
}

type Lang = 'typescript' | 'python' | 'go' | 'rust'

const langOfTech = (tech: string): Lang | null =>
  /rust|axum|actix|tokio/i.test(tech) ? 'rust' : /\bgo\b|golang|gin|echo|fiber|chi/i.test(tech) ? 'go' : /python|fastapi|django|flask|streamlit/i.test(tech) ? 'python' : /typescript|javascript|node|express|hono|nest|next|react|vue|svelte|angular|vite|deno|bun/i.test(tech) ? 'typescript' : null

/** The language the project's non-UI boxes already use most (one backend language keeps deploys simple). */
function backendLanguage(model: ArchModel, except: string): Lang | null {
  const votes = new Map<Lang, number>()
  for (const b of model.nodes) {
    if (b.kind !== 'box' || b.id === except || boxRole(b, model) === 'ui' || boxRole(b, model) === 'compute') continue
    const l = langOfTech(`${b.tech ?? ''} ${b.stats?.lang ?? ''}`)
    if (l) votes.set(l, (votes.get(l) ?? 0) + (b.stats?.lines ?? 100))
  }
  return [...votes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
}

const STACK: Record<Lang, string> = { typescript: 'TypeScript (Node + Hono)', python: 'Python (FastAPI)', go: 'Go', rust: 'Rust' }

export function recommendTech(n: ArchNode, model: ArchModel): TechAdvice {
  const role = boxRole(n, model)
  const backend = backendLanguage(model, n.id)
  const hasAi = model.nodes.some((b) => b.kind === 'box' && b.id !== n.id && boxRole(b, model) === 'ai')
  switch (role) {
    case 'ui': {
      const existing = model.nodes.find((b) => b.kind === 'box' && b.id !== n.id && boxRole(b, model) === 'ui' && b.tech)?.tech
      if (existing && /vue|svelte|angular|solid/i.test(existing)) return { role, tech: existing, reason: 'Same UI framework as the rest of the frontend.' }
      return { role, tech: 'TypeScript + React', reason: 'Browsers run JavaScript; agents write TypeScript most reliably, and its type checker catches their mistakes before you see them.' }
    }
    case 'ai':
      return { role, tech: 'Python (FastAPI)', reason: 'The AI and data libraries live in Python; agents know them best there.' }
    case 'compute':
      return { role, tech: 'Rust', reason: 'CPU-heavy work: Rust is fast, and its compiler rejects agent mistakes before they run. Worth the extra tokens here; the rest of the system reaches it through its contract.' }
    case 'cli':
      return backend ? { role, tech: STACK[backend], reason: 'Same language as the backend it drives.' } : { role, tech: 'Go', reason: 'One small binary that starts instantly; Go is simple for agents and compiles fast.' }
    default: {
      if (backend) return { role, tech: STACK[backend], reason: 'Same language as the rest of the backend: one runtime, shared types, simpler deploys.' }
      if (hasAi) return { role, tech: 'Python (FastAPI)', reason: 'The AI boxes are Python; keeping one backend language avoids a second runtime.' }
      return { role, tech: 'TypeScript (Node + Hono)', reason: 'Shares types with the UI across the contract, and agents write TypeScript most reliably; strict types check their work.' }
    }
  }
}

/** One line for the architect's prompt: the defaults it should follow. */
export const TECH_GUIDE =
  'Pick each box\'s "tech" for agents, not humans: UI → TypeScript + React; API, workers and business logic → the language the backend already uses, else TypeScript (Node + Hono), or Python (FastAPI) when the system has AI boxes; AI / data → Python; CPU-heavy compute (simulation, image/video, real-time, solvers) → Rust; CLI → the backend language, else Go. Say in one short phrase why when it is not obvious.'
