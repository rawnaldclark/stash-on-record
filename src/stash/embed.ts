/*
 * On Record inside Stash (play.stashfm.app/record/embed.html, framed by the player's Your Spotify years). Everything Stash-specific
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

/** What the frame says to the player. */
export type ToStash =
  | { type: 'stash:play'; songs: StashSong[]; index: number; from: string }
  | { type: 'stash:import' }
  | { type: 'stash:ready'; plays: number }

/** What the player says to the frame. */
export type FromStash = { type: 'stash:reload' } | { type: 'stash:theme'; theme: 'light' | 'dark' }

export function tellStash(msg: ToStash): void {
  if (EMBEDDED) window.parent.postMessage(msg, window.location.origin)
}

/** Plays `songs` from `index` in Stash, labelled `from` ("The Record · 3 March 2024"). */
export function playInStash(songs: StashSong[], index = 0, from = 'Your Spotify years'): void {
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
    platform: '',
    country: '',
    reasonStart: r.f & F_CHOSEN ? 'clickrow' : reasons ? 'trackdone' : '',
    reasonEnd: r.f & F_DONE ? 'trackdone' : r.f & F_SKIPPED ? 'fwdbtn' : '',
    shuffle: (r.f & F_SHUFFLE) !== 0,
    skipped: (r.f & F_SKIPPED) !== 0,
    offline: false,
    incognito: false,
  }
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
