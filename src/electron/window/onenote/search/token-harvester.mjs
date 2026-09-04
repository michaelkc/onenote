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

    // 1. Storage scan — top frame plus every subframe (auth iframes can hold
    //    their own storage where the top frame's scan sees nothing)
    const collectScan = (scanned) => {
        if (!Array.isArray(scanned)) {
            return
        }
        for (const entry of scanned) {
            if (entry?.value) {
                candidates.push(entry.value)
            }
        }
    }
    try {
        collectScan(await tab.webview.executeJavaScript(SCAN_CODE))
    } catch (error) {
        console.error('[P3X-Search] top-frame storage scan failed', error)
    }
    try {
        const wc = remote.webContents.fromId(tab.webview.getWebContentsId())
        for (const frame of wc.mainFrame.framesInSubtree) {
            try {
                collectScan(await frame.executeJavaScript(SCAN_CODE))
            } catch {}
        }
    } catch (error) {
        console.error('[P3X-Search] subframe storage scan failed', error)
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
        // Renderer console output does not reach the terminal — mirror the
        // outcome to the main-process log via the existing debug channel.
        ipcRenderer.send('p3x-debug', {
            '[P3X-Search] harvest': `0 candidates for ${key} — nothing token-like in webview storage, and no bearer headers seen on network traffic`,
        })
        return { valid: false, reason: 'no-candidates' }
    }

    // 3. Validate via main (which persists the winner and logs the outcome)
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

// Make sure a validated token exists for the given tab's account (or the
// shared 'default' key while the account email is not yet extracted) and kick
// off the startup sync. Debounced per account — safe to call on every
// navigation/dom-ready.
async function ensureTokenForTab(tab) {
    if (!tab?.domReady) {
        return
    }
    const key = (tab.account || 'default').trim().toLowerCase() || 'default'
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

// Hooked from tab-manager's dom-ready and did-navigate handlers.
async function onTabReady(tab) {
    await ensureTokenForTab(tab)
}

// The indexer hit a 401 mid-sync and asked for a fresh token. The webview
// harvest is the cheap first attempt; when it fails, surface the interactive
// sign-in instead of silently stalling the sync.
async function onTokenNeeded({ accountKey } = {}) {
    const result = await harvest({ accountKey: accountKey || 'default', force: true })
    if (!result.valid) {
        ipcRenderer.send('p3x-debug', {
            '[P3X-Search] harvest': 'webview harvest failed — offering the interactive sign-in',
        })
        registry.searchOverlay?.onEvent({ type: 'sign-in-needed' })
    }
}

// Safety net: signing in after startup can easily miss the dom-ready/navigate
// triggers (or the webapp may not have made its API calls during the first
// capture window). Re-check the active tab periodically until a token sticks.
setInterval(() => {
    const tab = registry.tabManager?.getActiveTab()
    if (!tab) {
        return
    }
    ensureTokenForTab(tab).catch(() => {})
}, 5 * 60 * 1000)

export default { onTabReady, onTokenNeeded, harvest }
