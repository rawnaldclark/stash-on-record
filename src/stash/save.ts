/*
 * Saving and sharing a file inside the Stash app (embed.ts `stash:save`). A WebView has no navigator.share, and a download link
 * (`<a download href="blob:…">`) does nothing in it, so the posters' and the race video's buttons hand the file to the app
 * instead, which saves it or opens the share sheet with it. The web's own buttons are untouched: only the app host calls this.
 *
 * A file goes as chunks, so a long race video never becomes one giant string on the bridge. Each chunk is its own base64 of at
 * most 512 KiB of the file's bytes. Every chunk but the last is a whole number of 3-byte groups, so no chunk but the last ends
 * in padding: the app can decode each chunk alone and append the bytes, or join the strings and decode once.
 *
 * The app acks each chunk it has taken (`stash:save-ack {id, seq}`), and at most SAVE_WINDOW chunks of a file go unacked, so
 * the app never queues more than two chunks' text (a 75 MB video sent back to back would pile up 100 MB and more on its heap).
 * With chunks unacked and no ack for SAVE_ACK_TIMEOUT_MS, or the page going away, the record gives the file up and says so
 * (`stash:save-abort {id}`): a host that never acks can't hold a button busy for ever.
 */
import { APP_HOST, onStash, tellStash, type FromStash, type SaveAction, type ToStash } from './embed'

export type SaveMessage = Extract<ToStash, { type: 'stash:save' }>
export type SaveAbort = Extract<ToStash, { type: 'stash:save-abort' }>

/** At most 512 KiB of the file in a chunk; the largest multiple of 3 within it (524,286 bytes), so its base64 has no padding. */
export const SAVE_CHUNK_BYTES = Math.floor((512 * 1024) / 3) * 3
/** At most this many chunks of one file sent and not yet acked. */
export const SAVE_WINDOW = 2
/** With chunks unacked, this long without an ack (since the last chunk went or the last ack came) and the file is given up. */
export const SAVE_ACK_TIMEOUT_MS = 15_000

/** How many bytes go to String.fromCharCode at once: well under what a call's arguments can carry. */
const CHAR_RUN = 0x2000

/** The bytes as standard base64 (RFC 4648, padded): the browser's own encoder where it has one, btoa otherwise. */
export function base64(bytes: Uint8Array): string {
  const native = (bytes as Uint8Array & { toBase64?: () => string }).toBase64
  if (typeof native === 'function') return native.call(bytes)
  let binary = ''
  for (let i = 0; i < bytes.length; i += CHAR_RUN) binary += String.fromCharCode(...bytes.subarray(i, i + CHAR_RUN))
  return btoa(binary)
}

let made = 0

/** A new id for one file's chunks: random where the browser can make one (it can on the app's https origin), unique anyway. */
export function saveId(): string {
  made++
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  if (typeof c?.randomUUID === 'function') return c.randomUUID()
  return `${Date.now().toString(36)}-${made.toString(36)}-${Math.random().toString(36).slice(2)}`
}

/** Why a file didn't reach the app: no ack in time, a chunk that couldn't be read or posted, the page going away, no app. */
export type SaveFailure = 'timeout' | 'read' | 'post' | 'teardown' | 'no-app'

/** A hand-over that stopped short. The app was told (stash:save-abort) wherever there was an app to tell. */
export class SaveFailed extends Error {
  readonly reason: SaveFailure
  constructor(reason: SaveFailure, cause?: unknown) {
    super(`The file didn't reach the app (${reason})`, { cause })
    this.name = 'SaveFailed'
    this.reason = reason
  }
}

/** What a hand-over needs of the host: a way to post, a way to hear its acks. The app's bridge; tests hand their own. */
export interface SaveChannel {
  post(msg: SaveMessage | SaveAbort): void
  listen(handler: (msg: FromStash) => void): () => void
}

const bridge: SaveChannel = { post: tellStash, listen: onStash }

export interface SaveOptions {
  channel?: SaveChannel
  /** SAVE_ACK_TIMEOUT_MS unless a test says otherwise */
  timeoutMs?: number
}

/** The files on their way, by id, and how to give each up. */
const onTheirWay = new Map<string, (reason: SaveFailure) => void>()
let watching = false

/** Gives up every file still on its way, telling the app (stash:save-abort {id}) for each: the page is going away. */
export function abandonSaves(): void {
  for (const giveUp of [...onTheirWay.values()]) giveUp('teardown')
}

/** The page going away (closed, reloaded, navigated) mid-file abandons what's on its way. Watched from the first file on. */
function watchTeardown(): void {
  if (watching || typeof window === 'undefined' || typeof window.addEventListener !== 'function') return
  watching = true
  window.addEventListener('pagehide', abandonSaves)
}

/**
 * Hands `file` to the app as `name`, for it to save or share (`action`). Resolves once the app has acked every chunk, so a
 * button can stay busy until the file is the app's; rejects with SaveFailed when it gives up (after posting stash:save-abort).
 */
export function handToApp(file: Blob, name: string, action: SaveAction, { channel = bridge, timeoutMs = SAVE_ACK_TIMEOUT_MS }: SaveOptions = {}): Promise<void> {
  // Outside the app no one would ever ack: say so now rather than after the timeout
  if (channel === bridge && !APP_HOST) return Promise.reject(new SaveFailed('no-app'))
  const id = saveId()
  const mime = file.type || 'application/octet-stream'
  const size = file.size
  // An empty file is still one chunk, the last, so the app hears it whole
  const count = Math.max(1, Math.ceil(size / SAVE_CHUNK_BYTES))

  return new Promise<void>((resolve, reject) => {
    /** Sent and not yet acked */
    const unacked = new Set<number>()
    /** The next chunk to send (counted when its read starts, so it says nothing of what has gone) */
    let next = 0
    /** Chunks the app has acked: the file is the app's when every one is */
    let acked = 0
    let over = false
    let pumping = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let stopListening = () => {}

    const finish = (failure?: SaveFailed) => {
      if (over) return
      over = true
      clearTimeout(timer)
      stopListening()
      onTheirWay.delete(id)
      if (failure) reject(failure)
      else resolve()
    }
    const giveUp = (reason: SaveFailure, cause?: unknown) => {
      if (over) return
      try {
        channel.post({ type: 'stash:save-abort', id })
      } catch {
        // The bridge is gone: there's no one left to tell
      }
      finish(new SaveFailed(reason, cause))
    }
    // Counted again from each chunk sent and each ack heard
    const waitForAck = () => {
      clearTimeout(timer)
      timer = setTimeout(() => giveUp('timeout'), timeoutMs)
    }

    // Sends chunks while the window has room. One run at a time: an ack heard mid-read finds it running, and it looks again
    const pump = async () => {
      if (pumping) return
      pumping = true
      try {
        while (!over && next < count && unacked.size < SAVE_WINDOW) {
          const seq = next++
          const at = seq * SAVE_CHUNK_BYTES
          let data: string
          try {
            // One chunk read at a time, and the read is async, so the page paints (its busy button shows) between chunks
            data = base64(new Uint8Array(await file.slice(at, Math.min(at + SAVE_CHUNK_BYTES, size)).arrayBuffer()))
          } catch (err) {
            return giveUp('read', err)
          }
          if (over) return
          // Unacked before it goes, so an ack can never come for a chunk not counted yet
          unacked.add(seq)
          try {
            channel.post({ type: 'stash:save', id, name, mime, action, seq, done: seq === count - 1, data })
          } catch (err) {
            return giveUp('post', err)
          }
          if (over) return
          waitForAck()
        }
      } finally {
        pumping = false
      }
    }

    stopListening = channel.listen((m) => {
      // Only this file's acks, for a chunk sent and not acked yet (in any order): anything else changes nothing
      if (m.type !== 'stash:save-ack' || m.id !== id || !unacked.has(m.seq)) return
      unacked.delete(m.seq)
      if (++acked === count) return finish()
      waitForAck()
      void pump()
    })
    onTheirWay.set(id, giveUp)
    watchTeardown()
    void pump()
  })
}
