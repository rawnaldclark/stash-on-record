import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import type { LoadResult, Play } from '../types'
import { countSources, loadFromStash, onStash, stack, tellStash, type LivePlay, type Source } from './embed'

/*
 * The app inside Stash: no landing page and no drop zone. The plays are already in the player's archive (the Spotify export and
 * Last.fm scrobbles), and the player sends its own (`stash:live`), so this opens straight on the record, every source stacked
 * with a listen counted once; the player's switches pick which sources it shows (`stash:sources`). With nothing at all yet, one
 * button asks the player to open its import sheet. The player says when an import changed the archive (`stash:reload`) and
 * which theme it shows (`stash:theme`).
 */

/**
 * `?demo=1` presses On Record's seeded sample instead of the archive: for screenshots and checks in a browser with no import.
 * Nothing is read or written, and the sample is made on the spot, so it is harmless in any build.
 */
const DEMO = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('demo') === '1'

const Dashboard = lazy(() => import('../components/Dashboard').then((m) => ({ default: m.Dashboard })))

const ALL: Record<Source, boolean> = { spotify: true, stash: true, lastfm: true }

type Archive = { status: 'loading' } | { status: 'error' } | { status: 'ready'; result: LoadResult }

export default function EmbedApp() {
  const [archive, setArchive] = useState<Archive>({ status: 'loading' })
  const [live, setLive] = useState<LivePlay[]>([])
  const [on, setOn] = useState<Record<Source, boolean>>(ALL)
  // A new record per change of what it's made of: it starts over on the new plays, as it does after New data
  const [n, setN] = useState(0)

  const load = useCallback(async () => {
    try {
      const result = DEMO ? (await import('../data/load')).loadSample() : await loadFromStash()
      setArchive({ status: 'ready', result })
      setN((x) => x + 1)
    } catch {
      setArchive({ status: 'error' })
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
      else if (m.type === 'stash:live' && Array.isArray(m.plays)) {
        setLive(m.plays.filter(validLive))
        setN((x) => x + 1)
      } else if (m.type === 'stash:sources' && m.on && typeof m.on === 'object') {
        setOn({ spotify: m.on.spotify !== false, stash: m.on.stash !== false, lastfm: m.on.lastfm !== false })
        setN((x) => x + 1)
      }
    })
  }, [load])

  const result = useMemo<LoadResult | null>(() => {
    if (archive.status !== 'ready') return null
    const plays: Play[] = DEMO ? archive.result.plays : stack(archive.result.plays, live, on)
    return { ...archive.result, plays }
  }, [archive, live, on])

  // The player shows a switch for each source there is, and its cover goes once the record knows what it has
  useEffect(() => {
    if (archive.status !== 'ready') return
    tellStash({ type: 'stash:counts', counts: countSources(archive.result.plays, live) })
    tellStash({ type: 'stash:ready', plays: result?.plays.length ?? 0 })
  }, [archive, live, result])

  // "New data" in the record: a newer export comes in through Stash's sheet, which merges it
  const bringNewer = () => tellStash({ type: 'stash:import' })

  if (result && result.plays.length) {
    return (
      <Suspense fallback={<Pressing />}>
        <Dashboard key={n} result={result} isSample={DEMO} onReset={bringNewer} />
      </Suspense>
    )
  }
  if (archive.status === 'loading') return <Pressing />
  const switchedOff = archive.status === 'ready' && (archive.result.plays.length > 0 || live.length > 0)
  return (
    <div className="pressing" role="status">
      <div className="pressing__record" aria-hidden="true" />
      <p>
        {archive.status === 'error'
          ? 'Your record couldn’t be read in this window.'
          : switchedOff
            ? 'Nothing to press with these sources. Switch one back on above.'
            : 'Bring your Spotify history, and it’s pressed into a record here.'}
      </p>
      {archive.status === 'ready' && !switchedOff && (
        <button type="button" className="button" onClick={bringNewer}>
          Bring your Spotify
        </button>
      )}
    </div>
  )
}

/** A play from the player, checked: words, a start and a length that make sense. */
function validLive(p: unknown): p is LivePlay {
  const o = p as LivePlay | null
  return (
    !!o &&
    typeof o.t === 'string' &&
    !!o.t &&
    o.t.length <= 300 &&
    typeof o.a === 'string' &&
    !!o.a &&
    o.a.length <= 300 &&
    (o.al === undefined || (typeof o.al === 'string' && o.al.length <= 300)) &&
    Number.isFinite(o.s) &&
    o.s > 0 &&
    Number.isFinite(o.ms) &&
    o.ms >= 0 &&
    o.ms <= 6 * 3_600_000
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
