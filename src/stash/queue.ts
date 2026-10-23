/*
 * What a tap on a day, a song, an artist or an album asks Stash to play, worked out from the listener's own plays. Pure functions,
 * so the tests can pin them down; the components in src/stash/ call them only when something is tapped, so the page never pays for
 * a queue nobody asked for.
 */
import { COUNTED_PLAY_MS, trackKey, type Category, type Ranked } from '../data/stats'
import type { Play } from '../types'
import type { StashSong } from './embed'

/** A list to hand Stash and where in it to start. */
export interface Queue {
  songs: StashSong[]
  index: number
}

/** The most Stash is asked to queue at once: an artist with thousands of songs needs a start, not the lot. */
export const MAX_QUEUE = 200

/** A play as Stash knows a song: its words, the album only when the export named one. */
export function songOf(p: { title: string; artist: string; album?: string }): StashSong {
  return p.album ? { title: p.title, artist: p.artist, album: p.album } : { title: p.title, artist: p.artist }
}

/**
 * A day's music in the order it first played, each song once. Plays under 30 seconds were skips, so they stay out, unless the
 * day was nothing but skips. `dayPlays` must be in the order they started (as `dayDetail` and The Record keep them).
 *
 * `from` starts the queue at that play's song: the needle on The Record, or a row in the day's list. A skip that was left out
 * starts at the next song that played after it.
 */
export function dayQueue(dayPlays: readonly Play[], from?: Play): Queue {
  const tracks = dayPlays.filter((p) => p.kind === 'track')
  const counted = tracks.filter((p) => p.msPlayed >= COUNTED_PLAY_MS)
  const kept = counted.length ? counted : tracks
  const songs: StashSong[] = []
  // Each song's place in the queue, and when its first play started
  const placed = new Map<string, number>()
  const starts: number[] = []
  for (const p of kept) {
    const key = trackKey(p)
    if (placed.has(key)) continue
    placed.set(key, songs.length)
    starts.push(p.endTime - p.msPlayed)
    songs.push(songOf(p))
  }
  let index = 0
  if (from) {
    const fromStart = from.endTime - from.msPlayed
    index = placed.get(trackKey(from)) ?? Math.max(0, starts.findIndex((s) => s >= fromStart))
  }
  return { songs: songs.slice(0, MAX_QUEUE), index: Math.min(index, MAX_QUEUE - 1) }
}

/**
 * Every song of the plays `match` picks, most played first: plays of 30 seconds or more, as The Charts count them, then time
 * played, then the title so ties keep one order. Each song carries the album it was played from most.
 */
export function songsOf(plays: readonly Play[], match: (p: Play) => boolean): StashSong[] {
  const songs = new Map<string, { title: string; artist: string; plays: number; ms: number; albums: Map<string, number> }>()
  for (const p of plays) {
    if (p.kind !== 'track' || !match(p)) continue
    const key = trackKey(p)
    let s = songs.get(key)
    if (!s) {
      s = { title: p.title, artist: p.artist, plays: 0, ms: 0, albums: new Map() }
      songs.set(key, s)
    }
    if (p.msPlayed >= COUNTED_PLAY_MS) s.plays++
    s.ms += p.msPlayed
    if (p.album) s.albums.set(p.album, (s.albums.get(p.album) ?? 0) + 1)
  }
  return [...songs.values()]
    .sort((a, b) => b.plays - a.plays || b.ms - a.ms || a.title.localeCompare(b.title))
    .slice(0, MAX_QUEUE)
    .map((s) => songOf({ title: s.title, artist: s.artist, album: mostOf(s.albums) }))
}

/** An artist's songs from the listener's plays, most played first. */
export function artistQueue(plays: readonly Play[], artist: string): Queue {
  return { songs: songsOf(plays, (p) => p.artist === artist), index: 0 }
}

/** An album's songs from the listener's plays, most played first. */
export function albumQueue(plays: readonly Play[], artist: string, album: string): Queue {
  return { songs: songsOf(plays, (p) => p.artist === artist && p.album === album), index: 0 }
}

/**
 * A cover tapped in The Charts. Top songs play the chart itself from that song; an artist or an album plays its songs from
 * `plays` (the period on screen), most played first. Podcasts have nothing for Stash to play.
 */
export function chartQueue(plays: readonly Play[], category: Category, items: readonly Ranked[], at: number): Queue {
  const item = items[at]
  if (!item || category === 'show') return { songs: [], index: 0 }
  if (category === 'artist') return artistQueue(plays, item.label)
  if (category === 'album') return albumQueue(plays, item.sublabel ?? '', item.label)
  return { songs: items.map((r) => songOf({ title: r.label, artist: r.sublabel ?? '' })), index: at }
}

/** The album with the most plays, or undefined when none was named. */
function mostOf(counts: Map<string, number>): string | undefined {
  let best: string | undefined
  let most = 0
  for (const [name, n] of counts) {
    if (n > most) {
      best = name
      most = n
    }
  }
  return best
}
