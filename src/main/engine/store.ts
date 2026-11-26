import { promises as fs } from 'fs'
import path from 'path'
import YAML from 'yaml'
import type { ArchDefs } from './build'

// `.arch/model.yaml` is the curated, committed source of truth. It stays small and readable:
// box definitions (by path), actors, services, guardrails, per-box rules. Layout is pinned in
// `.arch/layout.json`. Derived data is cached in `.arch/cache/` (ignored via `.arch/.gitignore`).

const HEADER = `# Viber architecture model — curated by you, read by Viber and by agents (via MCP).
# Boxes own path prefixes; files are mapped to the box with the longest matching prefix.
# Actors are the people and systems that use this one; \`reaches\` lists the boxes they touch.
`

export const archDir = (root: string): string => path.join(root, '.arch')
const modelPath = (root: string): string => path.join(archDir(root), 'model.yaml')
const layoutPath = (root: string): string => path.join(archDir(root), 'layout.json')

export async function loadDefs(root: string): Promise<ArchDefs | null> {
  try {
    const doc = YAML.parse(await fs.readFile(modelPath(root), 'utf8')) ?? {}
    return {
      version: 1,
      name: doc.name ?? path.basename(root),
      boxes: (doc.boxes ?? []).map((b: any) => ({ ...b, paths: b.paths ?? [] })),
      actors: doc.actors ?? [],
      services: doc.services ?? [],
      guardrails: doc.guardrails ?? [],
      edges: doc.edges ?? [],
      journeys: doc.journeys ?? [],
      style: doc.style,
      dismissed: doc.dismissed ?? []
    }
  } catch {
    return null
  }
}

/** Drop empty/undefined fields so the YAML stays tidy and diffs stay small. */
function tidy<T extends object>(o: T): T {
  const out: any = {}
  for (const [k, v] of Object.entries(o)) {
    if (v === undefined || v === null || (Array.isArray(v) && v.length === 0) || v === '') continue
    out[k] = v
  }
  return out
}

export async function saveDefs(root: string, defs: ArchDefs): Promise<void> {
  await fs.mkdir(archDir(root), { recursive: true })
  await fs.writeFile(path.join(archDir(root), '.gitignore'), 'cache/\n').catch(() => {})
  const doc = {
    version: 1,
    name: defs.name,
    boxes: defs.boxes.map((b) => tidy({ id: b.id, label: b.label, parent: b.parent, paths: b.paths, tech: b.tech, purpose: b.purpose, rules: b.rules, spec: b.spec && Object.keys(b.spec).length ? b.spec : undefined })),
    actors: defs.actors.map((a) => tidy({ ...a })),
    services: defs.services.map((s) => tidy({ ...s })),
    guardrails: defs.guardrails.map((g) => tidy({ ...g })),
    edges: (defs.edges ?? []).map((e) => tidy({ ...e })),
    journeys: (defs.journeys ?? []).map((j) => tidy({ ...j })),
    style: defs.style,
    dismissed: defs.dismissed
  }
  await fs.writeFile(modelPath(root), HEADER + YAML.stringify(tidy(doc), { lineWidth: 110 }))
}

export type PinnedLayout = Record<string, Record<string, { x: number; y: number; w: number; h: number }>>

export async function loadLayout(root: string): Promise<PinnedLayout> {
  try {
    return JSON.parse(await fs.readFile(layoutPath(root), 'utf8'))
  } catch {
    return {}
  }
}

export async function saveLayout(root: string, layout: PinnedLayout): Promise<void> {
  await fs.mkdir(archDir(root), { recursive: true })
  await fs.writeFile(layoutPath(root), JSON.stringify(layout))
}
