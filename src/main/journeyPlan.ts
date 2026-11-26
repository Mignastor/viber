import type { ArchModel, Journey } from '@shared/model'

// Pure helpers for journey tests: which boxes a journey crosses, where its test goes, and the task
// an agent gets to write it. No Electron or workspace state, so they are easy to test.

export const JOURNEY_TEST_DIR = 'tests/journeys'

const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'journey'

/** Boxes a journey passes through, in order of first appearance. */
export function journeyBoxes(j: Journey): string[] {
  return [...new Set(j.steps.map((s) => s.box))]
}

/** Journey tests belong to no box: they are never new-box candidates. */
export function isJourneyTest(rel: string, model?: { journeys?: Journey[] }): boolean {
  return rel.startsWith(JOURNEY_TEST_DIR + '/') || !!model?.journeys?.some((j) => j.test === rel)
}

type Lang = 'py' | 'ts' | 'js' | 'go'

/** The language the journey's code is mostly written in: its boxes' files, else their tech. */
export function journeyLanguage(model: ArchModel, j: Journey): Lang | null {
  const votes: Record<Lang, number> = { py: 0, ts: 0, js: 0, go: 0 }
  const boxes = journeyBoxes(j).map((id) => model.nodes.find((n) => n.id === id)).filter((n) => !!n)
  for (const n of boxes) {
    for (const f of n.files) {
      if (f.endsWith('.py')) votes.py++
      else if (/\.(ts|tsx|vue|svelte)$/.test(f)) votes.ts++
      else if (/\.(js|jsx|mjs|cjs)$/.test(f)) votes.js++
      else if (f.endsWith('.go')) votes.go++
    }
    const tech = (n.tech ?? '').toLowerCase()
    if (!n.files.length && tech) {
      if (tech.includes('python')) votes.py++
      else if (tech.includes('typescript')) votes.ts++
      else if (tech.includes('javascript') || tech.includes('node')) votes.js++
      else if (/\bgo\b|golang/.test(tech)) votes.go++
    }
  }
  const best = (Object.entries(votes) as [Lang, number][]).sort((a, b) => b[1] - a[1])[0]
  return best[1] > 0 ? best[0] : null
}

/** Where a journey's test goes: the file it already has, else tests/journeys/ in the journey's language. */
export function journeyTestPath(model: ArchModel, j: Journey): string | null {
  if (j.test) return j.test
  const name = slug(j.id)
  switch (journeyLanguage(model, j)) {
    case 'py':
      return `${JOURNEY_TEST_DIR}/test_journey_${name.replace(/-/g, '_')}.py`
    case 'ts':
      return `${JOURNEY_TEST_DIR}/${name}.test.ts`
    case 'js':
      return `${JOURNEY_TEST_DIR}/${name}.test.js`
    case 'go':
      return `${JOURNEY_TEST_DIR}/${name.replace(/-/g, '_')}_test.go`
    default:
      return null
  }
}

/** True when every box the journey passes through has been built. */
export function journeyBuilt(model: ArchModel, j: Journey): boolean {
  const boxes = journeyBoxes(j)
  return (
    boxes.length > 0 &&
    boxes.every((id) => {
      const n = model.nodes.find((x) => x.id === id)
      if (!n) return false
      const st = n.spec?.status
      return st ? st === 'built' || st === 'verified' : n.files.length > 0
    })
  )
}

/** The task an agent gets to turn a journey into an end-to-end test on the real code. */
export function journeyTestTask(model: ArchModel, j: Journey, file: string): string {
  const label = (id: string): string => model.nodes.find((n) => n.id === id)?.label ?? id
  const actor = label(j.actor)
  const contracts: string[] = []
  for (let i = 1; i < j.steps.length; i++) {
    const a = j.steps[i - 1].box
    const b = j.steps[i].box
    if (a === b) continue
    const e = model.edges.find((x) => (x.source === a && x.target === b) || (x.source === b && x.target === a))
    if (e?.contract.length) contracts.push(`- ${label(e.source)} → ${label(e.target)}: ${e.contract.join(', ')}`)
  }
  const entry = model.nodes.find((n) => n.id === j.steps[0]?.box)
  const where = (id: string): string => {
    const n = model.nodes.find((x) => x.id === id)
    return n?.paths?.length ? ` (${n.paths.join(', ')})` : n?.files.length ? ` (${n.files.slice(0, 3).join(', ')})` : ''
  }
  return [
    `Write the end-to-end test for the journey "${j.name}" (${actor}).`,
    `The journey, as the human designed it:\n${j.steps.map((s, i) => `${i + 1}. ${label(s.box)}${where(s.box)}: ${s.action}`).join('\n')}`,
    contracts.length ? `Contracts it crosses:\n${contracts.join('\n')}` : '',
    `Write one test file at ${file}. It plays the journey as ${actor} would: start at ${entry ? label(entry.id) : 'the first box'}'s front door (its contract), go through the real code of each box in order, and check what each step promises (stored data, the reply, what the actor sees). Fake only what lives outside the system (external services, clocks, email); never fake a box the journey passes through. Name each check after its journey step so a failure says which step broke.`,
    `Use the test framework the repo already uses. Do not change the boxes' code: if the journey cannot pass without a change, leave the test failing and explain why with ask_human. Run the test once to make sure it runs.`
  ]
    .filter(Boolean)
    .join('\n\n')
}
