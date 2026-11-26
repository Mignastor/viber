import { ipcRenderer, webFrame } from 'electron'

// Preview window helper. Alt+click an element: we walk React's fiber tree (dev builds) from the
// clicked DOM node to collect the names of the components that rendered it, nearest first, and
// send them to Viber, which maps them to a box. Runs in the page's main world via executeJavaScript
// because fibers are not visible from the isolated preload world.

const probe = `(() => {
  if (window.__viberProbe) return
  window.__viberProbe = true
  document.addEventListener('click', (e) => {
    if (!e.altKey) return
    e.preventDefault(); e.stopPropagation()
    const el = e.target
    const names = []
    const key = Object.keys(el).find((k) => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance'))
    let f = key ? el[key] : null
    while (f && names.length < 12) {
      const t = f.type
      const n = t && (t.displayName || t.name)
      if (typeof t === 'function' && n && !names.includes(n)) names.push(n)
      f = f.return
    }
    // Vue 3 dev builds
    let v = el.__vueParentComponent
    while (v && names.length < 12) { const n = v.type && (v.type.name || v.type.__name); if (n) names.push(n); v = v.parent }
    window.postMessage({ __viberPick: { components: names, text: (el.innerText || '').slice(0, 80) } }, '*')
  }, true)
})()`

window.addEventListener('message', (e) => {
  const d = (e.data as { __viberPick?: unknown })?.__viberPick
  if (d) ipcRenderer.send('preview:pick', d)
})

window.addEventListener('DOMContentLoaded', () => {
  void webFrame.executeJavaScript(probe)
})
