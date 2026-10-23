import { describe, expect, it } from 'vitest'
import { topItems } from '../../src/data/stats'
import { albumQueue, artistQueue, chartQueue, dayQueue, MAX_QUEUE, songOf, songsOf } from '../../src/stash/queue'
import { at, play } from '../helpers'

describe('songOf', () => {
  it('names the album only when there is one', () => {
    expect(songOf({ title: 'T', artist: 'A', album: 'L' })).toEqual({ title: 'T', artist: 'A', album: 'L' })
    expect(songOf({ title: 'T', artist: 'A', album: '' })).toEqual({ title: 'T', artist: 'A' })
  })
})

describe('dayQueue', () => {
  const morning = play(at(2024, 3, 3, 8), { title: 'Morning', artist: 'A', album: 'Wake' })
  const skipped = play(at(2024, 3, 3, 9), { title: 'Skipped', artist: 'B', msPlayed: 4_000, skipped: true })
  const noon = play(at(2024, 3, 3, 12), { title: 'Noon', artist: 'C' })
  const again = play(at(2024, 3, 3, 15), { title: 'Morning', artist: 'A', album: 'Wake' })
  const night = play(at(2024, 3, 3, 22), { title: 'Night', artist: 'D' })
  const day = [morning, skipped, noon, again, night]

  it('plays the day in order, each song once, without the skips', () => {
    expect(dayQueue(day)).toEqual({
      songs: [
        { title: 'Morning', artist: 'A', album: 'Wake' },
        { title: 'Noon', artist: 'C', album: 'Album' },
        { title: 'Night', artist: 'D', album: 'Album' },
      ],
      index: 0,
    })
  })

  it('keeps the skips when the day was nothing else', () => {
    expect(dayQueue([skipped]).songs.map((s) => s.title)).toEqual(['Skipped'])
  })

  it('leaves out podcasts', () => {
    const episode = play(at(2024, 3, 3, 7), { kind: 'episode', title: 'Ep', artist: 'Show' })
    expect(dayQueue([episode, noon]).songs.map((s) => s.title)).toEqual(['Noon'])
  })

  it('starts at the song a play belongs to', () => {
    expect(dayQueue(day, noon).index).toBe(1)
    // The second play of a song starts where the song first came on
    expect(dayQueue(day, again).index).toBe(0)
  })

  it('starts a skip that was left out at the next song that played', () => {
    expect(dayQueue(day, skipped).index).toBe(1)
  })

  it('starts at the top when nothing played after the skip', () => {
    const late = play(at(2024, 3, 3, 23), { title: 'Late', artist: 'E', msPlayed: 3_000, skipped: true })
    expect(dayQueue([morning, late], late).index).toBe(0)
  })

  it('is empty for a quiet day', () => {
    expect(dayQueue([])).toEqual({ songs: [], index: 0 })
  })
})

describe('songsOf', () => {
  const plays = [
    play(at(2024, 1, 1), { title: 'Once', artist: 'A' }),
    play(at(2024, 1, 2), { title: 'Twice', artist: 'A' }),
    play(at(2024, 1, 3), { title: 'Twice', artist: 'A' }),
    // A long play, but only one: plays come first, time breaks a tie
    play(at(2024, 1, 4), { title: 'Long', artist: 'A', msPlayed: 600_000 }),
    play(at(2024, 1, 5), { title: 'Other', artist: 'B' }),
    // Short starts don't count as plays, as on The Charts
    play(at(2024, 1, 6), { title: 'Skips', artist: 'A', msPlayed: 5_000 }),
    play(at(2024, 1, 7), { title: 'Skips', artist: 'A', msPlayed: 5_000 }),
    play(at(2024, 1, 8), { title: 'Skips', artist: 'A', msPlayed: 5_000 }),
  ]

  it("lists an artist's songs, most played first", () => {
    expect(artistQueue(plays, 'A')).toEqual({
      songs: ['Twice', 'Long', 'Once', 'Skips'].map((title) => ({ title, artist: 'A', album: 'Album' })),
      index: 0,
    })
  })

  it('breaks a full tie by title, so the order never wobbles', () => {
    const tied = [play(at(2024, 1, 1), { title: 'B', artist: 'X' }), play(at(2024, 1, 2), { title: 'A', artist: 'X' })]
    expect(songsOf(tied, () => true).map((s) => s.title)).toEqual(['A', 'B'])
  })

  it('names each song by the album it was played from most', () => {
    const mixed = [
      play(at(2024, 1, 1), { title: 'Hit', artist: 'A', album: 'Best of' }),
      play(at(2024, 1, 2), { title: 'Hit', artist: 'A', album: 'Debut' }),
      play(at(2024, 1, 3), { title: 'Hit', artist: 'A', album: 'Debut' }),
    ]
    expect(songsOf(mixed, () => true)).toEqual([{ title: 'Hit', artist: 'A', album: 'Debut' }])
  })

  it("plays an album's songs and nobody else's", () => {
    const albums = [
      play(at(2024, 1, 1), { title: 'One', artist: 'A', album: 'First' }),
      play(at(2024, 1, 2), { title: 'Two', artist: 'A', album: 'Second' }),
      play(at(2024, 1, 3), { title: 'Cover', artist: 'B', album: 'First' }),
    ]
    expect(albumQueue(albums, 'A', 'First').songs).toEqual([{ title: 'One', artist: 'A', album: 'First' }])
  })

  it('stops at MAX_QUEUE songs', () => {
    const many = Array.from({ length: MAX_QUEUE + 20 }, (_, i) => play(at(2024, 1, 1, 0, i), { title: `S${i}`, artist: 'A' }))
    expect(artistQueue(many, 'A').songs).toHaveLength(MAX_QUEUE)
  })
})

describe('chartQueue', () => {
  const plays = [
    play(at(2024, 1, 1), { title: 'Big', artist: 'A', album: 'L' }),
    play(at(2024, 1, 2), { title: 'Big', artist: 'A', album: 'L' }),
    play(at(2024, 1, 3), { title: 'Small', artist: 'B', album: 'M' }),
  ]

  it('plays the top songs from the one tapped', () => {
    const items = topItems(plays, 'track', 'plays', 20)
    expect(chartQueue(plays, 'track', items, 1)).toEqual({
      songs: [
        { title: 'Big', artist: 'A' },
        { title: 'Small', artist: 'B' },
      ],
      index: 1,
    })
  })

  it("plays an artist's or an album's songs", () => {
    expect(chartQueue(plays, 'artist', topItems(plays, 'artist', 'time', 20), 1).songs).toEqual([{ title: 'Small', artist: 'B', album: 'M' }])
    expect(chartQueue(plays, 'album', topItems(plays, 'album', 'time', 20), 0).songs).toEqual([{ title: 'Big', artist: 'A', album: 'L' }])
  })

  it('has nothing to play for podcasts or a missing row', () => {
    expect(chartQueue(plays, 'show', [], 0)).toEqual({ songs: [], index: 0 })
    expect(chartQueue(plays, 'artist', [], 3)).toEqual({ songs: [], index: 0 })
  })
})
