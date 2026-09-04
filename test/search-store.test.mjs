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

    it('records, updates and toggles notebooks', async () => {
        await store.setNotebooks([
            { id: 'nb1', displayName: 'Work' },
            { id: 'nb2', displayName: 'Personal' },
        ])
        let notebooks = await store.getNotebooks()
        expect(notebooks).toHaveLength(2)
        expect(notebooks.every((nb) => nb.enabled)).toBe(true)

        await store.setNotebookEnabled('nb1', false)
        notebooks = await store.getNotebooks()
        expect(notebooks.find((nb) => nb.id === 'nb1').enabled).toBe(false)
        expect(notebooks.find((nb) => nb.id === 'nb2').enabled).toBe(true)

        // re-registering preserves the enabled flag and updates the name
        await store.setNotebooks([{ id: 'nb1', displayName: 'Work 2' }])
        notebooks = await store.getNotebooks()
        expect(notebooks.find((nb) => nb.id === 'nb1').displayName).toBe('Work 2')
        expect(notebooks.find((nb) => nb.id === 'nb1').enabled).toBe(false)
    })

    it('reports per-notebook stats', async () => {
        await store.setNotebooks([{ id: 'nb1', displayName: 'Main' }])
        await store.indexNote(note(), 'content')
        await store.indexNote(note({ id: 'n2', title: 'Second' }), 'more content')
        const stats = await store.getNotebookStats()
        expect(stats).toHaveLength(1)
        expect(stats[0].displayName).toBe('Main')
        expect(stats[0].pages).toBe(2)
        expect(stats[0].lastModifiedDateTime).toBe('2026-01-01T00:00:00Z')
    })

    it('logs index activity and prunes it to the cap', async () => {
        for (let i = 0; i < 55; i++) {
            await store.indexNote(note({ id: `n${i}`, title: `Note ${i}` }), 'content')
        }
        const activity = await store.getRecentActivity(100)
        expect(activity).toHaveLength(50)
        expect(activity[0].title).toBe('Note 54')
        expect(activity[0].action).toBe('index')
        expect(activity[0].notebookName).toBe('Main')
    })

    it('logs removals in the activity', async () => {
        await store.indexNote(note(), 'content')
        await store.removeNote('n1')
        const activity = await store.getRecentActivity()
        expect(activity[0]).toMatchObject({ noteId: 'n1', action: 'remove', title: 'Meeting notes' })
    })

    it('reset clears notes and sync bookkeeping but keeps notebook config', async () => {
        await store.setNotebooks([{ id: 'nb1', displayName: 'Work' }])
        await store.indexNote(note(), 'content')
        await store.setMeta('last_sync_at', '2026-01-01T00:00:00Z')
        await store.reset()
        expect(await store.getIndexedNotes()).toHaveLength(0)
        expect(await store.getMeta('last_sync_at')).toBe(null)
        expect(await store.getNotebooks()).toHaveLength(1)
    })
})
