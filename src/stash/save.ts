/*
 * Saving and sharing a file inside the Stash app (embed.ts `stash:save`). A WebView has no navigator.share, and a download link
 * (`<a download href="blob:…">`) does nothing in it, so the posters' and the race video's buttons hand the file to the app
 * instead, which saves it or opens the share sheet with it. The web's own buttons are untouched: only the app host calls this.
 *
 * A file goes as chunks, so a long race video never becomes one giant string on the bridge (the page holds one chunk's text at
 * a time). Each chunk is its own base64 of at most 512 KiB of the file's bytes. Every chunk but the last is a whole number of
 * 3-byte groups, so no chunk but the last ends in padding: the app can decode each chunk alone and append the bytes, or join
 * the strings and decode once; both give the file.
 */
import { tellStash, type SaveAction, type ToStash } from './embed'

export type SaveMessage = Extract<ToStash, { type: 'stash:save' }>

/** At most 512 KiB of the file in a chunk; the largest multiple of 3 within it (524,286 bytes), so its base64 has no padding. */
export const SAVE_CHUNK_BYTES = Math.floor((512 * 1024) / 3) * 3

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

/**
 * Hands `file` to the app as `name`, for it to save or share (`action`). Resolves once the last chunk is posted, so a button can
 * stay busy until then; rejects if a chunk can't be read or posted (what was sent stays unfinished: no chunk says done).
 * `post` is the bridge (tellStash); tests hand their own.
 */
export async function handToApp(file: Blob, name: string, action: SaveAction, post: (msg: SaveMessage) => void = tellStash): Promise<void> {
  const id = saveId()
  const mime = file.type || 'application/octet-stream'
  const size = file.size
  // An empty file is still one chunk, the last, so the app hears it whole
  for (let seq = 0, at = 0; ; seq++, at += SAVE_CHUNK_BYTES) {
    const end = Math.min(at + SAVE_CHUNK_BYTES, size)
    // Read one chunk at a time: the read is async, so the page paints (and its busy button shows) between chunks
    const bytes = new Uint8Array(await file.slice(at, end).arrayBuffer())
    const done = end >= size
    post({ type: 'stash:save', id, name, mime, action, seq, done, data: base64(bytes) })
    if (done) return
  }
}
