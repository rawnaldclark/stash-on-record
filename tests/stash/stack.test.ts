import { describe, expect, it } from 'vitest'
import { countSources, livePlay, stack, toPlay } from '../../src/stash/embed'

const T = Date.UTC(2024, 4, 1, 12)
const row = (t: string, s: number, f: number, ms = 200_000) => toPlay({ id: `${t}|${s}`, t, a: 'Band', s, ms, f })
const F_DONE = 2
const F_LASTFM = 64

describe('stacking the sources', () => {
  const archive = [row('Spot', T, F_DONE), row('Scrob', T + 3_600_000, F_LASTFM), row('Here', T + 7_200_000 + 30_000, F_LASTFM)]
  const live = [{ t: 'Here', a: 'Band', s: T + 7_200_000, ms: 180_000 }]

  it('labels each play with its source, and counts a scrobble of a play made in Stash once', () => {
    const all = stack(archive, live, { spotify: true, stash: true, lastfm: true })
    expect(all.map((p) => [p.title, p.platform])).toEqual([
      ['Spot', 'Spotify'],
      ['Scrob', 'Last.fm'],
      ['Here', 'Stash'],
    ])
    expect(countSources(archive, live)).toEqual({ spotify: 1, stash: 1, lastfm: 1 })
  })

  it('shows only the sources switched on', () => {
    expect(stack(archive, live, { spotify: false, stash: true, lastfm: false }).map((p) => p.title)).toEqual(['Here'])
    // with Stash off, the scrobble of its play still isn't shown: it is that play
    expect(stack(archive, live, { spotify: true, stash: false, lastfm: true }).map((p) => p.title)).toEqual(['Spot', 'Scrob'])
  })

  it('shows the phone’s exported plays as Stash', () => {
    const phone = row('Phone', T - 3_600_000, 256)
    expect(stack([phone, ...archive], live, { spotify: false, stash: true, lastfm: false }).map((p) => [p.title, p.platform])).toEqual([
      ['Phone', 'Stash'],
      ['Here', 'Stash'],
    ])
    expect(countSources([phone, ...archive], live)).toEqual({ spotify: 1, stash: 2, lastfm: 1 })
  })

  it('makes a play of Stash its own a full listen', () => {
    expect(livePlay({ t: 'X', a: 'Y', s: T, ms: 1000 })).toMatchObject({ endTime: T + 1000, msPlayed: 1000, kind: 'track', platform: 'Stash', reasonEnd: 'trackdone', skipped: false })
  })
})

describe('one play, two ways in', () => {
  it('keeps the archive’s copy of a phone play the player also sends as its own', () => {
    const phone = toPlay({ id: 'x', t: 'Song', a: 'Band', s: T, ms: 150_000, f: 256 })
    const all = stack([phone], [{ t: 'Song', a: 'Band', s: T, ms: 180_000 }, { t: 'New', a: 'Band', s: T + 1, ms: 180_000 }], { spotify: true, stash: true, lastfm: true })
    expect(all.map((p) => [p.title, p.msPlayed])).toEqual([
      ['Song', 150_000],
      ['New', 180_000],
    ])
  })
})
