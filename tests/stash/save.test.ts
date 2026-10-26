import { afterEach, describe, expect, it, vi } from 'vitest'
import { base64, handToApp, SAVE_CHUNK_BYTES, saveId, type SaveMessage } from '../../src/stash/save'

/*
 * A poster or the race video handed to the Stash app (stash:save), chunk by chunk. The app decodes each chunk's base64 and
 * appends the bytes, so the tests check the chunks' edges, the encoding, and that every file's chunks share an id of their own.
 */

const KIB = 1024

afterEach(() => {
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

/** Hands `n` bytes over and returns the chunks posted */
async function handOver(n: number, opts: { type?: string; name?: string; action?: 'save' | 'share' } = {}) {
  const sent: SaveMessage[] = []
  const bytes = bytesOf(n)
  await handToApp(new Blob([bytes], opts.type === undefined ? {} : { type: opts.type }), opts.name ?? 'stash-record.png', opts.action ?? 'save', (m) => void sent.push(m))
  return { sent, bytes }
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

describe('handing a file to the app', () => {
  it('sends an empty file as one chunk, the last, with nothing in it', async () => {
    const { sent } = await handOver(0, { type: 'image/png', name: 'empty.png', action: 'share' })
    expect(sent).toEqual([{ type: 'stash:save', id: sent[0].id, name: 'empty.png', mime: 'image/png', action: 'share', seq: 0, done: true, data: '' }])
    expect(sent[0].id).toBeTruthy()
  })

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

  it('resolves once the last chunk is posted, and rejects (sending no more) when posting fails', async () => {
    const sent: SaveMessage[] = []
    const done = handToApp(new Blob([bytesOf(2 * SAVE_CHUNK_BYTES + 1)]), 'big.png', 'save', (m) => void sent.push(m))
    expect(sent.some((m) => m.done)).toBe(false)
    await done
    expect(sent.map((m) => m.done)).toEqual([false, false, true])

    let calls = 0
    const failing = handToApp(new Blob([bytesOf(2 * SAVE_CHUNK_BYTES + 1)]), 'big.png', 'save', () => {
      calls++
      if (calls === 2) throw new Error('the bridge is gone')
    })
    await expect(failing).rejects.toThrow('the bridge is gone')
    expect(calls).toBe(2)
  })
})

describe('inside the app', () => {
  it('goes over the app’s bridge as JSON strings, as every message to the app does', async () => {
    const posted: string[] = []
    const host = { postMessage: (s: string) => void posted.push(s), onmessage: null }
    vi.stubGlobal('window', {
      location: { search: '?embed=stash-app', origin: 'https://appassets.androidplatform.net' },
      addEventListener: () => {},
      removeEventListener: () => {},
      StashHost: host,
      get parent() {
        return this
      },
    })
    vi.resetModules()
    const save = await import('../../src/stash/save')
    await save.handToApp(new Blob([bytesOf(4)], { type: 'image/png' }), 'stash-record-2026-deep.png', 'save')
    expect(posted).toHaveLength(1)
    expect(JSON.parse(posted[0])).toEqual({
      type: 'stash:save',
      id: expect.any(String),
      name: 'stash-record-2026-deep.png',
      mime: 'image/png',
      action: 'save',
      seq: 0,
      done: true,
      data: reference(bytesOf(4)),
    })
  })

  it('says nothing outside Stash (the bridge is the only way out, and only the app host calls this)', async () => {
    const parent = { postMessage: vi.fn() }
    vi.stubGlobal('window', {
      location: { search: '', origin: 'https://example.com' },
      addEventListener: () => {},
      removeEventListener: () => {},
      parent,
    })
    vi.resetModules()
    const save = await import('../../src/stash/save')
    await save.handToApp(new Blob([bytesOf(4)]), 'x.png', 'save')
    expect(parent.postMessage).not.toHaveBeenCalled()
  })
})
