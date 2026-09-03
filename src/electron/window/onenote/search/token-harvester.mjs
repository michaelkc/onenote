// Lifts the signed-in OneNote webapp's bearer token out of the webview:
// 1. a storage scan (sessionStorage/localStorage entries whose key looks
//    token-related and whose value is JWT-shaped),
// 2. a passive DevTools-protocol capture of Authorization: Bearer headers on
//    the guest's network traffic (covers tokens held only in JS memory),
// then hands every candidate to the main process, which validates them against
// a cheap Graph read and stores the winner. Lift-only today; a future
// PkceTokenProvider replaces this behind the same controller seam.

import registry from '../registry.mjs'

const { ipcRenderer, remote } = window.electronShim

const HARVEST_DEBOUNCE_MS = 5 * 60 * 1000
const TAB_CHECK_DEBOUNCE_MS = 60 * 1000
const CDP_CAPTURE_MS = 15000

// Runs inside the guest page (no Node there): enumerate both storages and
// collect JWT-looking values whose keys look token-related.
const SCAN_CODE = `(function() {
    var results = [];
    var seen = {};
    var keyLike = /(access|auth|token|msal|bearer|graph)/i;
    var jwtPattern = /eyJ[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]*/g;
    var stores = [];
    try { stores.push(window.sessionStorage); } catch (e) {}
    try { stores.push(window.localStorage); } catch (e) {}
    for (var s = 0; s < stores.length && results.length < 50; s++) {
        var storage = stores[s];
        for (var i = 0; i < storage.length && results.length < 50; i++) {
            var key = storage.key(i);
            if (!keyLike.test(key)) { continue; }
            var value = null;
            try { value = storage.getItem(key); } catch (e) { continue; }
            if (typeof value !== 'string' || value.length < 40) { continue; }
            var tokens = value.match(jwtPattern) || [];
            for (var t = 0; t < tokens.length && results.length < 50; t++) {
                if (!seen[tokens[t]]) {
                    seen[tokens[t]] = true;
                    results.push({ key: key, value: tokens[t] });
                }
            }
        }
    }
    return results;
})()`

function captureAuthorizationHeaders(webview, timeoutMs = CDP_CAPTURE_MS) {
    return new Promise((resolve) => {
        let wc
        try {
            wc = remote.webContents.fromId(webview.getWebContentsId())
            wc.debugger.attach('1.3')
        } catch {
            resolve([]) // devtools open or attach refused — the storage scan may suffice
            return
        }

        const tokens = new Set()
        let finished = false

        const finish = () => {
            if (finished) {
                return
            }
            finished = true
            clearTimeout(timer)
            wc.debugger.removeListener('message', onMessage)
            try {
                wc.debugger.detach()
            } catch {}
            resolve([...tokens])
        }

        const onMessage = (event, method, params) => {
            if (method === 'Network.requestWillBeSent') {
                const auth = params?.request?.headers?.Authorization
                if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
                    tokens.add(auth.slice(7))
                    if (tokens.size >= 2) {
                        finish()
                    }
                }
            }
        }

        const timer = setTimeout(finish, timeoutMs)
        wc.debugger.on('message', onMessage)
        try {
            wc.debugger.sendCommand('Network.enable')
        } catch {
            finish()
        }
    })
}

const lastHarvest = new Map()
const lastTabCheck = new Map()

async function harvest({ accountKey: rawKey = 'default', force = false } = {}) {
    const key = rawKey || 'default'

    const last = lastHarvest.get(key) || 0
    if (!force && Date.now() - last < HARVEST_DEBOUNCE_MS) {
        return { valid: false, reason: 'debounced' }
    }
    lastHarvest.set(key, Date.now())

    await registry.wait.domReady()

    const tab =
        registry.tabManager?.tabs.find((t) => (t.account || 'default') === key) ||
        registry.tabManager?.getActiveTab()
    if (!tab?.webview) {
        return { valid: false, reason: 'no-tab' }
    }

    const candidates = []

    // 1. Storage scan
    try {
        const scanned = await tab.webview.executeJavaScript(SCAN_CODE)
        if (Array.isArray(scanned)) {
            for (const entry of scanned) {
                if (entry?.value) {
                    candidates.push(entry.value)
                }
            }
        }
    } catch (error) {
        console.error('[P3X-Search] storage scan failed', error)
    }

    // 2. Passive CDP capture of Authorization headers
    try {
        const captured = await captureAuthorizationHeaders(tab.webview)
        candidates.push(...captured)
    } catch (error) {
        console.error('[P3X-Search] CDP capture failed', error)
    }

    const unique = [...new Set(candidates)].filter(Boolean)
    console.log(`[P3X-Search] harvest for ${key}: ${unique.length} candidates`)
    if (unique.length === 0) {
        return { valid: false, reason: 'no-candidates' }
    }

    // 3. Validate via main (which persists the winner)
    try {
        const result = await ipcRenderer.invoke('p3x-onenote-search-token-validate', {
            accountKey: key,
            candidates: unique,
        })
        console.log(`[P3X-Search] harvest for ${key}: valid=${result.valid}`)
        return result
    } catch {
        return { valid: false, reason: 'validate-failed' }
    }
}

// Hooked from tab-manager's dom-ready: after a tab signs in, make sure a
// validated token exists and kick off the startup sync.
async function onTabReady(tab) {
    if (!tab?.account) {
        return // unsigned tab — nothing to index yet
    }
    const key = tab.account
    const last = lastTabCheck.get(key) || 0
    if (Date.now() - last < TAB_CHECK_DEBOUNCE_MS) {
        return
    }
    lastTabCheck.set(key, Date.now())

    let state
    try {
        state = await ipcRenderer.invoke('p3x-onenote-search-count', { accountKey: key })
    } catch {
        return
    }

    if (state?.authState === 'ok') {
        return
    }

    const result = await harvest({ accountKey: key, force: true })
    if (result.valid) {
        ipcRenderer.invoke('p3x-onenote-search-sync-request', { mode: 'auto', accountKey: key }).catch(() => {})
    }
}

// The indexer hit a 401 mid-sync and asked for a fresh token.
async function onTokenNeeded({ accountKey } = {}) {
    await harvest({ accountKey: accountKey || 'default', force: true })
}

export default { onTabReady, onTokenNeeded, harvest }
