import { describe, it, expect } from 'vitest'
import tombstonePlan from '../src/electron/lib/search/tombstone-plan.mjs'

const indexed = [
    { id: 'a', sectionId: 's1' },
    { id: 'b', sectionId: 's1' },
    { id: 'c', sectionId: 's2' },
]

describe('tombstonePlan', () => {
    it('removes notes not seen in their own walked section', () => {
        const plan = tombstonePlan({
            indexed,
            seen: new Set(['b', 'c']),
            walkedSections: new Set(['s1', 's2']),
        })
        expect(plan).toEqual(['a'])
    })

    it('keeps notes whose section was not walked (safety rule)', () => {
        const plan = tombstonePlan({
            indexed,
            seen: new Set(['b']),
            walkedSections: new Set(['s1']), // s2 failed — c must survive
        })
        expect(plan).toEqual(['a'])
    })

    it('keeps seen notes', () => {
        const plan = tombstonePlan({
            indexed,
            seen: new Set(['a', 'b', 'c']),
            walkedSections: new Set(['s1', 's2']),
        })
        expect(plan).toEqual([])
    })

    it('handles empty inputs', () => {
        expect(tombstonePlan({ indexed: [], seen: new Set(), walkedSections: new Set() })).toEqual([])
    })
})
