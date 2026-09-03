import { describe, it, expect } from 'vitest'
import parseSnippet, { SNIPPET_MARK_OPEN, SNIPPET_MARK_CLOSE } from '../src/electron/lib/search/parse-snippet.mjs'

const O = SNIPPET_MARK_OPEN
const C = SNIPPET_MARK_CLOSE

describe('parseSnippet', () => {
    it('splits marked runs into mark segments in order', () => {
        expect(parseSnippet(`before ${O}matched${C} after`)).toEqual([
            { text: 'before ', mark: false },
            { text: 'matched', mark: true },
            { text: ' after', mark: false },
        ])
    })

    it('returns a single unmarked segment for plain text', () => {
        expect(parseSnippet('plain text')).toEqual([{ text: 'plain text', mark: false }])
    })

    it('returns empty for blank input', () => {
        expect(parseSnippet('')).toEqual([])
        expect(parseSnippet(null)).toEqual([])
        expect(parseSnippet(undefined)).toEqual([])
    })

    it('tolerates unbalanced markers', () => {
        expect(parseSnippet(`open ${O}never closed`)).toEqual([
            { text: 'open ', mark: false },
            { text: 'never closed', mark: true },
        ])
        expect(parseSnippet(`closed ${C}never opened`)).toEqual([
            { text: 'closed ', mark: false },
            { text: 'never opened', mark: false },
        ])
    })

    it('drops empty segments between adjacent markers', () => {
        expect(parseSnippet(`a${O}${C}b`)).toEqual([
            { text: 'a', mark: false },
            { text: 'b', mark: false },
        ])
    })
})
