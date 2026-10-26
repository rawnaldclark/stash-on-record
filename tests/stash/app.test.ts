import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ArchivePlay } from '../../src/stash/embed'
import type { LoadResult } from '../../src/types'

/*
 * The record inside the Stash app. embed.ts decides at load which host it's in, so each test loads it (and app.ts) afresh under a
 * window of its own: the app's WebView, with the StashHost bridge androidx.webkit puts there, or the player's frame.
 */

const ORIGIN = 'https://appassets.androidplatform.net'

const CHOSEN = 1
const DONE = 2
const SKIPPED = 4
const REASONS = 32
const LASTFM = 64
const ESTIMATED = 128
const STASH = 256

/** A window at `search`; framed by a parent of its own, or on its own (its own parent, as the app's WebView is). */
function fakeWindow(search: string, opts: { framed?: boolean; StashHost?: unknown } = {}) {
  const parent = { postMessage: vi.fn() }
  const self: Record<string, unknown> = {
    location: { search, origin: ORIGIN },
    addEventListener: () => {},
    removeEventListener: () => {},
    postMessage: vi.fn(),
    StashHost: opts.StashHost,
  }
  self.parent = opts.framed ? parent : self
  return { self, parent }
}

/** Loads the record's modules afresh under `win`. */
async function load(win: Record<string, unknown>) {
  vi.stubGlobal('window', win)
  vi.resetModules()
  const embed = await import('../../src/stash/embed')
  const app = await import('../../src/stash/app')
  return { embed, app }
}

/** The record in the app: what it sent the app (parsed), and a way to be the app sending something. */
async function inApp() {
  const sent: { type: string; [k: string]: unknown }[] = []
  const host = { postMessage: (s: string) => void sent.push(JSON.parse(s)), onmessage: null as ((e: { data: unknown }) => void) | null }
  const { self } = fakeWindow('?embed=stash-app', { StashHost: host })
  const modules = await load(self)
  const fromApp = (msg: unknown) => host.onmessage?.({ data: JSON.stringify(msg) })
  const hellos = () => sent.filter((m) => m.type === 'stash:hello')
  return { ...modules, sent, fromApp, hellos, host }
}

const T = Date.UTC(2024, 4, 1, 12)
let ids = 0
const row = (t: string, f: number, ms = 200_000, s = T + ids * 600_000): ArchivePlay => ({ id: `r${++ids}`, t, a: 'Band', al: 'Album', s, ms, f })
const chunk = (rows: unknown[], seq: number, done: boolean) => ({ type: 'stash:archive', rows, seq, done })

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('finding the host', () => {
  it('is the app with ?embed=stash-app and its bridge, and counts as inside Stash', async () => {
    const { embed, sent } = await inApp()
    expect(embed.APP_HOST).toBe(true)
    expect(embed.EMBEDDED).toBe(true)
    embed.tellStash({ type: 'stash:close' })
    expect(sent).toEqual([{ type: 'stash:close' }])
  })

  it('is nowhere at ?embed=stash-app without the bridge (the address opened in a browser), and says nothing', async () => {
    const { self } = fakeWindow('?embed=stash-app')
    const { embed } = await load(self)
    expect(embed.APP_HOST).toBe(false)
    expect(embed.EMBEDDED).toBe(false)
    embed.tellStash({ type: 'stash:close' })
    expect(self.postMessage).not.toHaveBeenCalled()
  })

  it('is still the player’s frame at ?embed=stash, talking to the parent as before, even with a bridge on the window', async () => {
    const host = { postMessage: vi.fn(), onmessage: null }
    const { self, parent } = fakeWindow('?embed=stash', { framed: true, StashHost: host })
    const { embed } = await load(self)
    expect(embed.APP_HOST).toBe(false)
    expect(embed.EMBEDDED).toBe(true)
    embed.tellStash({ type: 'stash:ready', plays: 3 })
    expect(parent.postMessage).toHaveBeenCalledWith({ type: 'stash:ready', plays: 3 }, ORIGIN)
    expect(host.postMessage).not.toHaveBeenCalled()
    expect(host.onmessage).toBeNull()
  })

  it('drops stash:live from the app: the app stacks every source itself', async () => {
    const { embed, fromApp } = await inApp()
    const heard = vi.fn()
    embed.onStash(heard)
    fromApp({ type: 'stash:live', plays: [{ t: 'Song', a: 'Band', s: T, ms: 200_000 }] })
    expect(heard).not.toHaveBeenCalled()
    fromApp({ type: 'stash:theme', theme: 'light' })
    expect(heard).toHaveBeenCalledWith({ type: 'stash:theme', theme: 'light' })
  })
})

describe('the archive from the app', () => {
  it('says hello once it listens, and presses the record from the chunks once the last is in', async () => {
    const { embed, app, sent, fromApp } = await inApp()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const pressed = vi.fn<(r: LoadResult) => void>()
    app.archiveFromApp(pressed)
    expect(sent).toEqual([{ type: 'stash:hello', v: 1 }])

    // Every source, as the app stacks them: Spotify's (one a skip), Stash's own (one estimated), Last.fm's
    const first = [row('Spotify listen', CHOSEN | DONE | REASONS), row('Spotify skip', SKIPPED | REASONS, 5_000), row('Stash play', STASH)]
    const second = [row('Stash estimated', STASH | ESTIMATED, 210_000), row('Scrobble', LASTFM, 210_000), row('Scrobble estimated', LASTFM | ESTIMATED, 210_000)]
    // Rows that can't be plays, which the app should never send but the record mustn't trust
    const bad = [
      null,
      'row',
      { ...row('x', 0), t: '' },
      { ...row('x', 0), t: 'x'.repeat(301) },
      { ...row('x', 0), a: undefined },
      { ...row('x', 0), al: 7 },
      { ...row('x', 0), id: 1 },
      { ...row('x', 0), s: 0 },
      { ...row('x', 0), s: null }, // NaN, as JSON writes it
      { ...row('x', 0), ms: -1 },
      { ...row('x', 0), ms: 6 * 3_600_000 + 1 },
      { ...row('x', 0), f: 1.5 },
      { ...row('x', 0), f: -1 },
      { ...row('x', 0), f: '2' },
    ]
    fromApp(chunk(first, 0, false))
    expect(pressed).not.toHaveBeenCalled()
    fromApp(chunk([...second, ...bad], 1, true))
    expect(pressed).toHaveBeenCalledOnce()

    const result = pressed.mock.calls[0][0]
    // Pressed exactly as this browser's archive is (toPlay, sorted by end time)
    expect(result).toEqual(embed.fromArchive([...first, ...second]))
    expect(result.plays).toHaveLength(6)
    expect(result.filesRead).toEqual(['Your Spotify history in Stash'])
    expect(result.plays.map((p) => p.platform)).toEqual(['Spotify', 'Spotify', 'Stash', 'Stash', 'Last.fm', 'Last.fm'])
    // Listens of 30 s or more, per source: the skip isn't one
    expect(embed.countSources(result.plays, [])).toEqual({ spotify: 1, stash: 2, lastfm: 2 })
    expect(embed.stack(result.plays, [], { spotify: true, stash: true, lastfm: true })).toHaveLength(6)
    // Only how many were left out, never their words
    expect(warn).toHaveBeenCalledOnce()
    expect(warn.mock.calls[0][0]).toContain(`${bad.length} of the app's rows`)
  })

  it('presses an empty archive as no plays, and warns of nothing', async () => {
    const { app, fromApp } = await inApp()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const pressed = vi.fn<(r: LoadResult) => void>()
    app.archiveFromApp(pressed)
    fromApp(chunk([], 0, true))
    expect(pressed).toHaveBeenCalledWith({ plays: [], filesRead: [], skippedRows: 0, duplicateRows: 0, warnings: [] })
    expect(warn).not.toHaveBeenCalled()
  })

  it('says hello again on stash:reload, and drops what was still coming in answer to the older hello', async () => {
    const { app, fromApp, hellos } = await inApp()
    const pressed = vi.fn<(r: LoadResult) => void>()
    app.archiveFromApp(pressed)
    const before = [row('Before 1', STASH), row('Before 2', STASH)]
    fromApp(chunk([before[0]], 0, false))
    fromApp({ type: 'stash:reload' })
    expect(hellos()).toEqual([
      { type: 'stash:hello', v: 1 },
      { type: 'stash:hello', v: 1 },
    ])
    // The rest of the older answer, still on its way
    fromApp(chunk([before[1]], 1, true))
    expect(pressed).not.toHaveBeenCalled()
    // The answer to the new hello
    const after = [row('After 1', STASH), row('After 2', STASH), row('After 3', STASH)]
    fromApp(chunk(after.slice(0, 2), 0, false))
    fromApp(chunk(after.slice(2), 1, true))
    expect(pressed).toHaveBeenCalledOnce()
    expect(pressed.mock.calls[0][0].plays.map((p) => p.title)).toEqual(['After 1', 'After 2', 'After 3'])
  })

  it('drops a chunk out of order, and anything after the last', async () => {
    const { app, fromApp } = await inApp()
    const pressed = vi.fn<(r: LoadResult) => void>()
    app.archiveFromApp(pressed)
    fromApp(chunk([row('One', 0)], 0, false))
    fromApp(chunk([row('Three', 0)], 2, false)) // ahead of its turn
    fromApp(chunk([row('Two', 0)], 1, true))
    fromApp(chunk([row('Late', 0)], 2, true)) // after the last
    expect(pressed).toHaveBeenCalledOnce()
    expect(pressed.mock.calls[0][0].plays.map((p) => p.title)).toEqual(['One', 'Two'])
  })

  it('drops a chunk that isn’t one', async () => {
    const { app, fromApp } = await inApp()
    const pressed = vi.fn<(r: LoadResult) => void>()
    app.archiveFromApp(pressed)
    fromApp(chunk([row('One', 0)], 0, false))
    for (const odd of [
      { type: 'stash:archive', rows: 'rows', seq: 1, done: true },
      { type: 'stash:archive', seq: 1, done: true },
      { type: 'stash:archive', rows: [row('Odd', 0)], seq: '1', done: true },
      { type: 'stash:archive', rows: [row('Odd', 0)], seq: 1.5, done: true },
      { type: 'stash:archive', rows: [row('Odd', 0)], seq: -1, done: true },
    ]) {
      fromApp(odd)
    }
    expect(pressed).not.toHaveBeenCalled()
    // done must be true itself: anything else isn't the end
    fromApp(chunk([row('Two', 0)], 1, 'yes' as unknown as boolean))
    expect(pressed).not.toHaveBeenCalled()
    fromApp(chunk([row('Three', 0)], 2, true))
    expect(pressed.mock.calls[0][0].plays.map((p) => p.title)).toEqual(['One', 'Two', 'Three'])
  })

  it('starts over when the app starts a new answer, and presses each whole one (the last stays)', async () => {
    const { app, fromApp } = await inApp()
    const pressed = vi.fn<(r: LoadResult) => void>()
    app.archiveFromApp(pressed)
    fromApp(chunk([row('Abandoned', 0)], 0, false))
    fromApp(chunk([row('First', 0)], 0, true))
    fromApp(chunk([row('Second', 0)], 0, true))
    expect(pressed.mock.calls.map(([r]) => r.plays.map((p) => p.title))).toEqual([['First'], ['Second']])
  })

  it('takes chunks of 20k rows', async () => {
    const { app, fromApp } = await inApp()
    const pressed = vi.fn<(r: LoadResult) => void>()
    app.archiveFromApp(pressed)
    const many = (n: number, from: number) => Array.from({ length: n }, (_, i) => ({ id: `m${from + i}`, t: `Song ${i % 500}`, a: 'Band', s: T + (from + i) * 240_000, ms: 200_000, f: STASH }))
    fromApp(chunk(many(20_000, 0), 0, false))
    fromApp(chunk(many(20_000, 20_000), 1, false))
    fromApp(chunk(many(1_234, 40_000), 2, true))
    expect(pressed.mock.calls[0][0].plays).toHaveLength(41_234)
  })

  it('stops listening when stopped', async () => {
    const { app, fromApp, hellos } = await inApp()
    const pressed = vi.fn<(r: LoadResult) => void>()
    const stop = app.archiveFromApp(pressed)
    stop()
    fromApp({ type: 'stash:reload' })
    fromApp(chunk([row('One', 0)], 0, true))
    expect(hellos()).toHaveLength(1)
    expect(pressed).not.toHaveBeenCalled()
  })
})

describe('a row from the app', () => {
  it('keeps only an ArchivePlay’s own fields, and reads a missing album or id written as null as none', async () => {
    const { app } = await inApp()
    expect(app.archiveRow({ id: 'a', t: 'T', a: 'A', al: null, sid: null, s: T, ms: 0, f: 0, ip: '10.0.0.1', extra: { x: 1 } })).toEqual({ id: 'a', t: 'T', a: 'A', s: T, ms: 0, f: 0 })
    expect(app.archiveRow({ id: 'a', t: 'T', a: 'A', al: 'L', sid: '4uLU6hMCjMI75M1A2tKUQC', s: T, ms: 6 * 3_600_000, f: STASH | SKIPPED })).toEqual({
      id: 'a',
      t: 'T',
      a: 'A',
      al: 'L',
      sid: '4uLU6hMCjMI75M1A2tKUQC',
      s: T,
      ms: 6 * 3_600_000,
      f: STASH | SKIPPED,
    })
    expect(app.archiveRow({ id: 'a', t: 'x'.repeat(300), a: 'A', s: T, ms: 1, f: 0 })).not.toBeNull()
    expect(app.archiveRow({ id: 'a', t: 'T', a: 'A', s: T, ms: 1, f: 0, sid: 'x'.repeat(301) })).toBeNull()
    expect(app.archiveRow({ id: 'a', t: 'T', a: 'A', s: Infinity, ms: 1, f: 0 })).toBeNull()
  })
})
