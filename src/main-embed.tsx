// On Record inside the Stash player (embed.html): Stash's look over On Record's layout, and the record built from Stash's archive.
// On Record's faces stay for what it draws on canvas and in its covers: the record, the posters, the race video
import '@fontsource-variable/bricolage-grotesque/index.css'
import '@fontsource-variable/jetbrains-mono/index.css'
import '@fontsource/instrument-serif/400-italic.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './stash/theme.css'
import { listenForBack } from './stash/app'
import EmbedApp from './stash/EmbedApp'
import { APP_HOST, EMBEDDED, tellStash } from './stash/embed'
import { keepNoHistory } from './stash/history'

if (EMBEDDED) {
  keepNoHistory()
  // A file dropped on the record would open in the frame in its place: the player's import sheet is where files go
  for (const t of ['dragover', 'drop'] as const) window.addEventListener(t, (e) => e.preventDefault())
  // Escape with nothing of the record's open (its sheets and menus take theirs first) closes the record held full screen on a
  // phone: the player ignores it otherwise
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !e.defaultPrevented && !document.querySelector('dialog[open], [aria-expanded="true"]')) tellStash({ type: 'stash:close' })
  })
  // In the app, its back gesture: what's open over the record first, then the record (app.ts)
  if (APP_HOST) listenForBack()
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <EmbedApp />
  </StrictMode>,
)
