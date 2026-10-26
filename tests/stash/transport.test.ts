import { describe, expect, it, vi } from 'vitest'
import { appHostOf, appTransport, frameTransport, inPlayerFrame, readAppMessage, type Envelope, type HostWindow, type StashHost } from '../../src/stash/transport'

const ORIGIN = 'https://appassets.androidplatform.net'

/** A window for the transport: framed by `parent` (or on its own), at `search`, with `extra` on it (the app's bridge). */
function fakeWindow(search: string, opts: { framed?: boolean; extra?: Record<string, unknown> } = {}) {
  const listeners = new Set<(e: MessageEvent) => void>()
  const parent = { postMessage: vi.fn() }
  const self: Record<string, unknown> = {
    location: { search, origin: ORIGIN },
    addEventListener: (_: 'message', l: (e: MessageEvent) => void) => void listeners.add(l),
    removeEventListener: (_: 'message', l: (e: MessageEvent) => void) => void listeners.delete(l),
    ...opts.extra,
  }
  // On its own, a window is its own parent
  self.parent = opts.framed === false ? self : parent
  const win = self as unknown as HostWindow
  /** A message event reaching the window, from `source` at `origin` */
  const dispatch = (data: unknown, source: unknown = parent, origin = ORIGIN) => {
    for (const l of [...listeners]) l({ data, source, origin } as MessageEvent)
  }
  return { win, parent, dispatch, listeners }
}

/** The app's bridge as androidx.webkit injects it: postMessage out, one onmessage slot in. */
function fakeHost() {
  const sent: string[] = []
  const host: StashHost = { postMessage: (s: string) => void sent.push(s), onmessage: null }
  /** The app posting `data` (a string, as the bridge carries it) */
  const receive = (data: unknown) => host.onmessage?.({ data })
  return { host, sent, receive }
}

const ACCEPTS: ReadonlySet<string> = new Set(['stash:reload', 'stash:back', 'stash:archive'])

describe('which host the record is in', () => {
  it('is the app with ?embed=stash-app and the app’s bridge on the window', () => {
    const { host } = fakeHost()
    const { win } = fakeWindow('?embed=stash-app', { framed: false, extra: { StashHost: host } })
    expect(appHostOf(win)).toBe(host)
    expect(inPlayerFrame(win)).toBe(false)
  })

  it('is not the app when the address says so but there is no bridge (the address opened in a browser)', () => {
    expect(appHostOf(fakeWindow('?embed=stash-app', { framed: false }).win)).toBeNull()
  })

  it('is not the app when there is a bridge but the address is another one', () => {
    const { host } = fakeHost()
    expect(appHostOf(fakeWindow('', { framed: false, extra: { StashHost: host } }).win)).toBeNull()
    expect(appHostOf(fakeWindow('?embed=stash', { extra: { StashHost: host } }).win)).toBeNull()
  })

  it('is not the app when the bridge can’t post', () => {
    for (const StashHost of [null, 1, 'x', {}, { postMessage: 'no' }]) {
      expect(appHostOf(fakeWindow('?embed=stash-app', { framed: false, extra: { StashHost } }).win)).toBeNull()
    }
  })

  it('is the player’s frame only when framed with ?embed=stash, as before', () => {
    expect(inPlayerFrame(fakeWindow('?embed=stash').win)).toBe(true)
    expect(inPlayerFrame(fakeWindow('?embed=stash', { framed: false }).win)).toBe(false)
    expect(inPlayerFrame(fakeWindow('?embed=stash-app').win)).toBe(false)
    expect(inPlayerFrame(fakeWindow('').win)).toBe(false)
  })
})

describe('the player’s frame', () => {
  it('posts objects to the parent, for this origin only', () => {
    const { win, parent } = fakeWindow('?embed=stash')
    frameTransport(win).send({ type: 'stash:close' })
    expect(parent.postMessage).toHaveBeenCalledWith({ type: 'stash:close' }, ORIGIN)
  })

  it('hears stash messages from the parent, from this origin, and nothing else', () => {
    const { win, parent, dispatch } = fakeWindow('?embed=stash')
    const heard: Envelope[] = []
    frameTransport(win).listen((m) => heard.push(m))
    dispatch({ type: 'stash:reload' })
    dispatch({ type: 'stash:reload' }, {}) // another window
    dispatch({ type: 'stash:reload' }, parent, 'https://elsewhere.example') // another origin
    dispatch({ type: 'other' })
    dispatch('{"type":"stash:reload"}') // strings are the app's, not the frame's
    dispatch(null)
    expect(heard).toEqual([{ type: 'stash:reload' }])
  })

  it('stops hearing once unsubscribed', () => {
    const { win, dispatch, listeners } = fakeWindow('?embed=stash')
    const handler = vi.fn()
    const stop = frameTransport(win).listen(handler)
    stop()
    dispatch({ type: 'stash:reload' })
    expect(handler).not.toHaveBeenCalled()
    expect(listeners.size).toBe(0)
  })
})

describe('the app’s bridge', () => {
  it('sends each message as a JSON string', () => {
    const { host, sent } = fakeHost()
    appTransport(host, ACCEPTS).send({ type: 'stash:play', songs: [{ title: 'Ivy', artist: 'Frank Ocean' }], index: 0, from: 'Your record' } as Envelope)
    expect(sent).toHaveLength(1)
    expect(typeof sent[0]).toBe('string')
    expect(JSON.parse(sent[0])).toEqual({ type: 'stash:play', songs: [{ title: 'Ivy', artist: 'Frank Ocean' }], index: 0, from: 'Your record' })
  })

  it('reads the app’s JSON strings into messages for every listener', () => {
    const { host, receive } = fakeHost()
    const t = appTransport(host, ACCEPTS)
    const a: Envelope[] = []
    const b: Envelope[] = []
    t.listen((m) => a.push(m))
    t.listen((m) => b.push(m))
    receive(JSON.stringify({ type: 'stash:archive', rows: [], seq: 0, done: true }))
    expect(a).toEqual([{ type: 'stash:archive', rows: [], seq: 0, done: true }])
    expect(b).toEqual(a)
  })

  it('drops whatever isn’t a message the app may send', () => {
    const { host, receive } = fakeHost()
    const handler = vi.fn()
    appTransport(host, ACCEPTS).listen(handler)
    for (const data of [
      '{not json',
      '',
      'null',
      '42',
      '"stash:back"',
      '[{"type":"stash:back"}]',
      '{}',
      '{"type":7}',
      '{"type":"stash:live","plays":[]}', // a type the app doesn't send
      '{"type":"stash:nope"}',
      { type: 'stash:back' }, // an object, not the bridge's string
      new ArrayBuffer(4),
      undefined,
      null,
    ]) {
      receive(data)
    }
    host.onmessage?.(undefined as unknown as { data: unknown })
    expect(handler).not.toHaveBeenCalled()
    receive('{"type":"stash:back"}')
    expect(handler).toHaveBeenCalledWith({ type: 'stash:back' })
  })

  it('reads a message only from a JSON object with a type it accepts', () => {
    expect(readAppMessage('{"type":"stash:reload"}', ACCEPTS)).toEqual({ type: 'stash:reload' })
    expect(readAppMessage('{"type":"stash:theme","theme":"dark"}', ACCEPTS)).toBeNull()
    expect(readAppMessage('{"type":"stash:theme","theme":"dark"}', new Set(['stash:theme']))).toEqual({ type: 'stash:theme', theme: 'dark' })
  })

  it('stops a listener without stopping the others', () => {
    const { host, receive } = fakeHost()
    const t = appTransport(host, ACCEPTS)
    const a = vi.fn()
    const b = vi.fn()
    const stopA = t.listen(a)
    t.listen(b)
    stopA()
    receive('{"type":"stash:reload"}')
    expect(a).not.toHaveBeenCalled()
    expect(b).toHaveBeenCalledOnce()
  })

  it('keeps telling the others when one listener throws', () => {
    const { host, receive } = fakeHost()
    const t = appTransport(host, ACCEPTS)
    const after = vi.fn()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    t.listen(() => {
      throw new Error('boom')
    })
    t.listen(after)
    receive('{"type":"stash:reload"}')
    expect(after).toHaveBeenCalledOnce()
    error.mockRestore()
  })
})
