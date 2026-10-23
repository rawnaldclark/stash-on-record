import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { Category, Ranked } from '../data/stats'
import type { Play } from '../types'
import { EMBEDDED, playInStash } from './embed'
import { chartQueue, type Queue } from './queue'

/*
 * Play in Stash: the one way the record hands music to the player. Upstream components render these where a day or a song is
 * shown; outside the player's frame they render nothing (PlayHere) or exactly their children (PlayOver, ChartPlay), so On Record
 * on its own is unchanged. The queue is a function, worked out only when tapped.
 */

interface PlayProps {
  /** The songs and where to start, asked for at the tap */
  queue: () => Queue
  /** What Stash says it's playing from: "The Record · Sunday, 3 March 2024" */
  from: string
  /** What the button says to a screen reader, and as a tooltip */
  label: string
}

/** How long a tapped button shows that Stash took the queue */
const SENT_MS = 1200

/** Sends the queue to Stash and marks the button for a moment, so a tap with the music elsewhere on screen still answers */
function useSend({ queue, from }: Pick<PlayProps, 'queue' | 'from'>) {
  const [sent, setSent] = useState(false)
  const timer = useRef(0)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  const send = () => {
    const q = queue()
    playInStash(q.songs, q.index, from)
    setSent(true)
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setSent(false), SENT_MS)
  }
  return { sent, send }
}

function PlayGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path d="M8 5.6v12.8a.8.8 0 0 0 1.2.7l10.4-6.4a.8.8 0 0 0 0-1.4L9.2 4.9A.8.8 0 0 0 8 5.6z" fill="currentColor" />
    </svg>
  )
}

/**
 * A round play button in Stash's action purple: the day on The Record and in Every Day. `text` adds a visible word beside the
 * glyph where there's room for one.
 */
export function PlayHere({ queue, from, label, text, disabled, className }: PlayProps & { text?: string; disabled?: boolean; className?: string }) {
  const { sent, send } = useSend({ queue, from })
  if (!EMBEDDED) return null
  return (
    <button
      type="button"
      className={['stash-play', text && 'stash-play--text', sent && 'is-sent', className].filter(Boolean).join(' ')}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={send}
    >
      <PlayGlyph />
      {text && <span>{text}</span>}
    </button>
  )
}

/**
 * A cover that plays when tapped: the glyph sits on the art (always on a touch screen, on hover with a mouse), and the whole
 * cover, at least 40px square, is the target. The cover's own layout and classes are untouched.
 */
export function PlayOver({ queue, from, label, children }: PlayProps & { children: ReactNode }) {
  const { sent, send } = useSend({ queue, from })
  if (!EMBEDDED) return children
  return (
    <span className={sent ? 'stash-play-over is-sent' : 'stash-play-over'}>
      {children}
      <button type="button" className="stash-play-over__button" aria-label={label} title={label} onClick={send}>
        <PlayGlyph />
      </button>
    </span>
  )
}

const CHART_FROM: Record<Category, string> = { artist: 'The Charts', track: 'The Charts · Top songs', album: 'The Charts', show: '' }

/**
 * A cover in The Charts: top songs play the list from that song; an artist or an album plays its songs from the listener's plays,
 * most played first. Podcasts aren't Stash's to play.
 */
export function ChartPlay({ plays, category, items, at, children }: { plays: Play[]; category: Category; items: Ranked[]; at: number; children: ReactNode }) {
  const item = items[at]
  if (!EMBEDDED || category === 'show' || !item) return children
  const from = category === 'track' ? CHART_FROM.track : `${CHART_FROM[category]} · ${item.label}`
  const label = category === 'track' ? `Play ${item.label} by ${item.sublabel} in Stash` : `Play ${item.label} in Stash`
  return (
    <PlayOver queue={() => chartQueue(plays, category, items, at)} from={from} label={label}>
      {children}
    </PlayOver>
  )
}

/** The quiet credit inside Stash: whose work the record is */
export function StashCredit() {
  if (!EMBEDDED) return null
  return (
    <p className="stash-credit">
      Built on{' '}
      <a href="https://github.com/CarsonGodwin/on-record" target="_blank" rel="noreferrer">
        On Record
      </a>{' '}
      by Carson Godwin (MIT)
    </p>
  )
}
