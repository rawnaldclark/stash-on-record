import { lazy, Suspense, useCallback, useEffect, useState } from 'react'
import type { LoadResult } from '../types'
import { loadFromStash, onStash, tellStash } from './embed'

/*
 * The app inside Stash: no landing page and no drop zone. The plays are already in the player's archive, so this opens straight
 * on the record; with no import yet, one button asks the player to open its import sheet. The player says when an import
 * changed the archive (`stash:reload`) and which theme it shows (`stash:theme`).
 */

/**
 * `?demo=1` presses On Record's seeded sample instead of the archive: for screenshots and checks in a browser with no import.
 * Nothing is read or written, and the sample is made on the spot, so it is harmless in any build.
 */
const DEMO = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('demo') === '1'

const Dashboard = lazy(() => import('../components/Dashboard').then((m) => ({ default: m.Dashboard })))

type State = { status: 'loading' } | { status: 'empty' } | { status: 'error' } | { status: 'ready'; result: LoadResult; n: number }

export default function EmbedApp() {
  const [state, setState] = useState<State>({ status: 'loading' })

  const load = useCallback(async () => {
    try {
      const result = DEMO ? (await import('../data/load')).loadSample() : await loadFromStash()
      setState((s) => (result.plays.length ? { status: 'ready', result, n: s.status === 'ready' ? s.n + 1 : 0 } : { status: 'empty' }))
      tellStash({ type: 'stash:ready', plays: result.plays.length })
    } catch {
      setState({ status: 'error' })
      // the player's cover goes now, not after its wait: this page says what went wrong
      tellStash({ type: 'stash:ready', plays: 0 })
    }
  }, [])

  useEffect(() => {
    // The read is the external system here: its answer arrives after the effect, never inside it
    void Promise.resolve().then(load)
    return onStash((m) => {
      if (m.type === 'stash:reload') void load()
      else if (m.type === 'stash:theme') document.documentElement.dataset.theme = m.theme
    })
  }, [load])

  // "New data" in the record: a newer export comes in through Stash's sheet, which merges it
  const bringNewer = () => tellStash({ type: 'stash:import' })

  if (state.status === 'ready') {
    return (
      <Suspense fallback={<Pressing />}>
        {/* A new key per reload: the record starts over on the new plays, as it does after New data */}
        <Dashboard key={state.n} result={state.result} isSample={DEMO} onReset={bringNewer} />
      </Suspense>
    )
  }
  if (state.status === 'loading') return <Pressing />
  return (
    <div className="pressing" role="status">
      <div className="pressing__record" aria-hidden="true" />
      <p>{state.status === 'error' ? 'Your record couldn’t be read in this window.' : 'Bring your Spotify history, and it’s pressed into a record here.'}</p>
      {state.status === 'empty' && (
        <button type="button" className="button" onClick={bringNewer}>
          Bring your Spotify
        </button>
      )}
    </div>
  )
}

function Pressing() {
  return (
    <div className="pressing" role="status">
      <div className="pressing__record" aria-hidden="true" />
      <p>
        Pressing your <em>record</em>…
      </p>
    </div>
  )
}
