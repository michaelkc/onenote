import { describe, it, expect } from 'vitest'
import needsIndexing from '../src/electron/lib/search/needs-indexing.mjs'

const note = (sectionId, lastModifiedDateTime) => ({ id: 'n1', sectionId, lastModifiedDateTime })

describe('needsIndexing', () => {
    it('indexes a note that is not indexed yet', () => {
        expect(needsIndexing(note('s1', '2026-01-01T00:00:00Z'), null)).toBe(true)
        expect(needsIndexing(note('s1', null), undefined)).toBe(true)
    })

    it('indexes a note moved between sections', () => {
        const live = note('s2', '2026-01-01T00:00:00Z')
        const indexed = note('s1', '2026-01-01T00:00:00Z')
        expect(needsIndexing(live, indexed)).toBe(true)
    })

    it('indexes when the live timestamp is missing (no evidence of currency)', () => {
        expect(needsIndexing(note('s1', null), note('s1', '2026-01-01T00:00:00Z'))).toBe(true)
    })

    it('indexes when the indexed timestamp is missing', () => {
        expect(needsIndexing(note('s1', '2026-01-01T00:00:00Z'), note('s1', null))).toBe(true)
    })

    it('indexes when the live timestamp advanced', () => {
        const live = note('s1', '2026-01-02T00:00:00Z')
        const indexed = note('s1', '2026-01-01T00:00:00Z')
        expect(needsIndexing(live, indexed)).toBe(true)
    })

    it('skips unchanged notes (equal or older timestamps)', () => {
        expect(needsIndexing(note('s1', '2026-01-01T00:00:00Z'), note('s1', '2026-01-01T00:00:00Z'))).toBe(false)
        expect(needsIndexing(note('s1', '2025-12-31T00:00:00Z'), note('s1', '2026-01-01T00:00:00Z'))).toBe(false)
    })

    it('compares epoch millis and ISO strings interchangeably', () => {
        const iso = '2026-01-02T00:00:00Z'
        const ms = Date.parse(iso)
        expect(needsIndexing(note('s1', ms), note('s1', '2026-01-01T00:00:00Z'))).toBe(true)
    })
})
