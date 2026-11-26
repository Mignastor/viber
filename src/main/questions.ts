import { promises as fs } from 'fs'
import path from 'path'
import type { Question } from '@shared/model'
import { ctx } from './context'
import { archDir } from './engine/store'

// Questions from agents to the human, pinned on a box or edge. An agent can block on the answer
// (ask_human); answers can become rules on the box, so the same question is never asked twice.

const file = (root: string): string => path.join(archDir(root), 'questions.json')
const waiters = new Map<string, (answer: string) => void>()

export async function listQuestions(): Promise<Question[]> {
  const ws = ctx.ws
  if (!ws) return []
  try {
    return JSON.parse(await fs.readFile(file(ws.root), 'utf8'))
  } catch {
    return []
  }
}

async function save(list: Question[]): Promise<void> {
  const ws = ctx.requireWs()
  await fs.mkdir(archDir(ws.root), { recursive: true })
  await fs.writeFile(file(ws.root), JSON.stringify(list, null, 1))
  ctx.emit('questions:list', list)
}

export async function askQuestion(q: Omit<Question, 'id' | 'createdAt'>, waitMs = 0): Promise<{ question: Question; answer?: string }> {
  const list = await listQuestions()
  const question: Question = { ...q, id: Math.random().toString(36).slice(2, 9), createdAt: Date.now() }
  list.push(question)
  await save(list)
  if (q.sessionId) ctx.sessions?.push(q.sessionId, { t: 'message', role: 'system', text: `Question for you${q.anchor ? ` on ${q.anchor}` : ''}: ${q.text}`, tokens: 0, naive: 0 })
  if (!waitMs) return { question }
  const answer = await new Promise<string | undefined>((resolve) => {
    const t = setTimeout(() => {
      waiters.delete(question.id)
      resolve(undefined)
    }, waitMs)
    waiters.set(question.id, (a) => {
      clearTimeout(t)
      resolve(a)
    })
  })
  return { question, answer }
}

export async function answerQuestion(id: string, answer: string, asRule: boolean): Promise<void> {
  const list = await listQuestions()
  const q = list.find((x) => x.id === id)
  if (!q) return
  q.answer = answer
  q.answeredAt = Date.now()
  q.asRule = asRule
  await save(list)
  waiters.get(id)?.(answer)
  waiters.delete(id)
  if (q.sessionId) ctx.sessions?.settleGate(q.sessionId, `question:${id}`, answer)
  const ws = ctx.ws
  if (asRule && ws && q.anchor && ws.defs.boxes.some((b) => b.id === q.anchor)) {
    const box = ws.defs.boxes.find((b) => b.id === q.anchor)!
    await ws.apply({ op: 'setRules', id: box.id, rules: [...(box.rules ?? []), `${q.text.replace(/\?$/, '')}: ${answer}`] })
  }
  if (q.sessionId) ctx.sessions?.push(q.sessionId, { t: 'message', role: 'user', text: `Answered “${q.text}”: ${answer}`, tokens: 0, naive: 0 })
}

export async function dismissQuestion(id: string): Promise<void> {
  const list = (await listQuestions()).filter((q) => q.id !== id)
  waiters.get(id)?.('(dismissed by the user: decide yourself and record the decision)')
  waiters.delete(id)
  const dq = list.find((x) => x.id === id)
  if (dq?.sessionId) ctx.sessions?.settleGate(dq.sessionId, `question:${id}`, '(dismissed by the user: decide yourself and record the decision)')
  await save(list)
}
