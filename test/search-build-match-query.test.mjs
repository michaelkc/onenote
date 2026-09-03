import { describe, it, expect } from 'vitest'
import buildMatchQuery from '../src/electron/lib/search/build-match-query.mjs'

describe('buildMatchQuery', () => {
    it('returns empty for blank input', () => {
        expect(buildMatchQuery('')).toBe('')
        expect(buildMatchQuery('   ')).toBe('')
        expect(buildMatchQuery(null)).toBe('')
        expect(buildMatchQuery(undefined)).toBe('')
        expect(buildMatchQuery('!!---')).toBe('')
    })

    it('quotes a single term with a prefix on it', () => {
        expect(buildMatchQuery('hello')).toBe('"hello"*')
    })

    it('joins terms with AND and prefixes only the last', () => {
        expect(buildMatchQuery('hello world')).toBe('"hello" AND "world"*')
        expect(buildMatchQuery('a b c')).toBe('"a" AND "b" AND "c"*')
    })

    it('splits on punctuation and whitespace', () => {
        expect(buildMatchQuery('hello,world!')).toBe('"hello" AND "world"*')
        expect(buildMatchQuery('  spaced   out ')).toBe('"spaced" AND "out"*')
    })

    it('treats quotes as separators (they never enter a term)', () => {
        expect(buildMatchQuery('say "hi" now')).toBe('"say" AND "hi" AND "now"*')
    })

    it('keeps unicode letter/number runs intact', () => {
        expect(buildMatchQuery('café 東京 abc123')).toBe('"café" AND "東京" AND "abc123"*')
    })
})
