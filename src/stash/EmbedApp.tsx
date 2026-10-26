import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { LoadResult, Play } from '../types'
import { archiveFromApp } from './app'
import { learnPlays } from './covers'
import { APP_HOST, countSources, loadFromStash, onStash, stack, tellStash, type LivePlay, type Source } from './embed'

/*
 * The app inside Stash: no landing page and no drop zone. The plays are already in the player's archive (the Spotify export and
 * Last.fm scrobbles), and the player sends its own (`stash:live`), so this opens straight on the record, every source stacked
 * with a listen counted once; the player's switches pick which sources it shows (`stash:sources`). With nothing at all yet, one
 * button asks the player to open its import sheet. The player says when an import changed the archive (`stash:reload`) and
 * which theme it shows (`stash:theme`).
 *
 * Pressing is the slow part (every chart worked out again from every play), so it happens only for a real change: the same plays
 * or sources sent again change nothing, and new plays of this browser's (a song just played) go into the record as it stands,
 * without starting it over.
 *
 * In the Stash app (app.ts) the archive comes from the app instead, already stacked, in answer to a hello; a reload says hello
 * again. The app sends no `stash:live`.
 */

/**
 * `?demo=1` presses On Record's seeded sample instead of the archive: for screenshots and checks in a browser with no import.
 * Nothing is read or written, and the sample is made on the spot, so it is harmless in any build.
 */
const DEMO = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('demo') === '1'

/** In the app, the archive is the app's to send (the sample still wins, as it does over this browser's archive). */
const ARCHIVE_FROM_APP = APP_HOST && !DEMO

const Dashboard = lazy(() => import('../components/Dashboard').then((m) => ({ default: m.Dashboard })))

const ALL: Record<Source, boolean> = { spotify: true, stash: true, lastfm: true }

/** The same plays, in the same order: nothing to press again. */
const livePrint = (plays: readonly LivePlay[]) => plays.map((p) => `${p.s}|${p.ms}|${p.t}|${p.a}|${p.al ?? ''}`).join('\n')
const sourcesPrint = (on: Record<Source, boolean>) => `${on.spotify}|${on.stash}|${on.lastfm}`

type Archive = { status: 'loading' } | { status: 'error' } | { status: 'ready'; result: LoadResult }

export default function EmbedApp() {
  const [archive, setArchive] = useState<Archive>({ status: 'loading' })
  const [live, setLive] = useState<LivePlay[]>([])
  const [on, setOn] = useState<Record<Source, boolean>>(ALL)
  // A new record when the archive or the sources change: it starts over on the new plays, as it does after New data
  const [n, setN] = useState(0)
  // What the record was last pressed with, to tell a real change from the same thing sent again
  const livePrinted = useRef(livePrint([]))
  const sourcesPrinted = useRef(sourcesPrint(ALL))

  // A new archive: the record starts over on it
  const pressed = useCallback((result: LoadResult) => {
    setArchive({ status: 'ready', result })
    setN((x) => x + 1)
  }, [])

  const load = useCallback(async () => {
    try {
      pressed(DEMO ? (await import('../data/load')).loadSample() : await loadFromStash())
    } catch {
      setArchive({ status: 'error' })
      // the player's cover goes now, not after its wait: this page says what went wrong
      tellStash({ type: 'stash:ready', plays: 0 })
    }
  }, [pressed])

  useEffect(() => {
    const stop = onStash((m) => {
      // The app's reload is archiveFromApp's: it says hello again
      if (m.type === 'stash:reload') {
        if (!ARCHIVE_FROM_APP) void load()
      } else if (m.type === 'stash:theme') document.documentElement.dataset.theme = m.theme
      else if (m.type === 'stash:live' && Array.isArray(m.plays)) {
        // This browser's plays: into the record as it stands (no starting over), and only when they're new
        const plays = m.plays.filter(validLive)
        const print = livePrint(plays)
        if (print === livePrinted.current) return
        livePrinted.current = print
        setLive(plays)
      } else if (m.type === 'stash:sources' && m.on && typeof m.on === 'object') {
        const next = { spotify: m.on.spotify !== false, stash: m.on.stash !== false, lastfm: m.on.lastfm !== false }
        const print = sourcesPrint(next)
        if (print === sourcesPrinted.current) return
        sourcesPrinted.current = print
        setOn(next)
        setN((x) => x + 1)
      }
    })
    // The app answers a hello, said once its listener is live; the answer, like the read below, arrives after the effect
    if (ARCHIVE_FROM_APP) {
      const stopApp = archiveFromApp(pressed)
      return () => {
        stop()
        stopApp()
      }
    }
    // The read is the external system here: its answer arrives after the effect, never inside it
    void Promise.resolve().then(load)
    return stop
  }, [load, pressed])

  const result = useMemo<LoadResult | null>(() => {
    if (archive.status !== 'ready') return null
    const plays: Play[] = DEMO ? archive.result.plays : stack(archive.result.plays, live, on)
    // Which cover names are songs, which albums, and each song's album (stash/covers.ts)
    learnPlays(plays)
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
