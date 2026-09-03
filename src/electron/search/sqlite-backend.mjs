// The only module that touches the SQLite engine. The indexer runs in two
// runtimes — plain Node (dev CLI, vitest) and Electron's utilityProcess — so
// the backend is resolved at runtime: node:sqlite (FTS5 verified inside
// Electron 42) with a better-sqlite3 fallback. Everything above this file
// speaks one tiny synchronous interface: run/get/all/exec/close.

import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

function wrapNodeSqlite(db) {
    const prepare = (sql) => db.prepare(sql)
    return {
        run: (sql, ...params) => prepare(sql).run(...params),
        get: (sql, ...params) => prepare(sql).get(...params),
        all: (sql, ...params) => prepare(sql).all(...params),
        exec: (sql) => db.exec(sql),
        close: () => db.close(),
    }
}

function openNodeSqlite(path) {
    const { DatabaseSync } = require('node:sqlite')
    return wrapNodeSqlite(new DatabaseSync(path))
}

function openBetterSqlite3(path) {
    const Database = require('better-sqlite3')
    const db = new Database(path)
    return {
        run: (sql, ...params) => db.prepare(sql).run(...params),
        get: (sql, ...params) => db.prepare(sql).get(...params),
        all: (sql, ...params) => db.prepare(sql).all(...params),
        exec: (sql) => db.exec(sql),
        close: () => db.close(),
    }
}

export default function openDatabase(path) {
    let failure = null
    try {
        return openNodeSqlite(path)
    } catch (error) {
        failure = error
    }
    try {
        return openBetterSqlite3(path)
    } catch {
        // Report the primary backend's failure — better-sqlite3 is only a fallback.
        throw failure ?? new Error('No SQLite backend available')
    }
}
