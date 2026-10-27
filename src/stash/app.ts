/*
 * The record inside the Stash app on Android (?embed=stash-app, transport.ts). The app opens the page full screen in a WebView over
 * the app's own copy of it, offline, and is the host:
 *
 * - There's no IndexedDB here. Once the record listens it says hello (`stash:hello`), and the app answers with its archive in
 *   chunks (`stash:archive`), every source already stacked with a listen counted once. The record is pressed from those rows as
 *   it is from the player's: the same `toPlay`, flags, sources and counts (embed.ts `fromArchive`). A reload (`stash:reload`)
 *   says hello again.
 * - The app's back gesture comes as `stash:back`: what's open over the record closes first (answered `stash:backed`), then the
 *   record itself (`stash:close`).
 *
 * Everything else (ready, counts, play, import, close, covers, theme, sources) is what the player's frame says and hears.
 */
import { closeTopmost } from '../lib/back'
import type { LoadResult } from '../types'
import { APP_HOST, fromArchive, onStash, tellStash, type ArchivePlay } from './embed'

/**
 * The longest row the web's archive can hold, so the app's rows are kept to the same: words up to 300 characters (the player's
 * import cuts them there), and up to a day played. A play made in Stash keeps its length up to 24 hours (the player's
 * `phoneRows`: a 7-hour DJ mix played whole is a real play); Spotify's own rows stop at six hours, well inside it.
 */
const MAX_TEXT = 300
const MAX_MS = 24 * 3_600_000
/** Flags are bits read with `&`, which works on 32-bit integers: anything past that isn't a set of flags. */
const MAX_FLAGS = 0x7fffffff

const words = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= MAX_TEXT
// An optional field may come as null: the app's JSON can write a missing value that way
const maybeWords = (v: unknown): v is string | null | undefined => v === undefined || v === null || (typeof v === 'string' && v.length <= MAX_TEXT)

/**
 * One of the app's rows, checked, as a clean ArchivePlay (only its own fields), or null for a row that can't be a play: words
 * missing or too long, no start, a length past a day, flags that aren't flags.
 *
 * No other bounds: the web's read of its archive (embed.ts `loadFromStash`) checks nothing, so a start before 2006 or after
 * today is pressed there as it is here. The player's import keeps such rows out before they are written; the app does the same.
 */
export function archiveRow(r: unknown): ArchivePlay | null {
  if (!r || typeof r !== 'object') return null
  const o = r as Record<string, unknown>
  if (typeof o.id !== 'string' || !words(o.t) || !words(o.a) || !maybeWords(o.al) || !maybeWords(o.sid)) return null
  if (typeof o.s !== 'number' || !Number.isFinite(o.s) || o.s <= 0) return null
  if (typeof o.ms !== 'number' || !Number.isFinite(o.ms) || o.ms < 0 || o.ms > MAX_MS) return null
  if (typeof o.f !== 'number' || !Number.isInteger(o.f) || o.f < 0 || o.f > MAX_FLAGS) return null
  const row: ArchivePlay = { id: o.id, t: o.t, a: o.a, s: o.s, ms: o.ms, f: o.f }
  if (o.al) row.al = o.al
  if (o.sid) row.sid = o.sid
  return row
}

/** A chunk as it arrives: nothing in it trusted yet. */
export interface ArchiveChunk {
  rows?: unknown
  seq?: unknown
  done?: unknown
}

export interface ArchiveReceiver {
  /** A hello went out: the answer to it starts at seq 0, and whatever was gathered for an older one goes. */
  hello(): void
  /** Takes one chunk; returns the whole archive once the last chunk of an answer is in, null until then. */
  take(chunk: ArchiveChunk): ArchivePlay[] | null
}

/** Plain UTF-16 order, as IndexedDB orders string keys (never a locale's collation). */
const byId = (x: ArchivePlay, y: ArchivePlay) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0)

/**
 * Gathers the app's archive from its chunks. The app answers each hello from seq 0, one chunk after the other, on one ordered
 * channel. So:
 *
 * - a chunk with seq 0 opens an answer, the app's to the newest hello, and anything gathered before it goes;
 * - any other chunk must be the next one, or it is out of order or left over from the answer to an older hello (one that was
 *   still coming in when the record said hello again), and is dropped;
 * - the archive is whole at the chunk marked done.
 *
 * The whole archive is what the web's would be for the same rows. Its store is keyed by id, so it holds one row per id: here
 * too, the first row with an id is kept and any later one with the same id (in any chunk) is left out, as the player's import
 * keeps the play it has over one that comes again. And `getAll` hands the rows over by id, which decides the order of plays
 * that end at the same moment once they are sorted by end time (and so which artist leads a tie in the charts): the rows are
 * handed on in that order too, however the app sent them.
 *
 * Nothing on the wire says which hello a seq-0 chunk answers. When two hellos go out before the first answer starts, the record
 * may be pressed from the first answer and then again from the second; the last answer the app sends is always the one that
 * stays.
 */
export function archiveReceiver(): ArchiveReceiver {
  let rows: ArchivePlay[] = []
  let ids = new Set<string>()
  let dropped = 0
  let repeated = 0
  /** The seq the answer coming in needs next; -1 when none is coming (nothing asked yet, or the last answer is in). */
  let next = -1
  const reset = () => {
    rows = []
    ids = new Set()
    dropped = 0
    repeated = 0
  }
  return {
    hello() {
      reset()
      next = 0
    },
    take(chunk) {
      const { seq } = chunk
      if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 0 || !Array.isArray(chunk.rows)) return null
      if (seq === 0) reset()
      else if (seq !== next) return null
      // One by one rather than spread: a chunk holds thousands of rows, past what a call's arguments can carry
      for (const r of chunk.rows) {
        const row = archiveRow(r)
        if (!row) dropped++
        else if (ids.has(row.id)) repeated++
        else {
          ids.add(row.id)
          rows.push(row)
        }
      }
      if (chunk.done !== true) {
        next = seq + 1
        return null
      }
      // Only the counts: a row's words are the listener's
      if (dropped) console.warn(`Your record: ${dropped} of the app's rows weren't plays, left out`)
      if (repeated) console.warn(`Your record: ${repeated} of the app's rows came again (an id already kept), left out`)
      const all = rows.sort(byId)
      reset()
      next = -1
      return all
    },
  }
}

/** A chunk's seq as the app numbers them: a whole number from 0. */
const isSeq = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0

/**
 * The record's archive from the app: says hello now (the listener is live, so the answer has somewhere to go) and on each
 * stash:reload, and hands `pressed` the record's plays each time an answer is whole. Returns how to stop listening.
 *
 * Each chunk is acked (`stash:archive-ack {seq}`) once the receiver has dealt with it, the last one too, and the app keeps at most
 * two unacked: an import's 400k rows never sit in the WebView as tens of MB of queued strings. Every chunk with a seq is acked,
 * kept or dropped: one left over from the answer to an older hello is done with as well, so the app never waits on a chunk the
 * record has seen. An ack names only its seq, so one for an older answer can reach the app after a new hello: the app counts only
 * acks for chunks it has sent and not yet seen acked, so it changes nothing there.
 */
export function archiveFromApp(pressed: (result: LoadResult) => void): () => void {
  const receiver = archiveReceiver()
  const hello = () => {
    receiver.hello()
    tellStash({ type: 'stash:hello', v: 1 })
  }
  const stop = onStash((m) => {
    if (m.type === 'stash:reload') hello()
    else if (m.type === 'stash:archive') {
      const rows = receiver.take(m)
      // Acked before pressing (the slow part): the app needn't wait on it. Only the app acks: the player's frame sends no chunks
      if (APP_HOST && isSeq(m.seq)) tellStash({ type: 'stash:archive-ack', seq: m.seq })
      if (rows) pressed(fromArchive(rows))
    }
  })
  hello()
  return stop
}

/**
 * The app's back gesture: what was opened over the record last (a sheet, the launcher, Settings, a menu) closes, as back does on
 * the phone's deck, and the app hears `stash:backed`; with nothing open, the record closes, back to the app (`stash:close`).
 * Every back gets one answer, so the app need only force the record closed when neither comes (a page that's stuck), never on
 * two quick presses that close two sheets.
 */
export function backInApp(): void {
  tellStash(closeTopmost() ? { type: 'stash:backed' } : { type: 'stash:close' })
}

/** Listens for the app's back gesture (`stash:back`); returns how to stop. */
export function listenForBack(): () => void {
  return onStash((m) => {
    if (m.type === 'stash:back') backInApp()
  })
}
