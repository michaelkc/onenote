import { describe, it, expect } from 'vitest'
import flattenSections from '../src/electron/lib/search/hierarchy-flatten.mjs'

const section = (id, displayName) => ({ id, displayName })
const group = (displayName, { sections = [], sectionGroups = [] } = {}) => ({ displayName, sections, sectionGroups })
const notebook = (displayName, { sections = [], sectionGroups = [] } = {}) => ({ displayName, sections, sectionGroups })

const hierarchy = [
    notebook('Work', {
        sections: [section('s1', 'Meeting Notes')],
        sectionGroups: [
            group('Projects', {
                sections: [section('s2', 'Alpha')],
                sectionGroups: [group('Nested', { sections: [section('s3', 'Deep')] })],
            }),
        ],
    }),
    notebook('Personal', {
        sections: [section('s4', 'Journal')],
    }),
]

describe('flattenSections', () => {
    it('flattens nested section groups depth-first with notebook context', () => {
        const flat = flattenSections(hierarchy)
        expect(flat).toEqual([
            { id: 's1', sectionName: 'Meeting Notes', notebookName: 'Work' },
            { id: 's2', sectionName: 'Alpha', notebookName: 'Work' },
            { id: 's3', sectionName: 'Deep', notebookName: 'Work' },
            { id: 's4', sectionName: 'Journal', notebookName: 'Personal' },
        ])
    })

    it('applies the notebook filter to nested groups too', () => {
        const flat = flattenSections(hierarchy, (nb) => nb.displayName === 'Personal')
        expect(flat.map((s) => s.id)).toEqual(['s4'])
    })

    it('handles empty inputs', () => {
        expect(flattenSections([])).toEqual([])
        expect(flattenSections(undefined)).toEqual([])
        expect(flattenSections([notebook('Empty')])).toEqual([])
    })
})
