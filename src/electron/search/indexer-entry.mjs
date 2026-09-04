// Entry point for the search indexer in both of its runtimes:
//
// - utilityProcess child (Electron): speaks the MessagePort protocol below
//   over process.parentPort, never importing electron.
// - plain Node CLI (development / live smoke tests, process.parentPort ===
//   undefined): spike-style commands driven by argv + the ONENOTE_TOKEN env.
//
//   node indexer-entry.mjs --sync [--notebook <name>] [--db <path>]
//   node indexer-entry.mjs --search <query> [--db <path>]
//   node indexer-entry.mjs --count [--db <path>]

import os from 'node:os'
import path from 'node:path'
import createSqliteStore from './sqlite-store.mjs'
import createOneNoteApiClient, { GraphApiError } from './graph-api-client.mjs'
import createSearchService from './search-service.mjs'
import createTokenProvider from './token-provider.mjs'

const isChild = typeof process.parentPort !== 'undefined'
const port = process.parentPort

// ── Child: MessagePort protocol ──────────────────────────────────────

let currentStore = null
let currentDbPath = null
let pendingToken = null

function post(message) {
    port.postMessage(message)
}

function storeFor(dbPath) {
    if (dbPath !== currentDbPath) {
        currentStore?.close()
        currentStore = createSqliteStore(dbPath)
        currentDbPath = dbPath
    }
    return currentStore
}

function requestFreshToken() {
    return new Promise((resolve, reject) => {
        pendingToken = { resolve, reject }
        post({ type: 'get-token' })
    })
}

function errorMessage(error) {
    return error instanceof Error ? error.message : String(error)
}

async function runSync(message) {
    const { id, mode = 'incremental', token, dbPath, accountKey } = message
    const store = storeFor(dbPath)
    const tokenProvider = createTokenProvider({ initialToken: token, requestFreshToken })
    const api = createOneNoteApiClient({
        getAccessToken: () => tokenProvider.getAccessToken(),
        events: {
            retrying: (attempt, maxAttempts) =>
                post({ type: 'event', event: { kind: 'retrying', attempt, maxAttempts } }),
            throttleWaiting: (seconds, used, budget) =>
                post({ type: 'event', event: { kind: 'throttle-waiting', seconds, used, budget } }),
        },
    })
    // Notebook scope: enabled set from the store; an empty table (first sync)
    // means "all notebooks", so the filter only applies once the user has
    // explicitly disabled something.
    const enabledIds = new Set((await store.getNotebooks()).filter((n) => n.enabled).map((n) => n.id))
    const service = createSearchService({
        api,
        store,
        notebookFilter: enabledIds.size === 0 ? undefined : (nb) => enabledIds.has(nb.id),
        events: {
            syncError: (context, error) =>
                post({ type: 'event', event: { kind: 'sync-error', context, message: errorMessage(error) } }),
            progress: (event) => post({ type: 'event', event: { kind: 'progress', calls: api.getStats().calls, ...event } }),
        },
    })

    const startedAt = Date.now()
    const stats = { mode, accountKey, startedAt }

    const finish = (extra = {}) => {
        stats.durationMs = Date.now() - startedAt
        stats.calls = api.getStats().calls
        post({ id, type: 'sync-done', stats: { ...stats, ...extra } })
    }

    // One auth-retry pass per sync: a 401 drops the token and awaits a fresh
    // one from the harness before re-running the walk (incremental, so already
    // indexed notes are skipped by NeedsIndexing).
    let authRetried = false
    try {
        const result = await service.sync({ mode }, null)
        stats.indexed = result.stats.indexed
        stats.removed = result.stats.removed
        stats.skippedSections = result.stats.skippedSections
        stats.skippedNotes = result.stats.skippedNotes
        stats.sectionsDone = result.stats.sectionsDone
        stats.sectionsTotal = result.stats.sectionsTotal
        stats.notesDone = result.stats.notesDone
        finish()
    } catch (error) {
        if (error instanceof GraphApiError && error.statusCode === 401 && !authRetried) {
            authRetried = true
            post({ type: 'event', event: { kind: 'auth-error' } })
            try {
                await tokenProvider.invalidate()
                const result = await service.sync({ mode }, null)
                stats.indexed = result.stats.indexed
                stats.removed = result.stats.removed
                stats.skippedSections = result.stats.skippedSections
                stats.skippedNotes = result.stats.skippedNotes
                stats.sectionsDone = result.stats.sectionsDone
                stats.sectionsTotal = result.stats.sectionsTotal
                stats.notesDone = result.stats.notesDone
                finish()
                return
            } catch (authError) {
                finish({ error: { code: 'auth', message: errorMessage(authError) } })
                return
            }
        }
        finish({
            error: {
                code: error?.name === 'AbortError' ? 'aborted' : 'unknown',
                message: errorMessage(error),
            },
        })
    }
}

if (!isChild) {
    runCli().catch((error) => {
        console.error(`failed: ${error}`)
        process.exit(1)
    })
} else {
    attachChildProtocol()
}

function attachChildProtocol() {
port.on('message', (event) => {
    // Electron's process.parentPort emits web-style events ({ data, ports });
    // a plain Node MessagePort delivers the message directly. Accept both.
    const message = event?.data ?? event
    const handler = async () => {
        switch (message.type) {
            case 'sync':
                await runSync(message)
                break

            case 'search': {
                const store = storeFor(message.dbPath)
                const results = await store.search(message.query)
                post({ id: message.id, type: 'search-results', results })
                break
            }

            case 'count': {
                const store = storeFor(message.dbPath)
                const count = (await store.getIndexedNotes()).length
                post({ id: message.id, type: 'count', count })
                break
            }

            case 'meta': {
                const store = storeFor(message.dbPath)
                const lastSyncAt = await store.getMeta('last_sync_at')
                const indexedCount = (await store.getIndexedNotes()).length
                post({ id: message.id, type: 'meta', lastSyncAt, indexedCount })
                break
            }

            case 'stats': {
                const store = storeFor(message.dbPath)
                post({
                    id: message.id,
                    type: 'stats-result',
                    notebooks: await store.getNotebookStats(),
                    activity: await store.getRecentActivity(20),
                    lastSyncAt: await store.getMeta('last_sync_at'),
                })
                break
            }

            case 'set-notebook': {
                const store = storeFor(message.dbPath)
                await store.setNotebookEnabled(message.notebookId, message.enabled)
                post({ id: message.id, type: 'set-notebook-done', notebookId: message.notebookId, enabled: message.enabled })
                break
            }

            case 'token-updated':
                pendingToken?.resolve(message.token)
                pendingToken = null
                break

            case 'token-failed':
                pendingToken?.reject(new Error(message.message || 'Token refresh failed'))
                pendingToken = null
                break

            case 'shutdown':
                currentStore?.close()
                post({ type: 'shutdown-ack' })
                process.exit(0)
                break

            default:
                post({ id: message.id, type: 'error', message: `Unknown message type: ${message.type}` })
        }
    }
    handler().catch((error) => {
        if (message.id !== undefined && message.type !== 'sync') {
            post({ id: message.id, type: 'error', message: errorMessage(error) })
        }
    })
})
}

// ── CLI mode ─────────────────────────────────────────────────────────

// ── CLI mode ─────────────────────────────────────────────────────────

function arg(argv, name) {
    const index = argv.indexOf(name)
    return index !== -1 && index + 1 < argv.length ? argv[index + 1] : null
}

async function runCli() {
    const argv = process.argv.slice(2)
    const command = argv[0]
    const dbPath = arg(argv, '--db') ?? path.join(os.tmpdir(), 'p3x-search-index.sqlite3')

    if (command === '--sync') {
        const token = process.env.ONENOTE_TOKEN
        if (!token) {
            console.error('--sync requires ONENOTE_TOKEN in the environment')
            process.exit(2)
        }

        const store = createSqliteStore(dbPath)
        const tokenProvider = createTokenProvider({
            initialToken: token,
            requestFreshToken: () => Promise.reject(new Error('No token refresh in CLI mode')),
        })
        const api = createOneNoteApiClient({
            getAccessToken: () => tokenProvider.getAccessToken(),
            events: {
                retrying: (attempt, maxAttempts) =>
                    console.error(`retrying (${attempt}/${maxAttempts})...`),
            },
        })
        const notebookName = arg(argv, '--notebook')
        const service = createSearchService({
            api,
            store,
            notebookFilter: notebookName
                ? (nb) => (nb.displayName ?? '').toLowerCase().includes(notebookName.toLowerCase())
                : undefined,
            events: {
                syncError: (context, error) => console.error(`skipped ${context}: ${errorMessage(error)}`),
                progress: (event) => console.error(`progress ${event.phase} ${event.sectionsDone ?? ''}/${event.sectionsTotal ?? ''}`),
            },
        })

        console.error('Syncing...')
        const result = await service.sync({ mode: 'incremental' })
        const count = await service.count()
        console.error(
            `Synced ${count} notes across ${result.notebooks.length} notebook(s) into ${dbPath} ` +
            `(indexed ${result.stats.indexed}, removed ${result.stats.removed}, skipped ${result.stats.skippedSections} sections / ${result.stats.skippedNotes} notes)`
        )
        return
    }

    const store = createSqliteStore(dbPath)

    if (command === '--search') {
        if (argv.length < 2) {
            console.error('usage: --search <query> [--db <path>]')
            process.exit(2)
        }
        for (const hit of await store.search(argv[1])) {
            console.log(`${hit.id}\t${hit.title}\t${hit.snippet}`)
        }
        return
    }

    if (command === '--count') {
        console.log((await store.getIndexedNotes()).length)
        return
    }

    console.error('usage: --sync [--notebook <name>] [--db <path>] | --search <query> [--db <path>] | --count [--db <path>]')
    process.exit(2)
}
