import { describe, expect, it } from 'vitest'
import { isSkip } from '../../src/data/stats'
import { toPlay, type ArchivePlay } from '../../src/stash/embed'
import { at } from '../helpers'

/** Stash's flags (stash-player src/lib/spotify/plays.ts) */
const CHOSEN = 1
const DONE = 2
const SKIPPED = 4
const SHUFFLE = 8
const REASONS = 32

function row(f: number, overrides: Partial<ArchivePlay> = {}): ArchivePlay {
  return { id: 'r1', t: 'Song', a: 'Artist', s: at(2024, 3, 3, 21).getTime(), ms: 200_000, f, ...overrides }
}

describe('toPlay', () => {
  it('ends a play when it stopped: the start plus the time played', () => {
    const p = toPlay(row(REASONS))
    expect(p.endTime).toBe(at(2024, 3, 3, 21).getTime() + 200_000)
    expect(p.msPlayed).toBe(200_000)
    expect(p.kind).toBe('track')
  })

  it('reads CHOSEN as a play the listener started', () => {
    expect(toPlay(row(CHOSEN | REASONS)).reasonStart).toBe('clickrow')
  })

  it('reads a play with reasons but not CHOSEN as one that came on by itself', () => {
    expect(toPlay(row(REASONS)).reasonStart).toBe('trackdone')
  })

  it('leaves the reasons empty when Stash never had them', () => {
    const p = toPlay(row(0))
    expect(p.reasonStart).toBe('')
    expect(p.reasonEnd).toBe('')
    expect(isSkip(p)).toBe(false)
  })

  it('reads DONE as played to the end', () => {
    const p = toPlay(row(DONE | REASONS))
    expect(p.reasonEnd).toBe('trackdone')
    expect(p.skipped).toBe(false)
    expect(isSkip(p)).toBe(false)
  })

  it('reads SKIPPED as left with Next, which On Record counts as a skip', () => {
    const p = toPlay(row(SKIPPED | REASONS))
    expect(p.reasonEnd).toBe('fwdbtn')
    expect(p.skipped).toBe(true)
    expect(isSkip(p)).toBe(true)
  })

  it('reads SHUFFLE', () => {
    expect(toPlay(row(SHUFFLE)).shuffle).toBe(true)
    expect(toPlay(row(CHOSEN)).shuffle).toBe(false)
  })

  it('turns a Spotify id into its track URI, and leaves it empty without one', () => {
    expect(toPlay(row(0, { sid: '4uLU6hMCjMI75M1A2tKUQC' })).uri).toBe('spotify:track:4uLU6hMCjMI75M1A2tKUQC')
    expect(toPlay(row(0)).uri).toBe('')
  })

  it('keeps the album when there is one', () => {
    expect(toPlay(row(0, { al: 'Album' })).album).toBe('Album')
    expect(toPlay(row(0)).album).toBe('')
  })

  it('makes exactly a Play: nothing Stash keeps beyond it comes along', () => {
    const p = toPlay(row(CHOSEN | DONE | SHUFFLE | REASONS, { al: 'Album', sid: 'x' }))
    expect(Object.keys(p).sort()).toEqual(
      ['album', 'artist', 'country', 'endTime', 'incognito', 'kind', 'msPlayed', 'offline', 'platform', 'reasonEnd', 'reasonStart', 'shuffle', 'skipped', 'title', 'uri'].sort(),
    )
    expect(p.platform).toBe('')
    expect(p.country).toBe('')
    expect(p.offline).toBe(false)
    expect(p.incognito).toBe(false)
  })
})
