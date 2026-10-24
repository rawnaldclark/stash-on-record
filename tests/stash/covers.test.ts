import { describe, expect, it } from 'vitest'
import { askFor, learnPlays } from '../../src/stash/covers'
import { toPlay } from '../../src/stash/embed'

describe('what a cover name stands for', () => {
  learnPlays([
    toPlay({ id: '1', t: 'Ivy', a: 'Frank Ocean', al: 'Blonde', s: 1, ms: 200_000, f: 0 }),
    toPlay({ id: '2', t: 'Ivy', a: 'Frank Ocean', al: 'Blonde', s: 2, ms: 200_000, f: 0 }),
    toPlay({ id: '3', t: 'Ivy', a: 'Frank Ocean', al: 'Ivy (Single)', s: 3, ms: 200_000, f: 0 }),
  ])

  it('tells songs (with their album), albums and artists apart', () => {
    expect(askFor('Ivy|Frank Ocean')).toEqual({ id: 'Ivy|Frank Ocean', artist: 'Frank Ocean', title: 'Ivy', album: 'Blonde' })
    expect(askFor('Blonde|Frank Ocean')).toEqual({ id: 'Blonde|Frank Ocean', artist: 'Frank Ocean', title: 'Blonde', album: 'Blonde' })
    expect(askFor('Frank Ocean')).toEqual({ id: 'Frank Ocean', artist: 'Frank Ocean' })
    expect(askFor('Unknown|Band')).toEqual({ id: 'Unknown|Band', artist: 'Band', title: 'Unknown' })
    expect(askFor('|')).toBeNull()
  })
})
