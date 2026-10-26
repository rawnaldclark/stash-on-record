import { afterEach, describe, expect, it, vi } from 'vitest'

/*
 * The app's back gesture (stash:back). What's open over the record registers itself with lib/back.ts through a hook, which needs
 * React to run; here `closeTopmost` stands in for it, saying whether something was open (and closing it).
 */
const back = vi.hoisted(() => ({ closeTopmost: vi.fn(() => false) }))
vi.mock('../../src/lib/back', () => ({ closeTopmost: back.closeTopmost, useCloseOnBack: () => {} }))

/** The record in the app, listening for back: what it sent the app, and a way to be the app. */
async function inApp() {
  const sent: { type: string }[] = []
  const host = { postMessage: (s: string) => void sent.push(JSON.parse(s)), onmessage: null as ((e: { data: unknown }) => void) | null }
  const self: Record<string, unknown> = {
    location: { search: '?embed=stash-app', origin: 'https://appassets.androidplatform.net' },
    addEventListener: () => {},
    removeEventListener: () => {},
    StashHost: host,
  }
  self.parent = self
  vi.stubGlobal('window', self)
  vi.resetModules()
  const app = await import('../../src/stash/app')
  const stop = app.listenForBack()
  return { sent, stop, fromApp: (msg: unknown) => host.onmessage?.({ data: JSON.stringify(msg) }) }
}

afterEach(() => {
  vi.unstubAllGlobals()
  back.closeTopmost.mockReset().mockReturnValue(false)
})

describe('back in the app', () => {
  it('closes what was opened over the record last, the record stays, and the app hears stash:backed', async () => {
    const { sent, fromApp } = await inApp()
    back.closeTopmost.mockReturnValueOnce(true)
    fromApp({ type: 'stash:back' })
    expect(back.closeTopmost).toHaveBeenCalledOnce()
    expect(sent).toEqual([{ type: 'stash:backed' }])
  })

  it('answers every back once: two quick presses over two sheets are two stash:backed, never a close', async () => {
    const { sent, fromApp } = await inApp()
    back.closeTopmost.mockReturnValueOnce(true).mockReturnValueOnce(true)
    fromApp({ type: 'stash:back' })
    fromApp({ type: 'stash:back' })
    expect(sent).toEqual([{ type: 'stash:backed' }, { type: 'stash:backed' }])
  })

  it('closes the record when nothing is open over it', async () => {
    const { sent, fromApp } = await inApp()
    fromApp({ type: 'stash:back' })
    expect(back.closeTopmost).toHaveBeenCalledOnce()
    expect(sent).toEqual([{ type: 'stash:close' }])
  })

  it('takes one thing per press: a sheet, then the record', async () => {
    const { sent, fromApp } = await inApp()
    back.closeTopmost.mockReturnValueOnce(true)
    fromApp({ type: 'stash:back' })
    fromApp({ type: 'stash:back' })
    expect(back.closeTopmost).toHaveBeenCalledTimes(2)
    expect(sent).toEqual([{ type: 'stash:backed' }, { type: 'stash:close' }])
  })

  it('hears only stash:back, and nothing once stopped', async () => {
    const { sent, stop, fromApp } = await inApp()
    fromApp({ type: 'stash:reload' })
    fromApp('stash:back')
    expect(back.closeTopmost).not.toHaveBeenCalled()
    stop()
    fromApp({ type: 'stash:back' })
    expect(back.closeTopmost).not.toHaveBeenCalled()
    expect(sent).toEqual([])
  })
})
