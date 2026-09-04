import { describe, it, expect } from 'vitest'
import createSearchService from '../src/electron/search/search-service.mjs'
import { GraphApiError } from '../src/electron/search/graph-api-client.mjs'

const note = (id, sectionId, lastModifiedDateTime) => ({ id, title: `Note ${id}`, sectionId, lastModifiedDateTime })

// ── Fakes ─────────────────────────────────────────────────────────────

function fakeApi({ notesBySection = {}, contentByNote = {}, failSections = new Set(), failNotes = new Set() } = {}) {
    const contentCalls = []
    const api = {
        async getNotebooks() {
            return [{ id: 'nb1', displayName: 'NB', sections: [{ id: 's1', displayName: 'Sec1' }, { id: 's2', displayName: 'Sec2' }], sectionGroups: [] }]
        },
        async getNotes(sectionId) {
            if (failSections.has(sectionId)) {
                throw new GraphApiError(503, '{"error":{"code":"ServiceUnavailable"}}')
            }
            return notesBySection[sectionId] ?? []
        },
        async getNoteContent(noteId) {
            contentCalls.push(noteId)
            if (failNotes.has(noteId)) {
                throw new Error('extract boom')
            }
            return contentByNote[noteId] ?? ''
        },
        contentCalls,
    }
    return api
}

function fakeStore() {
    const notes = new Map()
    const meta = new Map()
    const notebooks = new Map()
    return {
        async indexNote(entry, content) {
            notes.set(entry.id, { ...entry, content })
        },
        async removeNote(id) {
            notes.delete(id)
        },
        async search() {
            return []
        },
        async getIndexedNotes() {
            return [...notes.values()]
        },
        async reset() {
            notes.clear()
            meta.delete('last_sync_at')
        },
        async getMeta(key) {
            return meta.get(key) ?? null
        },
        async setMeta(key, value) {
            meta.set(key, value)
        },
        async setNotebooks(list) {
            for (const nb of list) {
                if (!notebooks.has(nb.id)) {
                    notebooks.set(nb.id, { ...nb, enabled: true })
                }
            }
        },
        async getNotebooks() {
            return [...notebooks.values()]
        },
        async setNotebookEnabled() {},
        async getNotebookStats() {
            return []
        },
        async getRecentActivity() {
            return []
        },
        async close() {},
        state: notes,
        notebookState: notebooks,
    }
}

const events = () => {
    const syncErrors = []
    return {
        syncErrors,
        syncError: (context, error) => syncErrors.push({ context, error }),
    }
}

const ts = (days) => new Date(Date.UTC(2026, 0, days)).toISOString()

// ── Tests ─────────────────────────────────────────────────────────────

describe('search service sync', () => {
    it('full sync indexes all notes and records sync bookkeeping', async () => {
        const api = fakeApi({
            notesBySection: {
                s1: [note('a', 's1', ts(2)), note('b', 's1', ts(1))],
                s2: [note('c', 's2', ts(1))],
            },
            contentByNote: { a: 'alpha content', b: 'beta content', c: 'gamma content' },
        })
        const store = fakeStore()
        const { sync } = createSearchService({ api, store, events: events() })

        const result = await sync({ mode: 'full' })

        expect(store.state.size).toBe(3)
        expect(result.stats.indexed).toBe(3)
        expect(await store.getMeta('last_sync_at')).not.toBe(null)
        expect(store.state.get('a').sectionName).toBe('Sec1')
        expect(store.state.get('a').notebookName).toBe('NB')
    })

    it('incremental sync skips unchanged notes', async () => {
        const api = fakeApi({
            notesBySection: { s1: [note('a', 's1', ts(2))] },
            contentByNote: { a: 'content' },
        })
        const store = fakeStore()
        store.state.set('a', { ...note('a', 's1', ts(2)) })
        const { sync } = createSearchService({ api, store, events: events() })

        await sync({ mode: 'incremental' })

        expect(api.contentCalls).toHaveLength(0)
    })

    it('re-extracts a note moved between sections', async () => {
        const api = fakeApi({
            notesBySection: { s1: [note('a', 's1', ts(2))] },
            contentByNote: { a: 'content' },
        })
        const store = fakeStore()
        store.state.set('a', { ...note('a', 's9', ts(2)) })
        const { sync } = createSearchService({ api, store, events: events() })

        await sync({ mode: 'incremental' })

        expect(api.contentCalls).toEqual(['a'])
        expect(store.state.get('a').sectionId).toBe('s1')
    })

    it('re-extracts a note whose timestamp advanced', async () => {
        const api = fakeApi({
            notesBySection: { s1: [note('a', 's1', ts(3))] },
            contentByNote: { a: 'content' },
        })
        const store = fakeStore()
        store.state.set('a', { ...note('a', 's1', ts(2)) })
        const { sync } = createSearchService({ api, store, events: events() })

        await sync({ mode: 'incremental' })

        expect(api.contentCalls).toEqual(['a'])
    })

    it('tombstones notes missing from a walked section only', async () => {
        const api = fakeApi({
            notesBySection: { s1: [] }, // 'gone' was in s1, s2 fails entirely
            failSections: new Set(['s2']),
        })
        const store = fakeStore()
        store.state.set('gone', { ...note('gone', 's1', ts(1)) })
        store.state.set('kept', { ...note('kept', 's2', ts(1)) })
        const { sync } = createSearchService({ api, store, events: events() })

        await sync({ mode: 'incremental' })

        expect(store.state.has('gone')).toBe(false)
        expect(store.state.has('kept')).toBe(true) // s2 not walked — safety rule
    })

    it('skips a failing section and continues', async () => {
        const api = fakeApi({
            notesBySection: { s1: [note('a', 's1', ts(1))] },
            contentByNote: { a: 'content' },
            failSections: new Set(['s2']),
        })
        const store = fakeStore()
        const e = events()
        const { sync } = createSearchService({ api, store, events: e })

        const result = await sync({ mode: 'incremental' })

        expect(store.state.has('a')).toBe(true)
        expect(result.stats.skippedSections).toBe(1)
        expect(e.syncErrors).toHaveLength(1)
        expect(e.syncErrors[0].context).toContain('s2')
    })

    it('skips a failing note and continues', async () => {
        const api = fakeApi({
            notesBySection: { s1: [note('a', 's1', ts(1)), note('b', 's1', ts(1))] },
            contentByNote: { a: 'content' },
            failNotes: new Set(['b']),
        })
        const store = fakeStore()
        const e = events()
        const { sync } = createSearchService({ api, store, events: e })

        await sync({ mode: 'incremental' })

        expect(store.state.has('a')).toBe(true)
        expect(store.state.has('b')).toBe(false)
        expect(e.syncErrors).toHaveLength(1)
        expect(e.syncErrors[0].context).toContain('note b')
    })

    it('rethrows a 401 as fatal', async () => {
        const api = fakeApi({})
        api.getNotes = async () => {
            throw new GraphApiError(401, '{"error":{"code":"InvalidAuthenticationToken"}}')
        }
        const store = fakeStore()
        const { sync } = createSearchService({ api, store, events: events() })

        await expect(sync({ mode: 'incremental' })).rejects.toBeInstanceOf(GraphApiError)
    })

    it('full sync resets the store first', async () => {
        const api = fakeApi({
            notesBySection: { s1: [note('a', 's1', ts(1))] },
            contentByNote: { a: 'content' },
        })
        const store = fakeStore()
        store.state.set('stale', { ...note('stale', 's1', ts(1)) })
        const { sync } = createSearchService({ api, store, events: events() })

        await sync({ mode: 'full' })

        expect(store.state.has('stale')).toBe(false)
        expect(store.state.has('a')).toBe(true)
    })

    it('records the notebooks it walks', async () => {
        const api = fakeApi({
            notesBySection: { s1: [note('a', 's1', ts(1))] },
            contentByNote: { a: 'content' },
        })
        const store = fakeStore()
        const { sync } = createSearchService({ api, store, events: events() })

        await sync({ mode: 'incremental' })

        expect([...store.notebookState.values()].map((nb) => nb.id)).toEqual(['nb1'])
    })

    it('applies the notebook filter', async () => {
        const api = fakeApi({})
        api.getNotebooks = async () => [
            { id: 'nb1', displayName: 'Work', sections: [{ id: 's1', displayName: 'Sec1' }], sectionGroups: [] },
            { id: 'nb2', displayName: 'Personal', sections: [{ id: 's2', displayName: 'Sec2' }], sectionGroups: [] },
        ]
        const store = fakeStore()
        const { sync } = createSearchService({
            api,
            store,
            events: events(),
            notebookFilter: (nb) => nb.displayName === 'Work',
        })

        await sync({ mode: 'incremental' })

        expect(store.state.size).toBe(0) // only Personal had notes, Work was empty
        expect(api.contentCalls).toHaveLength(0)
    })
})
