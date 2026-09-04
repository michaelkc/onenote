// Main-process owner of the search indexer: spawns the headless indexer in an
// Electron utilityProcess (MessagePort protocol, see src/electron/search/
// indexer-entry.mjs), decides when to sync, stores harvested tokens, and
// forwards indexer events to the renderer overlay.

import { app, utilityProcess } from 'electron'
import { existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import registry from '../registry.mjs'
import accountKey from '../lib/search/account-key.mjs'
import { decideTokenAction, extractAccountFromToken } from '../lib/search/token-refresh-policy.mjs'
import { refreshAccessToken } from '../lib/search/token-endpoint.mjs'
import validateTokenCandidates from './search-token-validate.mjs'
import startPkceSignIn, { DEFAULT_SEARCH_CLIENT_ID } from './search-pkce.mjs'

const AUTH_CONF_KEY = 'searchAuth'
const AUTH_MARGIN_MS = 5 * 60 * 1000
const SYNC_ERRORS_MAX = 20

const log = (...args) => console.log('[P3X-Search]', ...args)

let child = null
let nextId = 1
let shuttingDown = false
let gracefulExit = false

// id -> { resolve, reject } for request/response messages from the child.
const pending = new Map()

// Exactly one sync runs at a time; a full sync requested meanwhile is queued.
let activeSync = null // { id, accountKey, mode, startedAt }
let pendingFull = null // { accountKey, token }
let awaitingToken = null // { accountKey, at } while the child waits for a re-harvest
let lastSyncStats = null
const syncErrors = []

// ── Child plumbing ───────────────────────────────────────────────────

function spawnChild() {
    if (child) {
        return child
    }
    const entry = path.join(path.dirname(fileURLToPath(import.meta.url)), '../search/indexer-entry.mjs')
    child = utilityProcess.fork(entry, [], {
        serviceName: 'p3x-onenote-search-indexer',
        stdio: 'inherit',
    })
    child.on('spawn', () => log('indexer child spawned (pid ' + child.pid + ')'))
    child.on('message', onChildMessage)
    child.on('exit', () => {
        for (const [, waiter] of pending) {
            waiter.reject(new Error('Search indexer exited'))
        }
        pending.clear()
        activeSync = null
        const unexpected = !shuttingDown && !gracefulExit
        child = null
        shuttingDown = false
        gracefulExit = false
        if (unexpected) {
            log('indexer exited unexpectedly')
        }
    })
    return child
}

async function onChildMessage(message) {
    switch (message.type) {
        case 'sync-done': {
            const sync = activeSync
            activeSync = null
            lastSyncStats = message.stats
            if (message.stats?.error) {
                syncErrors.push({ context: 'sync', message: message.stats.error.message })
                if (syncErrors.length > SYNC_ERRORS_MAX) {
                    syncErrors.shift()
                }
            }
            forwardToRenderer({ type: 'sync-done', stats: message.stats }, sync?.accountKey)
            log('sync done', JSON.stringify(message.stats))

            if (pendingFull) {
                const queued = pendingFull
                pendingFull = null
                startSync({ mode: 'full', accountKey: queued.accountKey, token: queued.token })
            }
            break
        }

        case 'event':
            forwardToRenderer(message.event, activeSync?.accountKey)
            break

        case 'get-token': {
            // The child's token provider timed out or saw a 401. Prefer a
            // silent refresh via the stored refresh token; otherwise ask the
            // renderer (harvest first, then an interactive PKCE sign-in).
            const key = activeSync?.accountKey ?? null
            const fresh = key ? await resolveAccessToken(key) : null
            if (fresh && child) {
                child.postMessage({ type: 'token-updated', token: fresh })
                break
            }
            awaitingToken = { accountKey: key, at: Date.now() }
            forwardToRenderer({ type: 'token-needed' }, key)
            break
        }

        case 'search-results':
        case 'count':
        case 'meta':
        case 'stats-result':
        case 'set-notebook-done':
            resolvePending(message.id, message)
            break

        case 'error':
            rejectPending(message.id, new Error(message.message))
            break

        case 'shutdown-ack':
            // The child closed its stores and is exiting — the exit event that
            // follows is expected, not a crash.
            gracefulExit = true
            try {
                child?.kill()
            } catch {}
            break

        default:
            log('unknown child message', message.type)
    }
}

function resolvePending(id, data) {
    const waiter = pending.get(id)
    if (waiter) {
        pending.delete(id)
        waiter.resolve(data)
    }
}

function rejectPending(id, error) {
    const waiter = pending.get(id)
    if (waiter) {
        pending.delete(id)
        waiter.reject(error)
    }
}

function request(message, timeoutMs = 60000) {
    const id = `sr-${nextId++}`
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            pending.delete(id)
            reject(new Error('Search indexer did not respond'))
        }, timeoutMs)
        pending.set(id, {
            resolve: (data) => {
                clearTimeout(timer)
                resolve(data)
            },
            reject: (error) => {
                clearTimeout(timer)
                reject(error)
            },
        })
        spawnChild().postMessage({ id, ...message })
    })
}

function forwardToRenderer(event, accountKey) {
    if (registry.window?.onenote && !registry.window.onenote.isDestroyed()) {
        registry.window.onenote.webContents.send('p3x-onenote-search-event', { ...event, accountKey })
    }
}

// ── Tokens (electron-store; main-only writes) ────────────────────────

function getStoredToken(key) {
    const auth = registry.conf.get(AUTH_CONF_KEY) || {}
    return auth[key] || null
}

function setStoredToken(key, bundle) {
    const auth = registry.conf.get(AUTH_CONF_KEY) || {}
    auth[key] = bundle
    registry.conf.set(AUTH_CONF_KEY, auth)
}

async function validateAndStoreToken({ accountKey: rawKey, candidates }) {
    const unique = [...new Set(candidates ?? [])].filter(Boolean)
    log(`validating ${unique.length} harvested token candidate(s)`)
    const winner = await validateTokenCandidates(unique)
    if (!winner) {
        log('token validation failed — none of the harvested tokens passed the Graph check')
        return { valid: false }
    }
    const key = accountKey(rawKey)
    setStoredToken(key, {
        accessToken: winner.token,
        harvestedAt: Date.now(),
        expiresOn: winner.expiresOn,
    })
    log(`token validated and stored for ${key}`)

    // If a running sync is waiting on a re-harvest, hand the fresh token to
    // the indexer child right away.
    if (awaitingToken && (awaitingToken.accountKey === null || awaitingToken.accountKey === key) && child) {
        awaitingToken = null
        child.postMessage({ type: 'token-updated', token: winner.token })
    }

    return { valid: true, expiresOn: winner.expiresOn }
}

function getAuthState(key) {
    const stored = getStoredToken(key)
    if (!stored?.accessToken) {
        return 'missing'
    }
    const action = decideTokenAction({
        token: stored.accessToken,
        expiresOnMs: stored.expiresOn ?? null,
        nowMs: Date.now(),
        marginMs: AUTH_MARGIN_MS,
    })
    return action === 'use' ? 'ok' : 'stale'
}

function clearToken(rawKey) {
    if (!rawKey) {
        // Session data is being wiped — no harvested token survives it.
        registry.conf.delete(AUTH_CONF_KEY)
    } else {
        const key = accountKey(rawKey)
        const auth = registry.conf.get(AUTH_CONF_KEY) || {}
        delete auth[key]
        registry.conf.set(AUTH_CONF_KEY, auth)
    }
    // The Search menu renders the signed-in account — rebuild it on change.
    registry.mainMenu?.()
    registry.mainTray?.()
}

// A usable access token for a sync: the stored one while fresh, refreshed via
// the refresh token when stale (PKCE bundles only), null when neither works —
// the caller then asks the renderer to harvest or sign in.
async function resolveAccessToken(key) {
    const stored = getStoredToken(key)
    if (!stored?.accessToken) {
        return null
    }

    const action = decideTokenAction({
        token: stored.accessToken,
        expiresOnMs: stored.expiresOn ?? null,
        nowMs: Date.now(),
        marginMs: AUTH_MARGIN_MS,
    })
    if (action === 'use') {
        return stored.accessToken
    }

    if (!stored.refreshToken) {
        return null // a harvested webview token cannot be refreshed
    }

    const clientId = registry.conf.get('searchClientId') || DEFAULT_SEARCH_CLIENT_ID

    log(`refreshing access token for ${key}`)
    try {
        const refreshed = await refreshAccessToken({ refreshToken: stored.refreshToken, clientId })
        setStoredToken(key, { ...stored, ...refreshed, acquiredAt: Date.now() })
        return refreshed.accessToken
    } catch (error) {
        log(`token refresh failed for ${key}: ${error.message}`)
        return null
    }
}

// Interactive PKCE sign-in (system browser + loopback redirect). Stores the
// bundle under the account the token identifies, unblocks a waiting sync, and
// kicks off the startup sync.
async function startSignIn({ accountKey: rawKey } = {}) {
    try {
        const { bundle } = await startPkceSignIn({ accountKey: rawKey })
        const account = extractAccountFromToken(bundle.accessToken) || rawKey || 'default'
        const key = accountKey(account)
        setStoredToken(key, {
            accessToken: bundle.accessToken,
            refreshToken: bundle.refreshToken,
            expiresOn: bundle.expiresOn,
            source: 'pkce',
            account,
            acquiredAt: Date.now(),
        })
        registry.mainMenu()
        registry.mainTray()

        if (awaitingToken && (awaitingToken.accountKey === null || awaitingToken.accountKey === key) && child) {
            awaitingToken = null
            child.postMessage({ type: 'token-updated', token: bundle.accessToken })
        }

        requestSync({ mode: 'auto', accountKey: key }).catch(() => {})
        log(`signed in for ${account} (key ${key})`)
        return { success: true, accountKey: key }
    } catch (error) {
        log(`sign-in failed: ${error.message}`)
        return { success: false, message: error.message }
    }
}

// ── Sync lifecycle ───────────────────────────────────────────────────

function getDbPath(key) {
    const dir = path.join(app.getPath('userData'), 'search')
    mkdirSync(dir, { recursive: true })
    return path.join(dir, `${key}.sqlite3`)
}

function startSync({ mode, accountKey: key, token }) {
    const id = `sync-${nextId++}`
    activeSync = { id, accountKey: key, mode, startedAt: Date.now() }
    spawnChild().postMessage({
        id,
        type: 'sync',
        mode,
        token,
        dbPath: getDbPath(key),
        accountKey: key,
    })
    forwardToRenderer({ type: 'sync-started', mode }, key)
    log(`sync ${mode} started for ${key}`)
}

async function requestSync({ mode = 'auto', accountKey: rawKey } = {}) {
    const key = accountKey(rawKey)

    const token = await resolveAccessToken(key)
    if (!token) {
        return { started: false, reason: 'auth' }
    }

    if (mode === 'auto') {
        const dbPath = getDbPath(key)
        if (!existsSync(dbPath)) {
            mode = 'full'
        } else {
            try {
                const meta = await request({ type: 'meta', dbPath })
                const lastSyncAt = meta?.lastSyncAt ? Date.parse(meta.lastSyncAt) : null
                const staleMs = registry.conf.get('searchSyncStaleMs', 24 * 3600 * 1000)
                if (lastSyncAt && !Number.isNaN(lastSyncAt) && Date.now() - lastSyncAt < staleMs) {
                    return { started: false, reason: 'fresh' }
                }
                mode = 'incremental'
            } catch {
                // Indexer unavailable or DB unreadable — a fresh walk is the safe default.
                mode = 'incremental'
            }
        }
    }

    if (activeSync) {
        if (mode === 'full' && activeSync.mode !== 'full') {
            pendingFull = { accountKey: key, token }
            return { started: false, reason: 'queued' }
        }
        return { started: false, reason: 'busy' }
    }

    startSync({ mode, accountKey: key, token })
    return { started: true, mode }
}

// ── Queries ──────────────────────────────────────────────────────────

async function query(queryText, rawKey) {
    const key = accountKey(rawKey)
    if (!child) {
        return { results: [] }
    }
    try {
        const result = await request({ type: 'search', query: queryText, dbPath: getDbPath(key) })
        return { results: result.results }
    } catch {
        return { results: [] }
    }
}

// The index-status view's data: per-notebook stats, recent activity, and the
// controller-side sync state (live progress reaches the renderer via events).
async function getIndexStatus(rawKey) {
    const key = accountKey(rawKey)
    const status = {
        notebooks: [],
        activity: [],
        lastSyncAt: null,
        syncing: activeSync?.accountKey === key,
        lastSyncStats,
        syncErrors: [...syncErrors],
        authState: getAuthState(key),
    }
    if (child) {
        try {
            const result = await request({ type: 'stats', dbPath: getDbPath(key) })
            status.notebooks = result.notebooks
            status.activity = result.activity
            status.lastSyncAt = result.lastSyncAt
        } catch {}
    }
    return status
}

async function setNotebookEnabled({ accountKey: rawKey, notebookId, enabled } = {}) {
    const key = accountKey(rawKey)
    if (!child || !notebookId) {
        return { ok: false }
    }
    try {
        await request({ type: 'set-notebook', dbPath: getDbPath(key), notebookId, enabled })
        return { ok: true }
    } catch {
        return { ok: false }
    }
}

async function count(rawKey) {
    const key = accountKey(rawKey)
    const dbPath = getDbPath(key)
    let lastSyncAt = null
    let indexedCount = 0
    if (child) {
        try {
            const meta = await request({ type: 'meta', dbPath })
            lastSyncAt = meta.lastSyncAt
            indexedCount = meta.indexedCount
        } catch {}
    }
    return {
        count: indexedCount,
        lastSyncAt,
        syncing: activeSync?.accountKey === key,
        authState: getAuthState(key),
    }
}

// ── Lifecycle ────────────────────────────────────────────────────────

function init() {
    spawnChild()
}

function shutdown() {
    if (!child) {
        return
    }
    shuttingDown = true
    try {
        child.postMessage({ type: 'shutdown' })
    } catch {}
    // Give the child a moment to close its stores, then force-kill.
    setTimeout(() => {
        try {
            child?.kill()
        } catch {}
        child = null
    }, 2000)
}

export default {
    init,
    shutdown,
    query,
    count,
    getIndexStatus,
    setNotebookEnabled,
    requestSync,
    validateTokenCandidates: validateAndStoreToken,
    startSignIn,
    clearToken,
    getAuthState,
    getDbPath,
    getLastSyncStats: () => lastSyncStats,
    getSyncErrors: () => [...syncErrors],
    isSyncing: () => activeSync !== null,
}
