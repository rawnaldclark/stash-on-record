// On Record inside the Stash player (embed.html): Stash's look over On Record's layout, and the record built from Stash's archive.
// On Record's faces stay for what it draws on canvas and in its covers: the record, the posters, the race video
import '@fontsource-variable/bricolage-grotesque/index.css'
import '@fontsource-variable/jetbrains-mono/index.css'
import '@fontsource/instrument-serif/400-italic.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './stash/theme.css'
import EmbedApp from './stash/EmbedApp'
import { EMBEDDED } from './stash/embed'
import { keepNoHistory } from './stash/history'

if (EMBEDDED) {
  keepNoHistory()
  // A file dropped on the record would open in the frame in its place: the player's import sheet is where files go
  for (const t of ['dragover', 'drop'] as const) window.addEventListener(t, (e) => e.preventDefault())
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <EmbedApp />
  </StrictMode>,
)
