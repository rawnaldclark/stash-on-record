import { tellStash } from './embed'

/*
 * The way back to Stash from the record held full screen on a phone (the player opens it over everything there, so the deck has
 * a whole screen, as On Record is made for). The back gesture does the same, on the player's side.
 */
export function StashClose() {
  return (
    <button type="button" className="stash-close" aria-label="Close your record, back to Stash" onClick={() => tellStash({ type: 'stash:close' })}>
      <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
        <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
      </svg>
    </button>
  )
}
