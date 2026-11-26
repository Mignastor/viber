import type { DefsOp } from '@shared/api'
import { useStore } from './store'

// The architect conversation lives in the store, not in a panel: any input (the prompt bar in Design
// mode, "fix these gaps", a described journey) can ask, and switching tabs never loses an answer.

export interface ArchTurn {
  role: 'user' | 'assistant'
  text: string
  ops?: DefsOp[]
  status?: 'previewing' | 'accepted' | 'rejected'
}

const cleanError = (e: unknown): string => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

/** Send a message to the architect; its proposal is previewed on the map. Shows the Design tab. */
export async function askArchitect(message: string): Promise<void> {
  const msg = message.trim()
  const st = useStore.getState()
  if (!msg || st.archBusy) return
  const turns = [...st.archTurns, { role: 'user' as const, text: msg }]
  useStore.setState({ archTurns: turns, archBusy: true, archError: null, leftTab: 'design' })
  try {
    const r = await window.viber.invoke<{ reply: string; ops: DefsOp[] }>(
      'design:architect',
      turns.map((t) => ({ role: t.role, text: t.text }))
    )
    const turn: ArchTurn = { role: 'assistant', text: r.reply || '(no reply)', ops: r.ops, status: r.ops.length ? 'previewing' : undefined }
    // A new proposal replaces one still waiting for a decision.
    useStore.setState((s) => ({ archTurns: [...s.archTurns.map((x) => (x.status === 'previewing' ? { ...x, status: 'rejected' as const } : x)), turn] }))
    if (r.ops.length) {
      const m = await window.viber.invoke('design:preview', r.ops)
      useStore.setState({ preview: m ? { model: m as never, ops: r.ops } : null })
    }
  } catch (e) {
    useStore.setState({ archError: cleanError(e) })
  } finally {
    useStore.setState({ archBusy: false })
  }
}

/** Accept or reject the architect's proposal number i. */
export async function decideProposal(i: number, accept: boolean): Promise<void> {
  const t = useStore.getState().archTurns[i]
  if (accept && t?.ops?.length) await window.viber.invoke('ws:apply', { op: 'batch', ops: t.ops })
  useStore.setState((s) => ({ preview: null, archTurns: s.archTurns.map((x, j) => (j === i ? { ...x, status: accept ? 'accepted' : 'rejected' } : x)) }))
}
