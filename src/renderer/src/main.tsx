import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@xyflow/react/dist/style.css'
import './theme.css'
import './styles.css'
import './styles-app.css'
import './styles-live.css'
import './styles-design.css'
import './monaco'
import { initTheme } from './theme'

initTheme()
import { App } from './App'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
