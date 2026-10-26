import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import rowsJson from '../../src/stash/fixtures/card-parity.rows.json?raw'
import { filterByYear, filterPlays, getYears, summarize, topItems, type Ranked } from '../../src/data/stats'
import { archiveReceiver, archiveRow } from '../../src/stash/app'
import { fromArchive, stack, type ArchivePlay } from '../../src/stash/embed'

/*
 * The Stash app's Home card for Your record ("37 hours · since 2005 · 77 plays · Most played: Leif Inge", and the top five
 * artists' pictures) must show what the record shows for the same rows. The app's Kotlin tests prove it with two files made here:
 *
 *   src/stash/fixtures/card-parity.rows.json    the input: messy ArchivePlay rows {id,t,a,al?,sid?,s,ms,f}, in the order the
 *                                               app would send them, one rule each (see the list in the last test)
 *   src/stash/fixtures/card-parity.expect.json  the output: what this page's own code makes of those rows in the app
 *
 * The app copies both into its test resources, reads the rows as if they were its own archive, works out the card with its own
 * code and must match every field of the expectation: `plays` (the count the record reports in stash:ready), `totalMs` and
 * `hours` (the hero's number: Math.round, half up), `streams` (plays of 30 s or more), `first` and `sinceYear` (the earliest
 * kept start; the page takes its year in the device's time zone, and this fixture's is 2005 in every zone), `topArtists` (the
 * card's five, with their time), `artists` (the whole ranking, to pin the ties) and `leftOutRows` (0-based indexes of the rows
 * the page doesn't keep: not plays, or an id already kept). Both files are ASCII, every other character written \uXXXX, so no
 * tool that normalizes Unicode can merge the decomposed "Björk" with the precomposed "Björk" (two artists here).
 *
 * The pipeline below is the app host's, step for step, from the page's real functions: the archive's chunks through
 * archiveReceiver (archiveRow on each row), fromArchive, EmbedApp's stack (no stash:live in the app, every source on), then
 * Dashboard's filters (Music only, nothing hidden, all time), summarize and topItems(plays, 'artist', 'time', 16). Nothing in
 * it reads the clock: the rows' times are fixed (made 2026-10-26 12:00 UTC; the "future" row starts 2026-10-29 12:00 UTC).
 *
 * When the page's logic changes on purpose, this test fails until the expectation is made again:
 *
 *   npx vitest run tests/stash/cardParity.test.ts -u
 *
 * then copy both files into the app, whose test then shows what the Kotlin side must change to match.
 */

const ALL = { spotify: true, stash: true, lastfm: true }
const HOUR = 3_600_000

const rows: unknown[] = JSON.parse(rowsJson)

/** JSON with every character past ASCII escaped, as the rows file is written */
const asciiJson = (v: unknown) => JSON.stringify(v, null, 2).replace(/[\u0080-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)

/** The record's card from the app's rows, sent in chunks of `chunkRows`, exactly as the app host presses them. */
function card(input: readonly unknown[], chunkRows = 20_000) {
  // archiveFromApp: a hello, then the app's answer, chunk by chunk, until the one marked done
  const receiver = archiveReceiver()
  receiver.hello()
  let archive: ArchivePlay[] | null = null
  for (let seq = 0; archive === null; seq++) {
    const at = seq * chunkRows
    archive = receiver.take({ rows: input.slice(at, at + chunkRows), seq, done: at + chunkRows >= input.length })
  }
  // archiveFromApp hands fromArchive's result to EmbedApp, which stacks it with no live plays and every source on
  const plays = stack(fromArchive(archive).plays, [], ALL)
  // Dashboard: Music only (on when there's music at all), nothing hidden, then the year picker on all time
  const hasAnyMusic = plays.some((p) => p.kind === 'track')
  const all = filterPlays(plays, { musicOnly: hasAnyMusic, hidden: new Set() })
  const shown = filterByYear(all, null)
  const summary = summarize(shown)
  const ranked = topItems(shown, 'artist', 'time', 16)
  // The hero's "since": the first of getYears(all), the year of the earliest start
  let first = Infinity
  for (const p of all) first = Math.min(first, p.endTime - p.msPlayed)
  const label = (r: Ranked) => ({ label: r.label, ms: r.ms })
  return {
    plays: plays.length,
    totalMs: summary.totalMs,
    hours: Math.round(summary.totalMs / HOUR),
    streams: summary.streams,
    first,
    sinceYear: getYears(all)[0],
    topArtists: ranked.slice(0, 5).map(label),
    artists: topItems(shown, 'artist', 'time', Infinity).map((r) => ({ label: r.label, ms: r.ms, plays: r.plays })),
  }
}

/** The rows the page leaves out, by index: not a play (archiveRow), or an id a row before it already has. */
function leftOut(input: readonly unknown[]): number[] {
  const ids = new Set<string>()
  const out: number[] = []
  input.forEach((r, i) => {
    const row = archiveRow(r)
    if (!row || ids.has(row.id)) out.push(i)
    else ids.add(row.id)
  })
  return out
}

beforeEach(() => {
  // The receiver counts the rows it leaves out in the console
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('the Home card parity fixture', () => {
  it('is what the page makes of the rows (regenerate with -u after a deliberate change)', async () => {
    const expected = { ...card(rows), leftOutRows: leftOut(rows) }
    await expect(`${asciiJson(expected)}\n`).toMatchFileSnapshot('../../src/stash/fixtures/card-parity.expect.json')
  })

  it('is plain ASCII on disk, both files, and reads back as the same strings', () => {
    expect([...rowsJson].every((c) => c.charCodeAt(0) < 0x80)).toBe(true)
    const names = (rows as { a?: string }[]).map((r) => r.a)
    expect(names).toContain('Björk')
    expect(names).toContain('Björk')
  })

  it('comes out the same however the rows are chunked', () => {
    const whole = card(rows)
    for (const size of [1, 7, 30]) expect(card(rows, size)).toEqual(whole)
  })

  it('says the same "since" in every time zone, and its numbers agree with each other', () => {
    const c = card(rows)
    expect(new Date(c.first).getFullYear()).toBe(c.sinceYear)
    expect(new Date(c.first).getUTCFullYear()).toBe(c.sinceYear)
    expect(c.plays).toBe(rows.length - leftOut(rows).length)
    expect(c.artists.reduce((n, a) => n + a.ms, 0)).toBe(c.totalMs)
    expect(c.topArtists).toEqual(c.artists.slice(0, 5).map(({ label, ms }) => ({ label, ms })))
  })

  it('still has a row for every rule the card must copy', () => {
    const list = rows as Partial<ArchivePlay>[]
    const kept = new Set(Array.from({ length: list.length }, (_, i) => i).filter((i) => !leftOut(rows).includes(i)))
    const has = (what: string, test: (r: Partial<ArchivePlay>, i: number) => boolean) => expect(list.some(test), what).toBe(true)
    const F = { ACCOUNT: 16, LASTFM: 64, ESTIMATED: 128, STASH: 256, SKIPPED: 4, REASONS: 32 }
    const flags = (r: Partial<ArchivePlay>) => r.f ?? 0
    has('a Stash play', (r) => flags(r) === F.STASH)
    has('a Stash skip', (r) => flags(r) === (F.STASH | F.SKIPPED))
    has('an estimated row', (r) => (flags(r) & F.ESTIMATED) !== 0)
    has('a Spotify Account row', (r) => flags(r) === F.ACCOUNT)
    has('a Spotify row with no flags', (r) => flags(r) === 0)
    has('a Spotify Extended row', (r) => (flags(r) & F.REASONS) !== 0)
    has('a Last.fm scrobble', (r) => (flags(r) & F.LASTFM) !== 0)
    has('a stream of exactly 30 s', (r, i) => r.ms === 30_000 && kept.has(i))
    has('a play of 29,999 ms', (r, i) => r.ms === 29_999 && kept.has(i))
    has('a 7-hour play, kept', (r, i) => r.ms === 7 * HOUR && kept.has(i))
    has('a play of exactly a day, kept', (r, i) => r.ms === 24 * HOUR && kept.has(i))
    has('a play a millisecond past a day, left out', (r, i) => r.ms === 24 * HOUR + 1 && !kept.has(i))
    has('a 25-hour row, left out', (r, i) => r.ms === 25 * HOUR && !kept.has(i))
    has('a row from 2005, kept', (r, i) => new Date(r.s ?? 0).getUTCFullYear() === 2005 && kept.has(i))
    has('a row three days after the fixture was made, kept', (r, i) => r.s === Date.UTC(2026, 9, 29, 12) && kept.has(i))
    has('an empty album', (r) => r.al === '')
    has('an album written as null', (r) => r.al === null)
    has('a "feat." credit', (r) => /feat\./.test(r.a ?? ''))
    has('an "A, B" credit', (r) => /, /.test(r.a ?? ''))
    has('an "A & B" credit', (r) => / & /.test(r.a ?? ''))
    for (const a of ['Björk', 'bjork', 'Björk', 'BJÖRK']) has(`the artist "${a}"`, (r) => r.a === a)
    // An id sent twice, with different words, and a row sent twice exactly
    const ids = list.map((r) => r.id)
    const twice = ids.filter((id, i) => ids.indexOf(id) !== i)
    expect(twice.length).toBe(2)
    expect(twice.some((id) => JSON.stringify(list[ids.indexOf(id)]) === JSON.stringify(list[ids.lastIndexOf(id)]))).toBe(true)
    expect(twice.some((id) => JSON.stringify(list[ids.indexOf(id)]) !== JSON.stringify(list[ids.lastIndexOf(id)]))).toBe(true)
    // Two ties on time in the ranking: one broken by the earliest end, one by the smaller id (the first plays end together)
    const c = card(rows)
    const ties = c.artists.filter((a, i) => c.artists.some((b, j) => i !== j && a.ms === b.ms))
    expect(ties.length).toBeGreaterThanOrEqual(4)
    // The hero's hours sit on a half, so rounding half up and half to even disagree
    expect((c.totalMs / HOUR) % 1).toBe(0.5)
    expect(Math.floor(c.totalMs / HOUR) % 2).toBe(0)
  })
})
