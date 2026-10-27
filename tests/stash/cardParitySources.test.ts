import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { filterByYear, filterPlays, getYears, summarize, topItems, type Ranked } from '../../src/data/stats'
import { archiveReceiver, archiveRow } from '../../src/stash/app'
import { countSources, fromArchive, sourceOf, stack, type ArchivePlay, type LivePlay, type Source } from '../../src/stash/embed'

/*
 * The Stash app's Home card and its record with every source stacked: the Spotify export, the phone's own plays (Stash) and
 * Last.fm scrobbles, a listen counted once, and the record's switches. The app's Kotlin tests read two files made here:
 *
 *   src/stash/fixtures/card-parity-sources.rows.json    the input: the archive as the app reads it, before anything is left out,
 *                                                        in the order the app sends it (Spotify, then Stash, then Last.fm)
 *   src/stash/fixtures/card-parity-sources.expect.json  the output: what this page's own code makes of them
 *
 * In the app the page stacks nothing itself (no stash:live), so the app leaves out each scrobble one of the phone's own plays
 * covers before it sends the archive. What it must leave out is decided here by the page's own rule: `stack` with the phone's
 * plays (not its skips: a skipped song was never scrobbled) as the live plays, which drops a scrobble whose start falls within
 * 180 s of one of them, titles folded alike. The phone's rows are in the archive as well, so `stack` never adds them twice.
 *
 * `counts` is the page's `stash:counts` (countSources); `coveredRows` the input's indexes of the scrobbles left out;
 * `leftOutRows` the rows the receiver drops (not a play, or an id a row before it has: a scrobble with a phone skip's id);
 * `states` the record for each switch state the page can be told (every subset of the three sources), with the same fields
 * as card-parity.expect.json. Regenerate after a deliberate change: npx vitest run tests/stash/cardParitySources.test.ts -u
 */

const HOUR = 3_600_000
const F = { CHOSEN: 1, DONE: 2, SKIPPED: 4, ACCOUNT: 16, REASONS: 32, LASTFM: 64, ESTIMATED: 128, STASH: 256 }
const SLACK = 180_000

/** The player's identity fold, for ids (identity.ts `fold`, as embed.ts has it). */
const fold = (s: string) =>
  s
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\s*[([]\s*(?:featuring|feat|ft)(?![\p{L}\p{N}])\.?[^)\]]*[)\]]/giu, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
const row = (t: string, a: string, s: number, ms: number, f: number, al?: string): ArchivePlay => ({
  id: `${fold(t)}|${fold(a)}|${s}`,
  t,
  a,
  ...(al ? { al } : {}),
  s,
  ms,
  f,
})

const D = Date.UTC(2025, 0, 10, 12)
const M = 60_000
// The Spotify export: Extended (done, skipped), Account, and one from 2019 (the record's "since", the same in every zone)
const spotify: ArchivePlay[] = [
  row('Song A', 'Artist One', D, 200_000, F.REASONS | F.DONE | F.CHOSEN, 'First Album'),
  row('Song B', 'Artist Two', D + 10 * M, 30_000, 0),
  row('Song C', 'Artist Two', D + 20 * M, 29_999, F.ACCOUNT),
  row('Song D', 'Artist One', D + 30 * M, 15_000, F.REASONS | F.SKIPPED),
  row('Old Song', 'Artist Three', Date.UTC(2019, 5, 15, 12), 241_000, F.REASONS | F.DONE, 'Old Album'),
  row('Long Mix', 'DJ', D + 2 * HOUR, 6 * HOUR, F.REASONS | F.DONE),
]
// The phone's own plays and skips (Stash): each a rule of what covers a scrobble
const H1 = D + 10 * HOUR // Here Song, 3 minutes
const H2 = D + 11 * HOUR // a skip
const H3 = D + 12 * HOUR // an estimated play
const H4 = D + 13 * HOUR // a skip whose id a scrobble shares
const H5 = D + 14 * HOUR // a 7-hour play
const H6 = D + 22 * HOUR // a title with a featuring credit
const own: ArchivePlay[] = [
  row('Here Song', 'Stash Artist', H1, 180_000, F.STASH, 'Here Album'),
  row('Skipped Song', 'Stash Artist', H2, 20_000, F.STASH | F.SKIPPED),
  row('Guess Song', 'Stash Artist', H3, 210_000, F.STASH | F.ESTIMATED),
  row('Same Id', 'Band', H4, 12_000, F.STASH | F.SKIPPED),
  row('Marathon', 'Endurance', H5, 7 * HOUR, F.STASH),
  row('Feat Song (feat. Guest)', 'Stash Artist', H6, 200_000, F.STASH),
  row('Artist One Here', 'Artist One', D + 30 * HOUR, 222_000, F.STASH, 'First Album'),
]
// Last.fm: covered at the edges and not past them, by folded titles and another artist; never by a skip; one claimed by a
// skip's id; and scrobbles nothing here played
const lastfm: ArchivePlay[] = [
  row('Here Song', 'Stash Artist', H1 - SLACK, 180_000, F.LASTFM), // exactly 180 s before the start: covered
  row('Here Song', 'Stash Artist', H1 - SLACK - 1000, 180_000, F.LASTFM), // a second more: kept
  row('Here Song', 'Stash Artist', H1 + 180_000 + SLACK, 210_000, F.LASTFM | F.ESTIMATED), // exactly 180 s after the end: covered
  row('Here Song', 'Stash Artist', H1 + 180_000 + SLACK + 1000, 210_000, F.LASTFM | F.ESTIMATED), // a second more: kept
  row('Skipped Song', 'Stash Artist', H2 + 5000, 210_000, F.LASTFM | F.ESTIMATED), // a skip covers nothing: kept
  row('GUESS song!', 'Someone Else', H3 + 30_000, 210_000, F.LASTFM | F.ESTIMATED), // folded alike, another artist: covered
  row('Same Id', 'Band', H4, 210_000, F.LASTFM | F.ESTIMATED), // the skip's id: left out by the receiver
  row('Marathon', 'Endurance', H5 + 4 * HOUR, 210_000, F.LASTFM | F.ESTIMATED), // inside a 7-hour play: covered
  row('Feat Song', 'Stash Artist', H6 + 60_000, 200_000, F.LASTFM), // the credit folded away: covered
  row('Song A', 'Artist One', D + 3 * HOUR, 200_000, F.LASTFM, 'First Album'), // a known length, from Spotify's done play
  row('Elsewhere', 'Artist Four', D + 40 * HOUR, 210_000, F.LASTFM | F.ESTIMATED, 'Away'),
  row('Elsewhere', 'Artist Four', D + 41 * HOUR, 210_000, F.LASTFM | F.ESTIMATED, 'Away'),
  row('Björk Song', 'Björk', D + 42 * HOUR, 210_000, F.LASTFM | F.ESTIMATED),
  row('Scrobbled Old', 'Artist Three', Date.UTC(2020, 2, 3, 9), 241_000, F.LASTFM),
]
const rows: ArchivePlay[] = [...spotify, ...own, ...lastfm]

/** The phone's plays as the live plays `stack` takes (its skips aren't: a skipped song was never scrobbled). */
const live: LivePlay[] = own.filter((r) => !(r.f & F.SKIPPED)).map((r) => ({ t: r.t, a: r.a, s: r.s, ms: r.ms }))

const SOURCES: Source[] = ['spotify', 'stash', 'lastfm']
const STATES = Array.from({ length: 8 }, (_, m) => ({ spotify: !!(m & 1), stash: !!(m & 2), lastfm: !!(m & 4) }))

/** JSON with every character past ASCII escaped, as card-parity's files are written. */
const asciiJson = (v: unknown) => JSON.stringify(v, null, 2).replace(/[\u0080-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)

/** The archive as the app host gathers it: one chunk per row (the result is the same however it's chunked). */
function received(input: readonly unknown[]): ArchivePlay[] {
  const receiver = archiveReceiver()
  receiver.hello()
  let archive: ArchivePlay[] | null = null
  for (let seq = 0; archive === null; seq++) archive = receiver.take({ rows: input.slice(seq, seq + 1), seq, done: seq + 1 >= input.length })
  return archive
}

/** The record for one switch state, as card-parity.test.ts works it out, with the phone's plays covering scrobbles. */
function card(on: Record<Source, boolean>) {
  const plays = stack(fromArchive(received(rows)).plays, live, on)
  const hasAnyMusic = plays.some((p) => p.kind === 'track')
  const all = filterPlays(plays, { musicOnly: hasAnyMusic, hidden: new Set() })
  const shown = filterByYear(all, null)
  const summary = summarize(shown)
  let first = Infinity
  for (const p of all) first = Math.min(first, p.endTime - p.msPlayed)
  const label = (r: Ranked) => ({ label: r.label, ms: r.ms })
  return {
    on,
    plays: plays.length,
    totalMs: summary.totalMs,
    hours: Math.round(summary.totalMs / HOUR),
    streams: summary.streams,
    first: Number.isFinite(first) ? first : null,
    sinceYear: getYears(all)[0] ?? null,
    topArtists: topItems(shown, 'artist', 'time', 5).map(label),
    artists: topItems(shown, 'artist', 'time', Infinity).map((r) => ({ label: r.label, ms: r.ms, plays: r.plays })),
  }
}

function leftOut(input: readonly unknown[]): number[] {
  const ids = new Set<string>()
  const out: number[] = []
  input.forEach((r, i) => {
    const kept = archiveRow(r)
    if (!kept || ids.has(kept.id)) out.push(i)
    else ids.add(kept.id)
  })
  return out
}

/** The scrobbles the phone's plays cover: those `stack` (every source on) leaves out of the record, by input index. */
function covered(): number[] {
  const kept = received(rows)
  const plays = stack(fromArchive(kept).plays, live, { spotify: true, stash: true, lastfm: true })
  const left = new Set(plays.filter((p) => p.platform === 'Last.fm').map((p) => `${fold(p.title)}|${fold(p.artist)}|${p.endTime - p.msPlayed}`))
  const dropped = new Set(leftOut(rows))
  return rows.flatMap((r, i) => (r.f & F.LASTFM && !dropped.has(i) && !left.has(`${fold(r.t)}|${fold(r.a)}|${r.s}`) ? [i] : []))
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('the Home card parity fixture with every source', () => {
  it('is what the page makes of the rows, for every switch state (regenerate with -u after a deliberate change)', async () => {
    const expected = {
      counts: countSources(fromArchive(received(rows)).plays, live),
      coveredRows: covered(),
      leftOutRows: leftOut(rows),
      states: STATES.map(card),
    }
    await expect(`${asciiJson(rows)}\n`).toMatchFileSnapshot('../../src/stash/fixtures/card-parity-sources.rows.json')
    await expect(`${asciiJson(expected)}\n`).toMatchFileSnapshot('../../src/stash/fixtures/card-parity-sources.expect.json')
  })

  it('leaves out exactly the scrobbles the rules say', () => {
    const at = (r: ArchivePlay) => rows.indexOf(r)
    expect(covered()).toEqual([lastfm[0]!, lastfm[2]!, lastfm[5]!, lastfm[7]!, lastfm[8]!].map(at))
    expect(leftOut(rows)).toEqual([at(lastfm[6]!)])
  })

  it('counts a scrobble a phone play covers as the phone’s, never twice, whatever the switches', () => {
    const c = countSources(fromArchive(received(rows)).plays, live)
    const listens = (rs: ArchivePlay[]) => rs.filter((r) => r.ms >= 30_000).length
    expect(c.spotify).toBe(listens(spotify))
    expect(c.stash).toBe(listens(own))
    // the kept scrobbles: neither covered nor sharing a skip's id
    expect(c.lastfm).toBe(listens(lastfm) - 5 - 1)
    const all = card({ spotify: true, stash: true, lastfm: true })
    const parts = SOURCES.map((s) => card({ spotify: s === 'spotify', stash: s === 'stash', lastfm: s === 'lastfm' }))
    expect(parts.reduce((n, p) => n + p.plays, 0)).toBe(all.plays)
    expect(parts.reduce((n, p) => n + p.totalMs, 0)).toBe(all.totalMs)
    expect(sourceOf({ f: F.LASTFM | F.STASH })).toBe('lastfm')
  })
})
