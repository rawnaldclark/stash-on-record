/*
 * Real covers inside Stash. On Record draws every cover from a hash of its name (components/Cover.tsx); inside the player, the
 * player knows real ones (its /api/art: Deezer, then Apple, cached), so a cover asks it by name and shows the picture once it
 * comes, the drawn one until then (and for good when there's none). The frame still makes no request of its own: it asks the
 * player with postMessage, and the player answers with addresses the record's policy lets it show.
 *
 * A Cover's name is "title|artist" for a song, "album|artist" for an album and the bare name for an artist; which of the first
 * two it is, and a song's album, come from the plays (`learnPlays`).
 */
import { useSyncExternalStore } from 'react'
import type { Play } from '../types'
import { EMBEDDED, onStash, tellStash } from './embed'

/** What the player looks up for a cover: an artist's picture, or a song's (or album's) album cover. */
export interface CoverAsk {
  id: string
  artist: string
  title?: string
  album?: string
}

/** Names asked per message (the player's MAX_ART). */
const BATCH = 150
const FLUSH_MS = 60

const known = new Map<string, string | null>()
const asked = new Set<string>()
const pending = new Set<string>()
const listeners = new Set<() => void>()
let flushing: ReturnType<typeof setTimeout> | null = null
let version = 0

/** "title|artist" -> the song's album (its most played), and the "album|artist" names the plays have. */
const songAlbum = new Map<string, string>()
const albums = new Set<string>()

/** Learns which names are songs and which are albums, and each song's album, from the record's plays. */
export function learnPlays(plays: readonly Play[]): void {
  songAlbum.clear()
  albums.clear()
  const counts = new Map<string, Map<string, number>>()
  for (const p of plays) {
    if (p.kind !== 'track' || !p.album) continue
    const song = `${p.title}|${p.artist}`
    const m = counts.get(song) ?? new Map<string, number>()
    m.set(p.album, (m.get(p.album) ?? 0) + 1)
    counts.set(song, m)
    albums.add(`${p.album}|${p.artist}`)
  }
  for (const [song, m] of counts) {
    let best = ''
    let n = -1
    for (const [al, c] of m) {
      if (c > n) {
        best = al
        n = c
      }
    }
    songAlbum.set(song, best)
  }
}

/** What a Cover's name stands for. */
export function askFor(name: string): CoverAsk | null {
  const cut = name.lastIndexOf('|')
  if (cut < 0) return name.trim() ? { id: name, artist: name } : null
  const label = name.slice(0, cut)
  const artist = name.slice(cut + 1)
  if (!label || !artist) return null
  const album = songAlbum.get(name)
  if (album !== undefined) return album ? { id: name, artist, title: label, album } : { id: name, artist, title: label }
  if (albums.has(name)) return { id: name, artist, title: label, album: label }
  return { id: name, artist, title: label }
}

function notify() {
  version++
  for (const l of listeners) l()
}

function flush() {
  flushing = null
  const ids = [...pending]
  pending.clear()
  for (let i = 0; i < ids.length; i += BATCH) {
    const asks = ids
      .slice(i, i + BATCH)
      .map(askFor)
      .filter((a): a is CoverAsk => !!a)
    if (asks.length) tellStash({ type: 'stash:art', asks })
  }
}

function want(name: string) {
  if (asked.has(name)) return
  asked.add(name)
  pending.add(name)
  flushing ??= setTimeout(flush, FLUSH_MS)
}

if (EMBEDDED) {
  onStash((m) => {
    if (m.type !== 'stash:covers' || !Array.isArray(m.covers)) return
    let changed = false
    for (const c of m.covers) {
      if (!c || typeof c.id !== 'string' || !asked.has(c.id)) continue
      const url = typeof c.url === 'string' && /^https:\/\//.test(c.url) ? c.url : null
      if (known.get(c.id) !== url) {
        known.set(c.id, url)
        changed = true
      }
    }
    if (changed) notify()
  })
}

const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => listeners.delete(l)
}
const snapshot = () => version

/** The real cover for a Cover's name inside Stash (asked for on first sight), or undefined: draw the generated one. */
export function useStashCover(name: string): string | undefined {
  useSyncExternalStore(subscribe, snapshot, snapshot)
  if (!EMBEDDED || !name) return undefined
  if (!known.has(name)) want(name)
  return known.get(name) ?? undefined
}
