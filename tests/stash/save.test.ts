import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FromStash } from '../../src/stash/embed'
import {
  abandonSaves,
  base64,
  handToApp,
  SAVE_ACK_TIMEOUT_MS,
  SAVE_CHUNK_BYTES,
  SAVE_WINDOW,
  saveId,
  SaveFailed,
  type SaveAbort,
  type SaveChannel,
  type SaveMessage,
} from '../../src/stash/save'

/*
 * A poster or the race video handed to the Stash app (stash:save), chunk by chunk. The app decodes each chunk's base64 and
 * appends the bytes, and acks each chunk it has taken (stash:save-ack); the record keeps at most two unacked and gives a file up
 * (stash:save-abort) when the app goes quiet or the page goes away. So the tests check the chunks' edges, the encoding, the ids,
 * and the flow: the window, the acks that count and the ones that don't, the timeout and the teardown.
 */

const KIB = 1024

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** Standard base64 (RFC 4648 §4, padded), written out plainly to check the page's encoder against. */
function reference(bytes: Uint8Array): string {
  const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0)
    out += abc[(n >> 18) & 63] + abc[(n >> 12) & 63]
    out += i + 1 < bytes.length ? abc[(n >> 6) & 63] : '='
    out += i + 2 < bytes.length ? abc[n & 63] : '='
  }
  return out
}

function decode(data: string): Uint8Array {
  const binary = atob(data)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

/** Where two byte runs first differ, -1 when they're the same (toEqual walks a megabyte one element at a time, slowly) */
function firstDifference(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length) return Math.min(a.length, b.length)
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return i
  return -1
}

/** `n` bytes that differ from their neighbours, so a chunk put back in the wrong place shows */
const bytesOf = (n: number) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + (i >> 8) * 7 + 11) & 255)

/**
 * The app's side of the bridge. `auto` acks each chunk as it arrives (a tick later, as a real bridge answers); otherwise the
 * test acks with `ack`. `chunks` and `aborts` are what the record sent it.
 */
function fakeApp({ auto = false } = {}) {
  const sent: (SaveMessage | SaveAbort)[] = []
  const handlers = new Set<(m: FromStash) => void>()
  const say = (m: unknown) => {
    for (const h of [...handlers]) h(m as FromStash)
  }
  const channel: SaveChannel = {
    post(m) {
      sent.push(m)
      if (auto && m.type === 'stash:save') queueMicrotask(() => say({ type: 'stash:save-ack', id: m.id, seq: m.seq }))
    },
    listen(h) {
      handlers.add(h)
      return () => void handlers.delete(h)
    },
  }
  return {
    channel,
    chunks: () => sent.filter((m): m is SaveMessage => m.type === 'stash:save'),
    aborts: () => sent.filter((m) => m.type === 'stash:save-abort'),
    ack: (id: string, seq: unknown) => say({ type: 'stash:save-ack', id, seq }),
    say,
    listening: () => handlers.size,
  }
}

/** A hand-over's promise, and whether it has settled yet */
function track(p: Promise<void>) {
  const state = { settled: false, error: undefined as unknown }
  p.then(
    () => void (state.settled = true),
    (e) => void ((state.settled = true), (state.error = e)),
  )
  return state
}

/** Lets the reads already started finish (a chunk is read before it goes), then a little more: nothing else should go */
const quiet = () => new Promise((resolve) => setTimeout(resolve, 30))

/** Hands `n` bytes to an app that acks everything, and returns the chunks posted */
async function handOver(n: number, opts: { type?: string; name?: string; action?: 'save' | 'share' } = {}) {
  const app = fakeApp({ auto: true })
  const bytes = bytesOf(n)
  await handToApp(new Blob([bytes], opts.type === undefined ? {} : { type: opts.type }), opts.name ?? 'stash-record.png', opts.action ?? 'save', { channel: app.channel })
  return { sent: app.chunks(), bytes, app }
}

/** Puts the file back together the way the app does: each chunk decoded on its own, the bytes appended */
const joined = (sent: SaveMessage[]) => {
  const parts = sent.map((m) => decode(m.data))
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

/** A file of `chunks` whole chunks */
const fileOf = (chunks: number) => new Blob([bytesOf(chunks * SAVE_CHUNK_BYTES)], { type: 'video/mp4' })

describe('base64', () => {
  it('is standard, padded base64 (the RFC 4648 vectors)', () => {
    const vectors: [string, string][] = [
      ['', ''],
      ['f', 'Zg=='],
      ['fo', 'Zm8='],
      ['foo', 'Zm9v'],
      ['foob', 'Zm9vYg=='],
      ['fooba', 'Zm9vYmE='],
      ['foobar', 'Zm9vYmFy'],
    ]
    for (const [text, b64] of vectors) expect(base64(new TextEncoder().encode(text))).toBe(b64)
  })

  it('encodes every byte value, and runs far past one call’s worth of characters, exactly', () => {
    const all = Uint8Array.from({ length: 256 }, (_, i) => i)
    expect(base64(all)).toBe(reference(all))
    for (const n of [0x2000 - 1, 0x2000, 0x2000 + 1, 100_003]) {
      const bytes = bytesOf(n)
      expect(base64(bytes)).toBe(reference(bytes))
    }
  })

  it('uses the browser’s own encoder where there is one', () => {
    const native = vi.fn(function (this: Uint8Array) {
      return `native:${this.length}`
    })
    Object.defineProperty(Uint8Array.prototype, 'toBase64', { value: native, configurable: true, writable: true })
    try {
      expect(base64(new Uint8Array(5))).toBe('native:5')
      expect(native).toHaveBeenCalledOnce()
    } finally {
      delete (Uint8Array.prototype as { toBase64?: unknown }).toBase64
    }
  })
})

describe('the chunks', () => {
  it('cuts chunks of at most 512 KiB, each but the last a whole number of 3-byte groups', () => {
    expect(SAVE_CHUNK_BYTES).toBeLessThanOrEqual(512 * KIB)
    expect(SAVE_CHUNK_BYTES % 3).toBe(0)
    // The largest such size: three more bytes would pass 512 KiB
    expect(SAVE_CHUNK_BYTES + 3).toBeGreaterThan(512 * KIB)
  })

  it.each([
    ['one byte', 1, 1],
    ['a byte short of a chunk', SAVE_CHUNK_BYTES - 1, 1],
    ['exactly a chunk', SAVE_CHUNK_BYTES, 1],
    ['a byte past a chunk', SAVE_CHUNK_BYTES + 1, 2],
    ['exactly 512 KiB', 512 * KIB, 2],
    ['two chunks and a bit', 2 * SAVE_CHUNK_BYTES + 5, 3],
    ['exactly three chunks', 3 * SAVE_CHUNK_BYTES, 3],
  ])('%s: the chunks in order, done on the last only, the bytes put back exactly', async (_, n, chunks) => {
    const { sent, bytes } = await handOver(n)
    expect(sent).toHaveLength(chunks)
    expect(sent.map((m) => m.seq)).toEqual(Array.from({ length: chunks }, (_, i) => i))
    expect(sent.map((m) => m.done)).toEqual(Array.from({ length: chunks }, (_, i) => i === chunks - 1))
    for (const [i, m] of sent.entries()) {
      const size = decode(m.data).length
      expect(size).toBeLessThanOrEqual(512 * KIB)
      if (i < chunks - 1) {
        expect(size).toBe(SAVE_CHUNK_BYTES)
        // No padding but the last chunk's, so the strings joined are the file's base64 too
        expect(m.data).not.toContain('=')
      }
    }
    expect(firstDifference(joined(sent), bytes)).toBe(-1)
    // toBe on the strings themselves would print megabytes on a failure: compare, then say so
    expect(sent.map((m) => m.data).join('') === reference(bytes)).toBe(true)
    // One file, one id, one name, one type, one action
    expect(new Set(sent.map((m) => `${m.id}|${m.name}|${m.mime}|${m.action}`)).size).toBe(1)
  })

  it('carries the file’s name, its type (or a plain one when it has none) and what to do with it', async () => {
    const video = await handOver(10, { type: 'video/mp4', name: 'stash-race.mp4', action: 'share' })
    expect(video.sent[0]).toMatchObject({ type: 'stash:save', name: 'stash-race.mp4', mime: 'video/mp4', action: 'share' })
    const untyped = await handOver(10, { name: 'file.bin', action: 'save' })
    expect(untyped.sent[0]).toMatchObject({ name: 'file.bin', mime: 'application/octet-stream', action: 'save' })
  })

  it('gives every file an id of its own', async () => {
    const ids = new Set(Array.from({ length: 1000 }, saveId))
    expect(ids.size).toBe(1000)
    const a = await handOver(SAVE_CHUNK_BYTES + 1)
    const b = await handOver(SAVE_CHUNK_BYTES + 1)
    expect(a.sent[0].id).not.toBe(b.sent[0].id)
    expect(a.sent[1].id).toBe(a.sent[0].id)
  })

  it('still gives distinct ids where the browser can’t make random ones', async () => {
    vi.stubGlobal('crypto', undefined)
    const ids = new Set(Array.from({ length: 1000 }, saveId))
    expect(ids.size).toBe(1000)
    const { sent } = await handOver(3)
    expect(sent[0].id).toMatch(/^[0-9a-z]+-[0-9a-z]+-[0-9a-z]*$/)
  })
})

describe('the flow', () => {
  it(`holds at ${SAVE_WINDOW} chunks unacked`, async () => {
    expect(SAVE_WINDOW).toBe(2)
    const app = fakeApp()
    const done = track(handToApp(fileOf(5), 'race.mp4', 'save', { channel: app.channel }))
    await vi.waitFor(() => expect(app.chunks()).toHaveLength(2))
    await quiet()
    expect(app.chunks().map((m) => m.seq)).toEqual([0, 1])
    expect(done.settled).toBe(false)
  })

  it('sends the next chunk for each ack, never more than two ahead, and is done when the last is acked', async () => {
    const app = fakeApp()
    const done = track(handToApp(fileOf(4), 'race.mp4', 'save', { channel: app.channel }))
    await vi.waitFor(() => expect(app.chunks()).toHaveLength(2))
    const id = app.chunks()[0].id
    app.ack(id, 0)
    await vi.waitFor(() => expect(app.chunks()).toHaveLength(3))
    await quiet()
    expect(app.chunks()).toHaveLength(3)
    app.ack(id, 1)
    await vi.waitFor(() => expect(app.chunks()).toHaveLength(4))
    expect(app.chunks().map((m) => [m.seq, m.done])).toEqual([
      [0, false],
      [1, false],
      [2, false],
      [3, true],
    ])
    app.ack(id, 2)
    await quiet()
    expect(done.settled).toBe(false)
    app.ack(id, 3)
    await vi.waitFor(() => expect(done.settled).toBe(true))
    expect(done.error).toBeUndefined()
    expect(app.aborts()).toEqual([])
    expect(app.listening()).toBe(0)
  })

  it('ignores an ack for another file, for a chunk not sent, for one acked already, or not an ack at all', async () => {
    const app = fakeApp()
    track(handToApp(fileOf(4), 'race.mp4', 'save', { channel: app.channel }))
    await vi.waitFor(() => expect(app.chunks()).toHaveLength(2))
    const id = app.chunks()[0].id
    app.ack('another-file', 0)
    app.ack(id, 2) // not sent yet
    app.ack(id, '0') // a seq that isn't a number
    app.say({ type: 'stash:back' })
    await quiet()
    expect(app.chunks()).toHaveLength(2)
    app.ack(id, 0)
    await vi.waitFor(() => expect(app.chunks()).toHaveLength(3))
    app.ack(id, 0) // again: frees nothing more
    await quiet()
    expect(app.chunks()).toHaveLength(3)
  })

  it('takes acks in any order', async () => {
    const app = fakeApp()
    const done = track(handToApp(fileOf(4), 'race.mp4', 'save', { channel: app.channel }))
    await vi.waitFor(() => expect(app.chunks()).toHaveLength(2))
    const id = app.chunks()[0].id
    app.ack(id, 1)
    await vi.waitFor(() => expect(app.chunks()).toHaveLength(3))
    app.ack(id, 0)
    await vi.waitFor(() => expect(app.chunks()).toHaveLength(4))
    app.ack(id, 3)
    await quiet()
    expect(done.settled).toBe(false)
    app.ack(id, 2)
    await vi.waitFor(() => expect(done.settled).toBe(true))
    expect(done.error).toBeUndefined()
  })

  it('sends an empty file as one chunk, the last, with nothing in it, and is done once it is acked', async () => {
    const app = fakeApp()
    const done = track(handToApp(new Blob([], { type: 'image/png' }), 'empty.png', 'share', { channel: app.channel }))
    await vi.waitFor(() => expect(app.chunks()).toHaveLength(1))
    const [chunk] = app.chunks()
    expect(chunk).toEqual({ type: 'stash:save', id: chunk.id, name: 'empty.png', mime: 'image/png', action: 'share', seq: 0, done: true, data: '' })
    await quiet()
    expect(done.settled).toBe(false)
    app.ack(chunk.id, 0)
    await vi.waitFor(() => expect(done.settled).toBe(true))
    expect(done.error).toBeUndefined()
  })

  it('gives the file up when no ack comes in time: stops, tells the app, frees the button', async () => {
    const app = fakeApp()
    const done = track(handToApp(fileOf(5), 'race.mp4', 'save', { channel: app.channel, timeoutMs: 40 }))
    await vi.waitFor(() => expect(done.settled).toBe(true))
    expect(done.error).toBeInstanceOf(SaveFailed)
    expect((done.error as SaveFailed).reason).toBe('timeout')
    const id = app.chunks()[0].id
    expect(app.aborts()).toEqual([{ type: 'stash:save-abort', id }])
    // Nothing more goes, even for an ack that comes late
    app.ack(id, 0)
    await quiet()
    expect(app.chunks()).toHaveLength(2)
    expect(app.listening()).toBe(0)
  })

  it(`waits ${SAVE_ACK_TIMEOUT_MS / 1000} s from the last ack, and gives up after the last chunk too if its ack never comes`, async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const app = fakeApp()
    const done = track(handToApp(fileOf(3), 'race.mp4', 'save', { channel: app.channel }))
    await vi.waitFor(() => expect(app.chunks()).toHaveLength(2), { interval: 1 })
    const id = app.chunks()[0].id
    vi.advanceTimersByTime(SAVE_ACK_TIMEOUT_MS - 100)
    // An ack counts the wait from the start again
    app.ack(id, 0)
    await vi.waitFor(() => expect(app.chunks()).toHaveLength(3), { interval: 1 })
    vi.advanceTimersByTime(SAVE_ACK_TIMEOUT_MS - 100)
    await Promise.resolve()
    expect(done.settled).toBe(false)
    app.ack(id, 1)
    vi.advanceTimersByTime(SAVE_ACK_TIMEOUT_MS - 100)
    await Promise.resolve()
    expect(done.settled).toBe(false)
    // The last chunk's ack never comes
    vi.advanceTimersByTime(200)
    await vi.waitFor(() => expect(done.settled).toBe(true), { interval: 1 })
    expect((done.error as SaveFailed).reason).toBe('timeout')
    expect(app.aborts()).toEqual([{ type: 'stash:save-abort', id }])
  })

  it('gives every file on its way up when the page goes away, telling the app for each', async () => {
    const app = fakeApp()
    const a = track(handToApp(fileOf(3), 'a.mp4', 'save', { channel: app.channel }))
    const b = track(handToApp(fileOf(3), 'b.png', 'share', { channel: app.channel }))
    await vi.waitFor(() => expect(app.chunks()).toHaveLength(4))
    abandonSaves()
    await vi.waitFor(() => expect(a.settled && b.settled).toBe(true))
    expect([a, b].map((x) => (x.error as SaveFailed).reason)).toEqual(['teardown', 'teardown'])
    const ids = [...new Set(app.chunks().map((m) => m.id))]
    expect(app.aborts()).toEqual(ids.map((id) => ({ type: 'stash:save-abort', id })))
    // Done with: a second teardown tells nothing more
    abandonSaves()
    expect(app.aborts()).toHaveLength(2)
  })

  it('gives up, and says so, when a chunk can’t be posted', async () => {
    let calls = 0
    const sent: unknown[] = []
    const channel: SaveChannel = {
      post(m) {
        if (m.type === 'stash:save' && ++calls === 2) throw new Error('the bridge is gone')
        sent.push(m)
      },
      listen: () => () => {},
    }
    await expect(handToApp(fileOf(3), 'big.png', 'save', { channel })).rejects.toMatchObject({ name: 'SaveFailed', reason: 'post' })
    expect(sent.map((m) => (m as { type: string }).type)).toEqual(['stash:save', 'stash:save-abort'])
  })
})

/** The record in the app's WebView: its bridge, what it sent (parsed), and a way to be the app */
async function inApp() {
  const posted: { type: string; [k: string]: unknown }[] = []
  const listeners = new Map<string, () => void>()
  const host = { postMessage: (s: string) => void posted.push(JSON.parse(s)), onmessage: null as ((e: { data: unknown }) => void) | null }
  vi.stubGlobal('window', {
    location: { search: '?embed=stash-app', origin: 'https://appassets.androidplatform.net' },
    addEventListener: (type: string, fn: () => void) => void listeners.set(type, fn),
    removeEventListener: () => {},
    StashHost: host,
    get parent() {
      return this
    },
  })
  vi.resetModules()
  const save = await import('../../src/stash/save')
  return { save, posted, fromApp: (msg: unknown) => host.onmessage?.({ data: JSON.stringify(msg) }), listeners }
}

describe('inside the app', () => {
  it('goes over the app’s bridge as JSON strings, and hears the app’s acks the same way', async () => {
    const { save, posted, fromApp } = await inApp()
    const done = track(save.handToApp(new Blob([bytesOf(4)], { type: 'image/png' }), 'stash-record-2026-deep.png', 'save'))
    await vi.waitFor(() => expect(posted).toHaveLength(1))
    expect(posted[0]).toEqual({
      type: 'stash:save',
      id: expect.any(String),
      name: 'stash-record-2026-deep.png',
      mime: 'image/png',
      action: 'save',
      seq: 0,
      done: true,
      data: reference(bytesOf(4)),
    })
    fromApp({ type: 'stash:save-ack', id: posted[0].id, seq: 0 })
    await vi.waitFor(() => expect(done.settled).toBe(true))
    expect(done.error).toBeUndefined()
  })

  it('gives up what’s on its way when the page is hidden for good (pagehide), telling the app', async () => {
    const { save, posted, listeners } = await inApp()
    const done = track(save.handToApp(new Blob([bytesOf(SAVE_CHUNK_BYTES * 3)]), 'race.mp4', 'save'))
    await vi.waitFor(() => expect(posted).toHaveLength(2))
    listeners.get('pagehide')?.()
    await vi.waitFor(() => expect(done.settled).toBe(true))
    expect(posted.at(-1)).toEqual({ type: 'stash:save-abort', id: posted[0].id })
  })

  it('says nothing outside Stash, and doesn’t wait for an ack no one would send', async () => {
    const parent = { postMessage: vi.fn() }
    vi.stubGlobal('window', { location: { search: '', origin: 'https://example.com' }, addEventListener: () => {}, removeEventListener: () => {}, parent })
    vi.resetModules()
    const save = await import('../../src/stash/save')
    await expect(save.handToApp(new Blob([bytesOf(4)]), 'x.png', 'save')).rejects.toMatchObject({ reason: 'no-app' })
    expect(parent.postMessage).not.toHaveBeenCalled()
  })
})
