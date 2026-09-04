// The search overlay: a positioned panel over the webview container with a
// search box and the list of notes matching the query. Arrow keys move the
// selection, Enter (or a click) opens the note in the OneNote webapp via its
// deep link (full navigation for now), Esc or a backdrop click closes.
// Indexed content is only ever rendered as text nodes + <mark> elements built
// from parseSnippet segments — never as HTML.

import registry from '../registry.mjs'
import parseSnippet from '../../../lib/search/parse-snippet.mjs'

const { ipcRenderer } = window.electronShim

const lang = (key, fallback) => registry.lang?.search?.[key] ?? fallback

const overlay = () => document.getElementById('p3x-search-overlay')

let built = false
let visible = false
let accountKey = 'default'
let results = []
let activeIndex = -1
let querySeq = 0
let debounceTimer = null
let lastProgress = null
let statusTimer = null

let inputEl, listEl, emptyEl, statusEl, rebuildBtn, signinBtn

// ── DOM ─────────────────────────────────────────────────────────────

function build() {
    if (built) {
        return
    }
    built = true

    const root = overlay()
    root.innerHTML = `
        <div class="p3x-search-panel">
            <div class="p3x-search-header">
                <input id="p3x-search-input" class="p3x-dialog-input" type="text"
                    placeholder="${lang('placeholder', 'Search notes...')}" autocomplete="off">
                <button id="p3x-search-close" class="p3x-btn" title="${registry.lang.button?.cancel || 'Cancel'}">
                    <i class="fas fa-times"></i>
                </button>
            </div>
            <div id="p3x-search-status" class="p3x-search-status"></div>
            <div id="p3x-search-results" class="p3x-search-results">
                <ul class="p3x-search-list"></ul>
                <div class="p3x-search-empty p3x-hidden"></div>
            </div>
            <div class="p3x-search-footer">
                <span class="p3x-search-hint">${lang('openHint', 'Arrow keys select · Enter opens · Esc closes')}</span>
                <span class="p3x-search-footer-actions">
                    <button id="p3x-search-signin" class="p3x-btn p3x-hidden">${lang('signInForSearch', 'Sign in for search')}</button>
                    <button id="p3x-search-rebuild" class="p3x-btn">${lang('rebuildIndex', 'Rebuild index')}</button>
                </span>
            </div>
        </div>`

    inputEl = root.querySelector('#p3x-search-input')
    listEl = root.querySelector('.p3x-search-list')
    emptyEl = root.querySelector('.p3x-search-empty')
    statusEl = root.querySelector('#p3x-search-status')
    rebuildBtn = root.querySelector('#p3x-search-rebuild')
    signinBtn = root.querySelector('#p3x-search-signin')

    inputEl.addEventListener('input', () => {
        clearTimeout(debounceTimer)
        debounceTimer = setTimeout(runQuery, 250)
    })

    inputEl.addEventListener('keydown', (event) => {
        if (event.key === 'ArrowDown') {
            event.preventDefault()
            moveSelection(1)
        } else if (event.key === 'ArrowUp') {
            event.preventDefault()
            moveSelection(-1)
        } else if (event.key === 'Enter') {
            event.preventDefault()
            openItem(activeIndex >= 0 ? activeIndex : 0)
        } else if (event.key === 'Escape') {
            event.preventDefault()
            hide()
        }
    })

    root.querySelector('#p3x-search-close').addEventListener('click', hide)
    root.addEventListener('mousedown', (event) => {
        if (event.target === root) {
            hide()
        }
    })

    rebuildBtn.addEventListener('click', async () => {
        const result = await ipcRenderer.invoke('p3x-onenote-search-sync-request', {
            mode: 'full',
            accountKey,
        })
        if (result?.started) {
            setStatus(lang('rebuildStarted', 'Rebuilding the index...'))
        } else if (result?.reason === 'auth') {
            setStatus(lang('signInRequired', 'Index unavailable — sign in to OneNote.'))
            showSignInButton(true)
        } else {
            setStatus(lang('syncBusy', 'An index sync is already running.'))
        }
    })

    signinBtn.addEventListener('click', () => signIn())
}

// ── Interactive sign-in (PKCE) ──────────────────────────────────────

function showSignInButton(show) {
    signinBtn.classList.toggle('p3x-hidden', !show)
}

async function signIn() {
    showSignInButton(false)
    setStatus(lang('signInOpened', 'A browser window opened — sign in and come back here.'))
    try {
        const result = await ipcRenderer.invoke('p3x-onenote-search-signin', { accountKey })
        if (result?.success) {
            await refreshStatus()
        } else {
            setStatus(result?.message || lang('signInFailed', 'Sign-in failed — try again.'))
            showSignInButton(true)
        }
    } catch (error) {
        setStatus((error?.message || '').slice(0, 200) || lang('signInFailed', 'Sign-in failed — try again.'))
        showSignInButton(true)
    }
}

// ── Visibility ──────────────────────────────────────────────────────

async function show() {
    build()
    visible = true
    overlay().classList.remove('p3x-hidden')
    bindAccount(registry.tabManager?.getActiveTab())
    inputEl.focus()
    inputEl.select()
    refreshStatus()
    if (inputEl.value.trim() !== '') {
        runQuery()
    }
}

function hide() {
    visible = false
    overlay().classList.add('p3x-hidden')
    registry.tabManager?.getActiveWebview()?.focus()
}

function toggle() {
    if (visible) {
        hide()
    } else {
        show()
    }
}

// ── Account binding ─────────────────────────────────────────────────

function bindAccount(tab) {
    const key = (tab?.account || 'default').trim().toLowerCase() || 'default'
    if (key === accountKey) {
        return
    }
    accountKey = key
    results = []
    activeIndex = -1
    inputEl.value = ''
    lastProgress = null
    renderResults()
    refreshStatus()
}

function onTabSwitched(tab) {
    if (!visible) {
        return
    }
    bindAccount(tab)
}

// ── Queries ─────────────────────────────────────────────────────────

async function runQuery() {
    const query = inputEl.value.trim()

    if (query === '') {
        results = []
        activeIndex = -1
        renderResults()
        refreshStatus()
        return
    }

    if (query.length < 2) {
        results = []
        activeIndex = -1
        renderResults(lang('typeMore', 'Type at least 2 characters.'))
        return
    }

    const seq = ++querySeq
    try {
        const { results: found } = await ipcRenderer.invoke('p3x-onenote-search-query', {
            query,
            accountKey,
        })
        if (seq !== querySeq) {
            return // stale response — a newer query is in flight
        }
        results = found
        activeIndex = -1
        renderResults()
    } catch {
        renderResults(lang('searchFailed', 'Search failed — try again.'))
    }
}

function renderResults(emptyMessage) {
    listEl.innerHTML = ''
    if (emptyMessage) {
        emptyEl.textContent = emptyMessage
        emptyEl.classList.remove('p3x-hidden')
        return
    }
    emptyEl.classList.add('p3x-hidden')

    if (results.length === 0) {
        emptyEl.textContent = lang('noResults', 'No matching notes.')
        emptyEl.classList.remove('p3x-hidden')
        return
    }

    results.forEach((item, index) => {
        const li = document.createElement('li')
        li.className = 'p3x-search-item'
        li.tabIndex = -1
        li.dataset.index = String(index)
        li.dataset.webUrl = item.webUrl || ''

        const title = document.createElement('div')
        title.className = 'p3x-search-item-title'
        title.textContent = item.title || 'Untitled'

        const snippet = document.createElement('div')
        snippet.className = 'p3x-search-item-snippet'
        for (const segment of parseSnippet(item.snippet)) {
            if (segment.mark) {
                const mark = document.createElement('mark')
                mark.textContent = segment.text
                snippet.appendChild(mark)
            } else {
                snippet.appendChild(document.createTextNode(segment.text))
            }
        }

        const context = document.createElement('div')
        context.className = 'p3x-search-item-context'
        context.textContent = [item.notebookName, item.sectionName].filter(Boolean).join(' › ')

        li.append(title, snippet, context)
        li.addEventListener('click', () => openItem(index))
        listEl.appendChild(li)
    })
}

// ── Selection & opening ─────────────────────────────────────────────

function moveSelection(delta) {
    const items = listEl.querySelectorAll('.p3x-search-item')
    if (items.length === 0) {
        return
    }
    let next = activeIndex + delta
    if (next < 0) {
        next = 0
    }
    if (next >= items.length) {
        next = items.length - 1
    }
    setActive(next)
}

function setActive(index) {
    const items = listEl.querySelectorAll('.p3x-search-item')
    items.forEach((el, i) => el.classList.toggle('p3x-search-item-active', i === index))
    activeIndex = index
    if (index >= 0) {
        items[index].scrollIntoView({ block: 'nearest' })
    }
}

function openItem(index) {
    const item = results[index]
    if (!item?.webUrl) {
        return
    }
    hide()
    // Full navigation for now — the webapp resolves the deep link and the
    // existing did-navigate handler updates the tab's URL/location bar.
    const webview = registry.tabManager?.getActiveWebview()
    if (webview) {
        webview.src = item.webUrl
    }
}

// ── Status ──────────────────────────────────────────────────────────

function setStatus(text) {
    clearTimeout(statusTimer)
    statusEl.textContent = text
}

function formatTime(iso) {
    const date = new Date(iso)
    return Number.isNaN(date.getTime()) ? '' : date.toLocaleString()
}

async function refreshStatus() {
    let state
    try {
        state = await ipcRenderer.invoke('p3x-onenote-search-count', { accountKey })
    } catch {
        return
    }

    if (state.authState !== 'ok') {
        // Search works on the local index regardless; kick a background
        // harvest (debounced internally) so future syncs can run.
        registry.searchHarvest?.harvest({ accountKey, force: state.authState === 'missing' })
    }

    let text = ''
    if (state.syncing) {
        const p = lastProgress || {}
        text = lang('syncing', (a, b) => `Indexing notes... (${a}/${b} sections)`)(p.sectionsDone ?? 0, p.sectionsTotal ?? 0)
    } else if (state.count > 0) {
        text = lang('indexedCount', (count) => `Indexed ${count} notes.`)(state.count)
        if (state.lastSyncAt) {
            const time = formatTime(state.lastSyncAt)
            if (time) {
                text += ' ' + lang('lastSync', (t) => `Last updated: ${t}`)(time)
            }
        }
    } else if (state.authState === 'missing') {
        text = lang('signInRequired', 'Index unavailable — sign in to OneNote.')
    } else {
        text = lang('indexEmpty', 'No notes indexed yet. The index builds in the background after sign-in.')
    }
    setStatus(text)

    // The interactive sign-in path replaces a failed webview harvest.
    showSignInButton(state.authState !== 'ok' && !state.syncing)
}

function onSyncDone(data) {
    const stats = data?.stats
    if (!visible) {
        // Toast only when the overlay is closed — the status line carries it otherwise
        if (stats?.error) {
            if (stats.error.code !== 'auth') {
                registry.toast.action({
                    message: lang('syncFailed', 'Indexing failed.'),
                    duration: 8000,
                })
            }
        } else {
            registry.toast.action({ message: lang('syncDone', (count) => `Indexed ${count} notes.`)(stats.indexed ?? 0) })
        }
    }
    refreshStatus()
}

function onEvent(data) {
    if (!data || !built) {
        return
    }

    // Only react to events for the bound account (or overlay-wide auth events)
    if (data.accountKey && data.accountKey !== accountKey && data.type !== 'token-needed') {
        return
    }

    switch (data.type) {
        case 'sync-started':
            lastProgress = null
            setStatus(lang('syncing', (a, b) => `Indexing notes... (${a}/${b} sections)`)(0, 0))
            break

        case 'sync-progress':
            lastProgress = data
            setStatus(
                lang('syncing', (a, b) => `Indexing notes... (${a}/${b} sections)`)(data.sectionsDone ?? 0, data.sectionsTotal ?? 0)
            )
            break

        case 'sync-retrying':
            setStatus(lang('retrying', (a, b) => `Rate limited — retrying (${a}/${b})...`)(data.attempt, data.maxAttempts))
            break

        case 'sync-error':
            setStatus(`${data.context || 'sync'}: ${data.message || ''}`.slice(0, 200))
            break

        case 'token-needed':
            setStatus(lang('harvestingToken', 'Signing in to search...'))
            break

        case 'sign-in-needed':
            setStatus(lang('signInRequired', 'Index unavailable — sign in to OneNote.'))
            showSignInButton(true)
            break

        case 'sync-done':
            onSyncDone(data)
            break
    }
}

export default { toggle, show, hide, onTabSwitched, onEvent, signIn }
