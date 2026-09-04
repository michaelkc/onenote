// The search index: a single SQLite database with an FTS5 content table and
// sync bookkeeping. The FTS index is kept in step with the notes table by
// triggers, so a write to the content table is mirrored into notes_fts
// transactionally. All operations are serialized through an internal gate so
// the background sync and UI searches never interleave.
// Port of SqliteLocalStore (dotnetonenoteindexer), plus section/notebook
// context columns and a meta table for sync bookkeeping.

import openDatabase from './sqlite-backend.mjs'
import buildMatchQuery from '../lib/search/build-match-query.mjs'
import { SNIPPET_MARK_OPEN, SNIPPET_MARK_CLOSE } from '../lib/search/parse-snippet.mjs'

const MAX_RESULTS = 100
const SNIPPET_ELLIPSIS = '…'
const SNIPPET_TOKENS = 12
const ACTIVITY_MAX = 50

const SCHEMA = `
CREATE TABLE IF NOT EXISTS notes (
    rowid INTEGER PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    section_id TEXT NOT NULL,
    section_name TEXT NOT NULL DEFAULT '',
    notebook_name TEXT NOT NULL DEFAULT '',
    last_modified TEXT,
    web_url TEXT,
    content TEXT NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
    title, content,
    content='notes', content_rowid='rowid'
);

CREATE TRIGGER IF NOT EXISTS notes_ai AFTER INSERT ON notes BEGIN
    INSERT INTO notes_fts(rowid, title, content) VALUES (new.rowid, new.title, new.content);
END;

CREATE TRIGGER IF NOT EXISTS notes_ad AFTER DELETE ON notes BEGIN
    INSERT INTO notes_fts(notes_fts, rowid, title, content) VALUES ('delete', old.rowid, old.title, old.content);
END;

CREATE TRIGGER IF NOT EXISTS notes_au AFTER UPDATE ON notes BEGIN
    INSERT INTO notes_fts(notes_fts, rowid, title, content) VALUES ('delete', old.rowid, old.title, old.content);
    INSERT INTO notes_fts(rowid, title, content) VALUES (new.rowid, new.title, new.content);
END;

CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT
);

CREATE TABLE IF NOT EXISTS notebooks (
    id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS activity (
    ts TEXT NOT NULL,
    note_id TEXT NOT NULL,
    title TEXT NOT NULL,
    notebook_name TEXT NOT NULL,
    action TEXT NOT NULL
);
`

function readNote(row) {
    return {
        id: row.id,
        title: row.title,
        sectionId: row.section_id,
        sectionName: row.section_name,
        notebookName: row.notebook_name,
        lastModifiedDateTime: row.last_modified,
        webUrl: row.web_url,
    }
}

export default function createSqliteStore(dbPath) {
    const db = openDatabase(dbPath)
    db.exec(SCHEMA)

    // Promise-chain gate: every op runs after the previous one completes, so
    // the background sync and UI searches never interleave on the connection.
    let chain = Promise.resolve()
    const exclusive = (fn) => {
        const run = chain.then(fn)
        chain = run.catch(() => {})
        return run
    }

    function logActivity(note, action) {
        db.run(
            'INSERT INTO activity (ts, note_id, title, notebook_name, action) VALUES (?, ?, ?, ?, ?)',
            new Date().toISOString(),
            note.id,
            note.title,
            note.notebookName ?? '',
            action
        )
        db.run(
            `DELETE FROM activity WHERE rowid NOT IN (
                 SELECT rowid FROM activity ORDER BY ts DESC, rowid DESC LIMIT ?
             )`,
            ACTIVITY_MAX
        )
    }

    return {
        indexNote(note, content) {
            return exclusive(() => {
                db.run(
                    `INSERT INTO notes (id, title, section_id, section_name, notebook_name, last_modified, web_url, content)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                     ON CONFLICT(id) DO UPDATE SET
                         title = excluded.title,
                         section_id = excluded.section_id,
                         section_name = excluded.section_name,
                         notebook_name = excluded.notebook_name,
                         last_modified = excluded.last_modified,
                         web_url = excluded.web_url,
                         content = excluded.content`,
                    note.id,
                    note.title,
                    note.sectionId,
                    note.sectionName ?? '',
                    note.notebookName ?? '',
                    note.lastModifiedDateTime ?? null,
                    note.webUrl ?? null,
                    content
                )
                logActivity(note, 'index')
            })
        },

        removeNote(noteId) {
            return exclusive(() => {
                const row = db.get('SELECT id, title, notebook_name FROM notes WHERE id = ?', noteId)
                if (row) {
                    logActivity({ id: row.id, title: row.title, notebookName: row.notebook_name }, 'remove')
                }
                db.run('DELETE FROM notes WHERE id = ?', noteId)
            })
        },

        search(query) {
            return exclusive(() => {
                const match = buildMatchQuery(query)
                if (match === '') {
                    return []
                }

                const rows = db.all(
                    `SELECT n.id, n.title, n.section_id, n.section_name, n.notebook_name,
                            n.last_modified, n.web_url,
                            snippet(notes_fts, 1, char(1), char(2), ?, ?) AS snip
                     FROM notes_fts
                     JOIN notes n ON n.rowid = notes_fts.rowid
                     WHERE notes_fts MATCH ?
                     ORDER BY notes_fts.rank
                     LIMIT ?`,
                    SNIPPET_ELLIPSIS,
                    SNIPPET_TOKENS,
                    match,
                    MAX_RESULTS
                )

                return rows.map((row) => {
                    const snippet = row.snip === null || row.snip.trim() === '' ? row.title : row.snip
                    return { ...readNote(row), snippet }
                })
            })
        },

        getIndexedNotes() {
            return exclusive(() => {
                const rows = db.all(
                    `SELECT id, title, section_id, section_name, notebook_name, last_modified, web_url
                     FROM notes
                     ORDER BY id`
                )
                return rows.map(readNote)
            })
        },

        reset() {
            return exclusive(() => {
                db.run('DELETE FROM notes')
                db.run("DELETE FROM meta WHERE key = 'last_sync_at'")
            })
        },

        getMeta(key) {
            return exclusive(() => {
                const row = db.get('SELECT value FROM meta WHERE key = ?', key)
                return row ? row.value : null
            })
        },

        setMeta(key, value) {
            return exclusive(() => {
                db.run(
                    `INSERT INTO meta (key, value) VALUES (?, ?)
                     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
                    key,
                    value
                )
            })
        },

        // Notebook configuration: the notebooks seen during sync, and which of
        // them are in scope for indexing (default: all).
        setNotebooks(notebooks) {
            return exclusive(() => {
                for (const notebook of notebooks) {
                    db.run(
                        `INSERT INTO notebooks (id, display_name) VALUES (?, ?)
                         ON CONFLICT(id) DO UPDATE SET display_name = excluded.display_name`,
                        notebook.id,
                        notebook.displayName ?? ''
                    )
                }
            })
        },

        getNotebooks() {
            return exclusive(() => {
                const rows = db.all('SELECT id, display_name, enabled FROM notebooks ORDER BY display_name')
                return rows.map((row) => ({
                    id: row.id,
                    displayName: row.display_name,
                    enabled: row.enabled === 1,
                }))
            })
        },

        setNotebookEnabled(notebookId, enabled) {
            return exclusive(() => {
                db.run('UPDATE notebooks SET enabled = ? WHERE id = ?', enabled ? 1 : 0, notebookId)
            })
        },

        getNotebookStats() {
            return exclusive(() => {
                const rows = db.all(
                    `SELECT nb.id, nb.display_name, nb.enabled,
                            COUNT(n.rowid) AS pages,
                            MAX(n.last_modified) AS last_modified
                     FROM notebooks nb
                     LEFT JOIN notes n ON n.notebook_name = nb.display_name
                     GROUP BY nb.id
                     ORDER BY nb.display_name`
                )
                return rows.map((row) => ({
                    id: row.id,
                    displayName: row.display_name,
                    enabled: row.enabled === 1,
                    pages: row.pages,
                    lastModifiedDateTime: row.last_modified,
                }))
            })
        },

        getRecentActivity(limit = 20) {
            return exclusive(() => {
                const rows = db.all(
                    'SELECT ts, note_id, title, notebook_name, action FROM activity ORDER BY ts DESC, rowid DESC LIMIT ?',
                    limit
                )
                return rows.map((row) => ({
                    ts: row.ts,
                    noteId: row.note_id,
                    title: row.title,
                    notebookName: row.notebook_name,
                    action: row.action,
                }))
            })
        },

        close() {
            return exclusive(() => {
                db.close()
            })
        },
    }
}
