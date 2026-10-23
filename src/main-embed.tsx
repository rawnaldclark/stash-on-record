// On Record inside the Stash player (embed.html): Stash's look over On Record's layout, and the record built from Stash's archive.
import '@fontsource-variable/jetbrains-mono/index.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './stash/theme.css'
import EmbedApp from './stash/EmbedApp'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <EmbedApp />
  </StrictMode>,
)
