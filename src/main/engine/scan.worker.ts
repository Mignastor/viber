import { parentPort } from 'worker_threads'
import { scanPaths, scanRepo } from './scan'

// Parsing runs here so a pathological file or grammar can never freeze or crash the app window.

type Msg = { id: number; type: 'scan'; root: string } | { id: number; type: 'paths'; root: string; paths: string[] }

parentPort!.on('message', async (m: Msg) => {
  try {
    if (m.type === 'scan') {
      const result = await scanRepo(m.root, (p) => parentPort!.postMessage({ id: m.id, progress: p }))
      parentPort!.postMessage({ id: m.id, result })
    } else {
      parentPort!.postMessage({ id: m.id, result: await scanPaths(m.root, m.paths) })
    }
  } catch (err) {
    parentPort!.postMessage({ id: m.id, error: String((err as Error)?.stack ?? err) })
  }
})
