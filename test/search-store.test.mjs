import { describe, it, expect, beforeEach } from 'vitest'
import createSqliteStore from '../src/electron/search/sqlite-store.mjs'
import { SNIPPET_MARK_OPEN, SNIPPET_MARK_CLOSE } from '../src/electron/lib/search/parse-snippet.mjs'

const O = SNIPPET_MARK_OPEN
const C = SNIPPET_MARK_CLOSE

const note = (overrides = {}) => ({
    id: 'n1',
    title: 'Meeting notes',
    sectionId: 's1',
    sectionName: 'Work',
    notebookName: 'Main',
    lastModifiedDateTime: '2026-01-01T00:00:00Z',
    webUrl: 'https://onedrive.live.com/redir.aspx?resid=abc',
    ...overrides,
})

describe('sqlite store', () => {
    let store
    beforeEach(() => {
        store = createSqliteStore(':memory:')
    })

    it('indexes and reads back a note with all fields', async () => {
        await store.indexNote(note(), 'hello world from onenote')
        const indexed = await store.getIndexedNotes()
        expect(indexed).toHaveLength(1)
        expect(indexed[0]).toMatchObject({
            id: 'n1',
            title: 'Meeting notes',
            sectionId: 's1',
            sectionName: 'Work',
            notebookName: 'Main',
            lastModifiedDateTime: '2026-01-01T00:00:00Z',
            webUrl: 'https://onedrive.live.com/redir.aspx?resid=abc',
        })
    })

    it('upserts instead of duplicating, and replaces content', async () => {
        await store.indexNote(note(), 'old content alpha')
        await store.indexNote(note({ title: 'Renamed' }), 'new content beta')

        const indexed = await store.getIndexedNotes()
        expect(indexed).toHaveLength(1)
        expect(indexed[0].title).toBe('Renamed')

        expect((await store.search('alpha'))).toHaveLength(0)
        expect((await store.search('beta'))).toHaveLength(1)
    })

    it('finds content with marked snippets', async () => {
        await store.indexNote(note(), 'the quick brown fox')
        const results = await store.search('brown')
        expect(results).toHaveLength(1)
        expect(results[0].snippet).toContain(`${O}brown${C}`)
        expect(results[0].title).toBe('Meeting notes')
        expect(results[0].webUrl).toBe('https://onedrive.live.com/redir.aspx?resid=abc')
    })

    it('orders results by relevance', async () => {
        await store.indexNote(note({ id: 'rare' }), 'common')
        await store.indexNote(note({ id: 'frequent' }), 'common common common')
        const results = await store.search('common')
        expect(results[0].id).toBe('frequent')
    })

    it('caps results at 100', async () => {
        for (let i = 0; i < 105; i++) {
            await store.indexNote(note({ id: `n${i}` }), 'shared term')
        }
        expect((await store.search('shared'))).toHaveLength(100)
    })

    it('removes notes', async () => {
        await store.indexNote(note(), 'content')
        await store.removeNote('n1')
        expect(await store.getIndexedNotes()).toHaveLength(0)
        expect(await store.search('content')).toHaveLength(0)
    })

    it('resets the index and the sync bookkeeping', async () => {
        await store.indexNote(note(), 'content')
        await store.setMeta('last_sync_at', '2026-01-01T00:00:00Z')
        await store.reset()
        expect(await store.getIndexedNotes()).toHaveLength(0)
        expect(await store.getMeta('last_sync_at')).toBe(null)
    })

    it('round-trips meta values', async () => {
        expect(await store.getMeta('last_sync_at')).toBe(null)
        await store.setMeta('last_sync_at', '2026-01-01T00:00:00Z')
        expect(await store.getMeta('last_sync_at')).toBe('2026-01-01T00:00:00Z')
        await store.setMeta('last_sync_at', '2026-02-02T00:00:00Z')
        expect(await store.getMeta('last_sync_at')).toBe('2026-02-02T00:00:00Z')
    })

    it('returns no results for a blank query', async () => {
        await store.indexNote(note(), 'content')
        expect(await store.search('')).toEqual([])
        expect(await store.search('   ')).toEqual([])
    })
})
