import { describe, expect, it } from 'vitest'
import { syntaxErrors } from '../src/main/engine/scan'

describe('syntax guard', () => {
  it('finds parse errors and where they are', async () => {
    expect(await syntaxErrors('a.py', 'def f(x):\n    return x + 1\n')).toEqual([])
    const bad = await syntaxErrors('a.py', 'def f(x):\n    return (x + 1\n\ndef g():\n    pass\n')
    expect(bad?.length).toBeGreaterThan(0)
    expect((await syntaxErrors('a.ts', 'export function f(a: number) { return a }\n'))?.length).toBe(0)
    expect((await syntaxErrors('a.ts', 'export function f(a: number) { return a \n'))?.length).toBeGreaterThan(0)
    expect(await syntaxErrors('README.md', '# hi')).toBeNull()
  })
  it('refuses a write that breaks a file, but not repairs of a broken one', async () => {
    const { syntaxGuard } = await import('../src/main/tools')
    const ok = 'def f():\n    return 1\n'
    const broken = 'def f(:\n    return 1\n'
    expect(await syntaxGuard('m.py', ok, broken)).toMatch(/Not written: m\.py would not parse/)
    expect(await syntaxGuard('m.py', ok, ok.replace('1', '2'))).toBeNull()
    expect(await syntaxGuard('m.py', broken, broken + '\n')).toBeNull()
    expect(await syntaxGuard('new.py', null, broken)).toMatch(/Not written/)
  })
})

describe('stale context', () => {
  it('tells a session when a file it read was changed by someone else, once', async () => {
    const { mkdtempSync, writeFileSync, utimesSync } = await import('fs')
    const { tmpdir } = await import('os')
    const path = await import('path')
    const { track, staleFor } = await import('../src/main/tools')
    const dir = mkdtempSync(path.join(tmpdir(), 'viber-stale-'))
    const f = path.join(dir, 'a.py')
    writeFileSync(f, 'x = 1\n')
    await track('s1', f)
    expect(await staleFor('s1', dir)).toEqual([])
    writeFileSync(f, 'x = 2\n')
    utimesSync(f, new Date(), new Date(Date.now() + 5000))
    expect(await staleFor('s1', dir)).toEqual(['a.py'])
    expect(await staleFor('s1', dir)).toEqual([]) // reported once
    expect(await staleFor('other', dir)).toEqual([]) // only sessions that read it
  })
})

describe('human gates', () => {
  it('keeps an answer that arrives between waiting rounds, and refuses late ones', async () => {
    const { SessionManager, Session } = await import('../src/main/sessions')
    const sm = new SessionManager({ root: '.' } as never)
    const s = new Session({ id: 's1', title: 't', agent: 'claude-code', status: 'running', cwd: '.', scope: [], color: '#fff', startedAt: 0, tokens: { input: 0, output: 0, cacheRead: 0 } } as never)
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set('s1', s)
    sm.openGate('s1', 'plan', 'your plan')
    expect(s.info.status).toBe('waiting')
    expect(await sm.waitGate('s1', 'plan', 30)).toBeUndefined() // a round ends with no answer: the gate stays open
    expect(sm.decidePlan('s1', false, 'smaller please')).toBe(true) // answered while nobody waits
    expect(await sm.waitGate('s1', 'plan', 30)).toEqual({ approved: false, feedback: 'smaller please' })
    expect(s.info.status).toBe('running')
    expect(sm.decidePlan('s1', true)).toBe(false) // nothing waiting any more
    sm.openGate('s1', 'plan', 'x')
    s.info.status = 'done'
    expect(sm.decidePlan('s1', true)).toBe(false) // ended sessions refuse decisions
  })
})
