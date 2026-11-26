export {}

declare global {
  interface Window {
    viber: {
      platform: string
      invoke: <T = unknown>(channel: string, ...args: unknown[]) => Promise<T>
      on: (event: string, cb: (payload: any) => void) => () => void
      pathForFile: (file: File) => string
    }
  }
}
