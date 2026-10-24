/*
 * On Record inside Stash (play.stashfm.app/record/embed.html, framed by the player's Your record). Everything Stash-specific
 * lives under src/stash/, so the rest of the app stays as upstream has it and its updates merge cleanly.
 *
 * Stash already read the listener's export into its own IndexedDB database (`stash-spotify`, same origin): the plays come from
 * there, nothing is dropped twice. Songs and days play in Stash: the frame asks the player with postMessage (same origin only), so
 * the music keeps going while the record is open. Nothing here makes a network request.
 */
import type { LoadResult, Play } from '../types'

/** True inside the Stash player's frame. False when prerendering or opened on its own. */
export const EMBEDDED =
  typeof window !== 'undefined' && window.parent !== window && new URLSearchParams(window.location.search).get('embed') === 'stash'

/** A song as Stash knows it: its words. Stash finds it on its sources when it plays. */
export interface StashSong {
  title: string
  artist: string
  album?: string
}

/** Where a play came from (spec §7): the Spotify export, Stash itself, or a Last.fm scrobble. */
export type Source = 'spotify' | 'stash' | 'lastfm'
export const SOURCES: readonly Source[] = ['spotify', 'stash', 'lastfm']
/** As On Record's platform credit shows it ("Listened on"). */
export const SOURCE_LABEL: Record<Source, string> = { spotify: 'Spotify', stash: 'Stash', lastfm: 'Last.fm' }

/** One of Stash's own plays, as the player sends it: words, start (epoch ms) and how long it played. */
export interface LivePlay {
  t: string
  a: string
  al?: string
  s: number
  ms: number
}

/** What the frame says to the player. */
export type ToStash =
  | { type: 'stash:play'; songs: StashSong[]; index: number; from: string }
  | { type: 'stash:import' }
  | { type: 'stash:ready'; plays: number }
  /** How many plays each source has (before the switches), so the player shows a switch only for a source there is. */
  | { type: 'stash:counts'; counts: Record<Source, number> }

/** What the player says to the frame. */
export type FromStash =
  | { type: 'stash:reload' }
  | { type: 'stash:theme'; theme: 'light' | 'dark' }
  /** This browser's own plays (the player's history, never another device's), sent on load and when they change. */
  | { type: 'stash:live'; plays: LivePlay[] }
  /** Which sources the record shows. */
  | { type: 'stash:sources'; on: Record<Source, boolean> }

export function tellStash(msg: ToStash): void {
  if (EMBEDDED) window.parent.postMessage(msg, window.location.origin)
}

/** Plays `songs` from `index` in Stash, labelled `from` ("The Record · 3 March 2024"). */
export function playInStash(songs: StashSong[], index = 0, from = 'Your record'): void {
  const named = (s: StashSong) => !!(s.title && s.artist)
  const list = songs.filter(named).map((s) => (s.album ? { title: s.title, artist: s.artist, album: s.album } : { title: s.title, artist: s.artist }))
  // A nameless song left out ahead of the start moves the start with it
  const start = songs.slice(0, Math.max(0, index)).filter(named).length
  if (list.length) tellStash({ type: 'stash:play', songs: list, index: Math.min(start, list.length - 1), from })
}

/** Listens to the player; returns the unsubscribe. Only messages from the parent, from this origin. */
export function onStash(handler: (msg: FromStash) => void): () => void {
  const listen = (e: MessageEvent) => {
    if (e.source !== window.parent || e.origin !== window.location.origin) return
    const m = e.data as FromStash | null
    if (m && typeof m === 'object' && typeof m.type === 'string' && m.type.startsWith('stash:')) handler(m)
  }
  window.addEventListener('message', listen)
  return () => window.removeEventListener('message', listen)
}

/** Stash's archive row (stash-player src/lib/spotify/plays.ts ArchivePlay; spec docs/spotify-export.md §3). */
export interface ArchivePlay {
  id: string
  t: string
  a: string
  al?: string
  sid?: string
  s: number
  ms: number
  f: number
}
const F_CHOSEN = 1
const F_DONE = 2
const F_SKIPPED = 4
const F_SHUFFLE = 8
const F_REASONS = 32
const F_LASTFM = 64
/** A play made in Stash on the phone, from its export (spec §8): the Stash source, with this browser's own. */
const F_STASH = 256

/**
 * Stash's row as On Record's Play. Stash keeps the reasons as flags: CHOSEN is a play the listener started (`clickrow`), DONE one
 * that played to its end, SKIPPED one left with Next or marked skipped (On Record's `isSkip` reads either). Stash never keeps the
 * platform or country, so those stay empty, and it keeps music only, so every play is a track.
 */
export function toPlay(r: ArchivePlay): Play {
  const reasons = (r.f & F_REASONS) !== 0
  return {
    endTime: r.s + r.ms,
    msPlayed: r.ms,
    kind: 'track',
    title: r.t,
    artist: r.a,
    album: r.al ?? '',
    uri: r.sid ? `spotify:track:${r.sid}` : '',
    platform: SOURCE_LABEL[sourceOf(r)],
    country: '',
    reasonStart: r.f & F_CHOSEN ? 'clickrow' : reasons ? 'trackdone' : '',
    reasonEnd: r.f & F_DONE ? 'trackdone' : r.f & F_SKIPPED ? 'fwdbtn' : '',
    shuffle: (r.f & F_SHUFFLE) !== 0,
    skipped: (r.f & F_SKIPPED) !== 0,
    offline: false,
    incognito: false,
  }
}

export const sourceOf = (r: Pick<ArchivePlay, 'f'>): Source => (r.f & F_LASTFM ? 'lastfm' : r.f & F_STASH ? 'stash' : 'spotify')

/** One of Stash's own plays as a Play: a full listen, started by the listener as far as anyone knows. */
export function livePlay(p: LivePlay): Play {
  return {
    endTime: p.s + p.ms,
    msPlayed: p.ms,
    kind: 'track',
    title: p.t,
    artist: p.a,
    album: p.al ?? '',
    uri: '',
    platform: SOURCE_LABEL.stash,
    country: '',
    reasonStart: '',
    reasonEnd: 'trackdone',
    shuffle: false,
    skipped: false,
    offline: false,
    incognito: false,
  }
}

/** A scrobble within this of a play is that play (the player's plays.ts SCROBBLE_SLACK_MS). */
const SCROBBLE_SLACK_MS = 180_000
/** The player's identity fold (identity.ts `fold`), for comparing titles. */
const fold = (s: string) =>
  s
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\s*[([]\s*(?:featuring|feat|ft)(?![\p{L}\p{N}])\.?[^)\]]*[)\]]/giu, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()

/**
 * The record's plays (spec §7): the archive (Spotify and Last.fm) and Stash's own, a listen counted once (a scrobble of a play
 * Stash made is left out), then only the sources switched on. Oldest first, as On Record sorts.
 */
export function stack(archive: Play[], live: LivePlay[], on: Record<Source, boolean>): Play[] {
  const byTitle = new Map<string, { s: number; e: number }[]>()
  for (const p of live) {
    const k = fold(p.t)
    const span = { s: p.s, e: p.s + p.ms }
    const l = byTitle.get(k)
    if (l) l.push(span)
    else byTitle.set(k, [span])
  }
  const out: Play[] = []
  for (const p of archive) {
    const src: Source = p.platform === SOURCE_LABEL.lastfm ? 'lastfm' : p.platform === SOURCE_LABEL.stash ? 'stash' : 'spotify'
    if (!on[src]) continue
    if (src === 'lastfm') {
      const s = p.endTime - p.msPlayed
      if (byTitle.get(fold(p.title))?.some((x) => s >= x.s - SCROBBLE_SLACK_MS && s <= x.e + SCROBBLE_SLACK_MS)) continue
    }
    out.push(p)
  }
  if (on.stash) for (const p of live) out.push(livePlay(p))
  return out.sort((a, b) => a.endTime - b.endTime)
}

/** A listen, as every count in Stash means it: 30 s or more (shorter starts are skips). */
const LISTEN_MS = 30_000

/**
 * How many listens each source brings, before the switches (a scrobble Stash's own play covers counts as Stash's). Listens, not
 * every start, so the switches agree with Settings and the import's numbers.
 */
export function countSources(archive: Play[], live: LivePlay[]): Record<Source, number> {
  const all = stack(archive, live, { spotify: true, stash: true, lastfm: true })
  const counts: Record<Source, number> = { spotify: 0, stash: 0, lastfm: 0 }
  for (const p of all) if (p.msPlayed >= LISTEN_MS) counts[p.platform === SOURCE_LABEL.lastfm ? 'lastfm' : p.platform === SOURCE_LABEL.stash ? 'stash' : 'spotify']++
  return counts
}

const DB = 'stash-spotify'

/** Whether the database exists at all (opening a missing one would make an empty one). */
async function hasDb(): Promise<boolean> {
  if (typeof indexedDB === 'undefined') return false
  if (typeof indexedDB.databases !== 'function') return true
  try {
    return (await indexedDB.databases()).some((d) => d.name === DB)
  } catch {
    return true
  }
}

/** Every imported play, oldest first (On Record sorts by end time). Empty when this browser has no import. */
export async function loadFromStash(): Promise<LoadResult> {
  const empty: LoadResult = { plays: [], filesRead: [], skippedRows: 0, duplicateRows: 0, warnings: [] }
  if (!(await hasDb())) return empty
  const rows = await new Promise<ArchivePlay[]>((resolve, reject) => {
    // No version: open whatever Stash made, never upgrade it (that's the player's job).
    const req = indexedDB.open(DB)
    req.onerror = () => reject(req.error)
    req.onsuccess = () => {
      const db = req.result
      if (!db.objectStoreNames.contains('plays')) {
        db.close()
        resolve([])
        return
      }
      const get = db.transaction('plays', 'readonly').objectStore('plays').getAll()
      get.onerror = () => (db.close(), reject(get.error))
      get.onsuccess = () => (db.close(), resolve(get.result as ArchivePlay[]))
    }
  })
  const plays = rows.map(toPlay).sort((a, b) => a.endTime - b.endTime)
  return { ...empty, plays, filesRead: plays.length ? ['Your Spotify history in Stash'] : [] }
}
