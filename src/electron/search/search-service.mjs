// The sync algorithm over the search index: which notes need (re-)extraction,
// which should be removed, and the resilience rules. No HTTP, no SQLite of its
// own — the api and store are injected.
// Port of SearchService (dotnetonenoteindexer).

import flattenSections from '../lib/search/hierarchy-flatten.mjs'
import needsIndexing from '../lib/search/needs-indexing.mjs'
import tombstonePlan from '../lib/search/tombstone-plan.mjs'
import { GraphApiError } from './graph-api-client.mjs'

function isFatal(error) {
    if (error instanceof GraphApiError && error.statusCode === 401) {
        return true // invalid token fails every section alike — surface to reauth
    }
    return error?.name === 'AbortError'
}

export default function createSearchService({ api, store, events = {}, notebookFilter }) {
    const syncError = (context, error) => events.syncError?.(context, error)
    const progress = (phase, data) => events.progress?.({ phase, ...data })

    async function sync({ mode = 'incremental' } = {}, ct) {
        const startedAt = Date.now()
        const stats = {
            sectionsTotal: 0,
            sectionsDone: 0,
            notesDone: 0,
            indexed: 0,
            removed: 0,
            skippedSections: 0,
            skippedNotes: 0,
        }

        if (mode === 'full') {
            await store.reset()
        }

        const indexedNotes = await store.getIndexedNotes()
        const indexed = new Map(indexedNotes.map((n) => [n.id, n]))
        const notebooks = await api.getNotebooks(ct)
        // Record the notebooks we saw so the config view can list them (and
        // toggle their indexing scope) even before any note is indexed.
        await store.setNotebooks(notebooks.map((nb) => ({ id: nb.id, displayName: nb.displayName })))
        const sections = flattenSections(notebooks, notebookFilter)
        stats.sectionsTotal = sections.length

        progress('hierarchy', { sectionsTotal: stats.sectionsTotal })

        const seen = new Set()
        const walkedSections = new Set()

        for (const section of sections) {
            let notes
            try {
                notes = await api.getNotes(section.id, ct)
            } catch (error) {
                if (isFatal(error)) {
                    throw error
                }
                stats.skippedSections++
                syncError(`listing notes in section ${section.id}`, error)
                continue
            }

            walkedSections.add(section.id)

            for (const note of notes) {
                if (ct?.aborted) {
                    throw ct.reason ?? new Error('Aborted')
                }
                seen.add(note.id)
                const existing = indexed.get(note.id) ?? null
                if (!needsIndexing(note, existing)) {
                    continue
                }

                try {
                    const content = await api.getNoteContent(note.id, ct)
                    await store.indexNote(
                        { ...note, sectionName: section.sectionName, notebookName: section.notebookName },
                        content
                    )
                    stats.indexed++
                } catch (error) {
                    if (isFatal(error)) {
                        throw error
                    }
                    stats.skippedNotes++
                    syncError(`extracting note ${note.id}`, error)
                }

                stats.notesDone++
                if (stats.notesDone % 20 === 0) {
                    progress('notes', { notesDone: stats.notesDone, sectionsDone: stats.sectionsDone, sectionsTotal: stats.sectionsTotal })
                }
            }

            stats.sectionsDone++
            progress('sections', { sectionsDone: stats.sectionsDone, sectionsTotal: stats.sectionsTotal, notesDone: stats.notesDone })
        }

        // Tombstone pass is safe: it runs only for notes whose section was
        // actually walked, so a skipped (failed) section never loses entries.
        const removals = tombstonePlan({ indexed: indexedNotes, seen, walkedSections })
        for (const noteId of removals) {
            await store.removeNote(noteId)
        }
        stats.removed = removals.length

        await store.setMeta('last_sync_at', new Date().toISOString())
        stats.durationMs = Date.now() - startedAt
        return { notebooks, stats }
    }

    async function search(query) {
        return store.search(query)
    }

    async function count() {
        return (await store.getIndexedNotes()).length
    }

    // Targeted reindex primitives (spike parity; not wired to the UI yet).
    async function indexNote(noteId, sectionId, ct) {
        const notes = await api.getNotes(sectionId, ct)
        const note = notes.find((n) => n.id === noteId)
        if (!note) {
            await store.removeNote(noteId)
            return
        }
        const content = await api.getNoteContent(noteId, ct)
        await store.indexNote(note, content)
    }

    async function indexSection(sectionId, ct) {
        const indexed = (await store.getIndexedNotes()).filter((n) => n.sectionId === sectionId)
        const byId = new Map(indexed.map((n) => [n.id, n]))
        const notes = await api.getNotes(sectionId, ct)
        const seen = new Set()
        for (const note of notes) {
            seen.add(note.id)
            if (!needsIndexing(note, byId.get(note.id) ?? null)) {
                continue
            }
            const content = await api.getNoteContent(note.id, ct)
            await store.indexNote(note, content)
        }
        for (const entry of indexed) {
            if (!seen.has(entry.id)) {
                await store.removeNote(entry.id)
            }
        }
    }

    return { sync, search, count, indexNote, indexSection }
}
