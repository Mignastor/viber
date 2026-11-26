import { contextBridge, ipcRenderer, webUtils } from 'electron'

// A deliberately small surface: invoke a named handler, or subscribe to a named event.
contextBridge.exposeInMainWorld('viber', {
  platform: process.platform,
  invoke: (channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args),
  on: (event: string, cb: (payload: unknown) => void) => {
    const listener = (_e: unknown, payload: unknown): void => cb(payload)
    ipcRenderer.on(event, listener)
    return () => ipcRenderer.removeListener(event, listener)
  },
  pathForFile: (file: File) => webUtils.getPathForFile(file)
})
