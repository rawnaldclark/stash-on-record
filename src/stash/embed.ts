/*
 * On Record inside Stash (play.stashfm.app/record/embed.html, framed by the player's Your record). Everything Stash-specific
 * lives under src/stash/, so the rest of the app stays as upstream has it and its updates merge cleanly.
 *
 * Stash already read the listener's export into its own IndexedDB database (`stash-spotify`, same origin): the plays come from
 * there, nothing is dropped twice. Songs and days play in Stash: the frame asks the player with postMessage (same origin only), so
 * the music keeps going while the record is open. Nothing here makes a network request.
 *
 * The Stash app on Android opens the same page in a WebView (?embed=stash-app). The app is the host there: the same messages go
 * over its bridge instead (transport.ts), and the archive comes from the app rather than IndexedDB (app.ts).
 */
import type { LoadResult, Play } from '../types'
import { appHostOf, appTransport, frameTransport, inPlayerFrame, type Transport } from './transport'

const win = typeof window === 'undefined' ? undefined : window
const appHost = win ? appHostOf(win) : null

/** True inside the Stash app on Android: ?embed=stash-app, with the app's StashHost bridge on the window. */
export const APP_HOST = appHost !== null

/** True inside Stash: the player's frame, or the Stash app. False when prerendering or opened on its own. */
export const EMBEDDED = APP_HOST || (win !== undefined && inPlayerFrame(win))

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
  /** Close the record held full screen on a phone (StashClose), back to the player's page. */
  | { type: 'stash:close' }
  /**
   * The app only (app.ts): the answer to a stash:back that closed something open over the record (a sheet, the launcher, a
   * menu). Every stash:back gets one answer, this or stash:close, so the app can tell a page that handled it from one that's stuck.
   */
  | { type: 'stash:backed' }
  /** Real covers for the names On Record would draw (covers.ts): an artist, or a song's or album's words. */
  | { type: 'stash:art'; asks: { id: string; artist: string; title?: string; album?: string }[] }
  /**
   * The app only (app.ts): the record listens now, so the app can answer (its bridge replies to a page that has spoken) with the
   * archive. Sent on load and again on stash:reload. `v` is the protocol's version.
   */
  | { type: 'stash:hello'; v: 1 }
  /**
   * The app only (save.ts): a poster or the race video for the app to save ('save', the download buttons) or hand to the
   * share sheet ('share'), since a WebView has neither downloads nor navigator.share. One file comes as chunks on the same
   * `id`: `seq` counts from 0, `done` marks the last, and `data` is a chunk's bytes in base64 (at most 512 KiB of them; every
   * chunk but the last a multiple of 3 bytes, so only the last is padded). Every chunk carries the name, type and action.
   */
  | { type: 'stash:save'; id: string; name: string; mime: string; action: SaveAction; seq: number; done: boolean; data: string }

/** What the app does with a file the record hands it: keeps it on the phone, or opens the share sheet with it. */
export type SaveAction = 'save' | 'share'

/** What the player says to the frame. */
export type FromStash =
  | { type: 'stash:reload' }
  | { type: 'stash:theme'; theme: 'light' | 'dark' }
  /** This browser's own plays (the player's history, never another device's), sent on load and when they change. */
  | { type: 'stash:live'; plays: LivePlay[] }
  /** Which sources the record shows. */
  | { type: 'stash:sources'; on: Record<Source, boolean> }
  /** The covers asked for: an address, or null for none known. */
  | { type: 'stash:covers'; covers: { id: string; url: string | null }[] }
  /**
   * The app only (app.ts): its archive, every source already stacked, in chunks answering a hello. `seq` counts from 0 for each
   * hello; `done` marks the last chunk.
   */
  | { type: 'stash:archive'; rows: ArchivePlay[]; seq: number; done: boolean }
  /** The app only: its back gesture. What's open over the record closes first; with nothing open, the record. */
  | { type: 'stash:back' }

/**
 * What the app may send; anything else from it is dropped. Not `stash:live`: the app stacks every source itself and sends one
 * archive, and this browser's plays (the frame's `stash:live`) would be a second copy of the phone's own.
 */
const FROM_APP: ReadonlySet<string> = new Set([
  'stash:reload',
  'stash:theme',
  'stash:sources',
  'stash:covers',
  'stash:archive',
  'stash:back',
] satisfies FromStash['type'][])

/** None when prerendering: there's no window, and no one to talk to. */
const transport: Transport | null = appHost ? appTransport(appHost, FROM_APP) : win ? frameTransport(win) : null

export function tellStash(msg: ToStash): void {
  if (EMBEDDED) transport?.send(msg)
}

/** Plays `songs` from `index` in Stash, labelled `from` ("The Record · 3 March 2024"). */
export function playInStash(songs: StashSong[], index = 0, from = 'Your record'): void {
  const named = (s: StashSong) => !!(s.title && s.artist)
  const list = songs.filter(named).map((s) => (s.album ? { title: s.title, artist: s.artist, album: s.album } : { title: s.title, artist: s.artist }))
  // A nameless song left out ahead of the start moves the start with it
  const start = songs.slice(0, Math.max(0, index)).filter(named).length
  if (list.length) tellStash({ type: 'stash:play', songs: list, index: Math.min(start, list.length - 1), from })
}

/**
 * Listens to Stash; returns the unsubscribe. In the player's frame, only messages from the parent, from this origin; in the app,
 * only the messages it may send (FROM_APP).
 */
export function onStash(handler: (msg: FromStash) => void): () => void {
  if (!transport) return () => {}
  return transport.listen((m) => handler(m as FromStash))
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
  // A play the archive keeps already (the phone's, from its export) is one play: Stash's import puts the export's recent plays in
  // the player's library too, so the same song and start can come both ways. The archive's copy, with its time played, is kept.
  if (on.stash) {
    const kept = new Set(archive.map((p) => `${fold(p.title)}|${fold(p.artist)}|${p.endTime - p.msPlayed}`))
    for (const p of live) if (!kept.has(`${fold(p.t)}|${fold(p.a)}|${p.s}`)) out.push(livePlay(p))
  }
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

/**
 * The record's plays from Stash's archive rows, oldest first (On Record sorts by end time): the same for the rows this browser
 * keeps and the rows the app sends.
 */
export function fromArchive(rows: readonly ArchivePlay[]): LoadResult {
  const plays = rows.map(toPlay).sort((a, b) => a.endTime - b.endTime)
  return { plays, filesRead: plays.length ? ['Your Spotify history in Stash'] : [], skippedRows: 0, duplicateRows: 0, warnings: [] }
}

/** Every imported play, oldest first. Empty when this browser has no import. */
export async function loadFromStash(): Promise<LoadResult> {
  if (!(await hasDb())) return fromArchive([])
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
  return fromArchive(rows)
}
