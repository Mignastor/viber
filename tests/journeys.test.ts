import { describe, expect, it } from 'vitest'
import type { ArchModel, ArchNode, Journey } from '../src/shared/model'
import { isJourneyTest, journeyBoxes, journeyBuilt, journeyLanguage, journeyTestPath, journeyTestTask } from '../src/main/journeyPlan'
import { boxTask } from '../src/main/orchestrator'

const node = (id: string, extra: Partial<ArchNode> = {}): ArchNode => ({ id, label: id[0].toUpperCase() + id.slice(1), kind: 'box', purpose: '', files: [], symbols: [], ...extra })

const rsvp: Journey = {
  id: 'rsvp',
  actor: 'actor:member',
  name: 'Member RSVPs',
  steps: [
    { box: 'web', action: 'taps I am coming' },
    { box: 'api', action: 'POST /meetings/42/rsvp' },
    { box: 'meetings', action: 'records the RSVP' },
    { box: 'api', action: 'returns the meeting' }
  ]
}

const model = (nodes: ArchNode[], journeys: Journey[] = [rsvp]): ArchModel => ({
  name: 't',
  nodes,
  edges: [
    { id: 'web-api', source: 'web', target: 'api', kind: 'http', label: '', contract: ['POST /meetings/:id/rsvp'] },
    { id: 'api-meetings', source: 'api', target: 'meetings', kind: 'call', label: '', contract: ['rsvp(memberId, meetingId)'] }
  ],
  journeys
})

describe('journey tests', () => {
  it('lists the boxes a journey crosses once, in order', () => {
    expect(journeyBoxes(rsvp)).toEqual(['web', 'api', 'meetings'])
  })

  it('picks the language from the boxes’ files, else their tech', () => {
    const py = model([node('web', { files: ['web/app.ts'] }), node('api', { files: ['api/main.py', 'api/routes.py'] }), node('meetings', { files: ['meetings/svc.py'] })])
    expect(journeyLanguage(py, rsvp)).toBe('py')
    expect(journeyTestPath(py, rsvp)).toBe('tests/journeys/test_journey_rsvp.py')
    const planned = model([node('web', { tech: 'TypeScript + React' }), node('api', { tech: 'TypeScript + Hono' }), node('meetings', { tech: 'TypeScript' })])
    expect(journeyTestPath(planned, rsvp)).toBe('tests/journeys/rsvp.test.ts')
    expect(journeyLanguage(model([node('web'), node('api'), node('meetings')]), rsvp)).toBeNull()
  })

  it('keeps the test file a journey already has', () => {
    const m = model([node('web'), node('api'), node('meetings')])
    expect(journeyTestPath(m, { ...rsvp, test: 'e2e/rsvp.spec.ts' })).toBe('e2e/rsvp.spec.ts')
  })

  it('is built only when every box on it is built', () => {
    const st = (s: 'planned' | 'built' | 'verified') => ({ spec: { status: s } })
    expect(journeyBuilt(model([node('web', st('built')), node('api', st('verified')), node('meetings', st('planned'))]), rsvp)).toBe(false)
    expect(journeyBuilt(model([node('web', st('built')), node('api', st('verified')), node('meetings', st('built'))]), rsvp)).toBe(true)
    // Boxes found in an existing repo have no status: having code counts as built.
    expect(journeyBuilt(model([node('web', { files: ['a.ts'] }), node('api', { files: ['b.ts'] }), node('meetings', { files: ['c.ts'] })]), rsvp)).toBe(true)
    expect(journeyBuilt(model([node('web'), node('api')]), rsvp)).toBe(false)
  })

  it('recognises journey test files', () => {
    expect(isJourneyTest('tests/journeys/rsvp.test.ts')).toBe(true)
    expect(isJourneyTest('src/rsvp.test.ts')).toBe(false)
    expect(isJourneyTest('e2e/rsvp.spec.ts', model([], [{ ...rsvp, test: 'e2e/rsvp.spec.ts' }]))).toBe(true)
  })

  it('writes a task that plays every step through the contracts, faking no box', () => {
    const m = model([node('web'), node('api'), node('meetings', { paths: ['meetings'] })])
    const task = journeyTestTask(m, rsvp, 'tests/journeys/rsvp.test.ts')
    expect(task.split('\n')[0]).toContain('Member RSVPs')
    expect(task).toContain('3. Meetings (meetings): records the RSVP')
    expect(task).toContain('Web → Api: POST /meetings/:id/rsvp')
    expect(task).toContain('Api → Meetings: rsvp(memberId, meetingId)')
    expect(task).toContain('tests/journeys/rsvp.test.ts')
    expect(task).toMatch(/never fake a box/)
  })

  it('tells box agents their journeys become tests', () => {
    const m = model([node('web'), node('api'), node('meetings')])
    expect(boxTask(m, m.nodes[2])).toMatch(/Journeys through this box \(once all their boxes are built, each becomes an end-to-end test/)
  })
})

describe('failure lines', () => {
  it('puts the error first and drops repeats, headers and timings', async () => {
    const { failureLines } = await import('../src/main/runner')
    const out = ['✔ 1-3. builds messages (0.5ms)', '  ✖ 4. Notifier emails each member (0.8737ms)', '✖ failing tests:', '✖ 4. Notifier emails each member (0.8737ms)', "  AssertionError [ERR_ASSERTION]: Notifier sent no emails"].join('\n')
    expect(failureLines(out)).toEqual(['AssertionError [ERR_ASSERTION]: Notifier sent no emails', '✖ 4. Notifier emails each member'])
  })
})
