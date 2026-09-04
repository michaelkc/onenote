// The search overlay: a positioned panel over the webview container with two
// views — Search (query box + matching notes) and Index (sync state, notebook
// configuration, per-notebook stats, recent activity, errors). Arrow keys move
// the selection, Enter (or a click) opens the note in the OneNote webapp via
// its deep link (full navigation for now), Esc or a backdrop click closes.
// Indexed content is only ever rendered as text nodes + <mark> elements built
// from parseSnippet segments — never as HTML.

import registry from '../registry.mjs'
import parseSnippet from '../../../lib/search/parse-snippet.mjs'

const { ipcRenderer } = window.electronShim

const lang = (key, fallback) => registry.lang?.search?.[key] ?? fallback

const overlay = () => document.getElementById('p3x-search-overlay')

let built = false
let visible = false
let mode = 'search' // 'search' | 'index'
let accountKey = 'default'
let results = []
let activeIndex = -1
let querySeq = 0
let debounceTimer = null
let lastProgress = null
let statusTimer = null
let indexStatus = null

let inputEl, listEl, emptyEl, statusEl, signinBtn
let searchViewEl, indexViewEl
let tabSearchBtn, tabIndexBtn
let indexStateEl, indexErrorsEl, indexErrorsListEl, indexNotebooksEl, indexActivityEl
let syncNowBtn, indexRebuildBtn

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
                <div class="p3x-search-tabs">
                    <button id="p3x-search-tab-search" class="p3x-tab-btn p3x-tab-active">${registry.lang.search?.title || 'Search'}</button>
                    <button id="p3x-search-tab-index" class="p3x-tab-btn">${lang('tabIndex', 'Index')}</button>
                </div>
                <button id="p3x-search-close" class="p3x-btn" title="${registry.lang.button?.cancel || 'Cancel'}">
                    <i class="fas fa-times"></i>
                </button>
            </div>

            <div id="p3x-search-view">
                <div class="p3x-search-input-row">
                    <input id="p3x-search-input" class="p3x-dialog-input" type="text"
                        placeholder="${lang('placeholder', 'Search notes...')}" autocomplete="off">
                </div>
                <div id="p3x-search-status" class="p3x-search-status"></div>
                <div class="p3x-search-results">
                    <ul class="p3x-search-list"></ul>
                    <div class="p3x-search-empty p3x-hidden"></div>
                </div>
                <div class="p3x-search-footer">
                    <span class="p3x-search-hint">${lang('openHint', 'Arrow keys select · Enter opens · Esc closes')}</span>
                    <span class="p3x-search-footer-actions">
                        <button id="p3x-search-signin" class="p3x-btn p3x-hidden">${lang('signInForSearch', 'Sign in for search')}</button>
                    </span>
                </div>
            </div>

            <div id="p3x-index-view" class="p3x-hidden">
                <div id="p3x-index-state" class="p3x-search-status"></div>
                <div class="p3x-index-scroll">
                    <div id="p3x-index-errors" class="p3x-index-errors p3x-hidden">
                        <div class="p3x-index-section-title">${lang('sectionErrors', 'Recent errors')}</div>
                        <ul id="p3x-index-errors-list" class="p3x-index-activity"></ul>
                    </div>
                    <div class="p3x-index-section-title">${lang('sectionNotebooks', 'Notebooks')}</div>
                    <table class="p3x-index-table">
                        <thead>
                            <tr>
                                <th>${lang('colNotebook', 'Notebook')}</th>
                                <th class="p3x-index-num">${lang('colPages', 'Pages')}</th>
                                <th>${lang('colLastUpdated', 'Last updated')}</th>
                                <th class="p3x-index-num">${lang('colIndex', 'Index')}</th>
                            </tr>
                        </thead>
                        <tbody id="p3x-index-notebooks"></tbody>
                    </table>
                    <div class="p3x-index-section-title">${lang('sectionRecent', 'Recently indexed')}</div>
                    <ul id="p3x-index-activity" class="p3x-index-activity"></ul>
                </div>
                <div class="p3x-search-footer">
                    <span class="p3x-search-hint">${lang('notebookHint', 'Notebook changes apply on the next sync.')}</span>
                    <span class="p3x-search-footer-actions">
                        <button id="p3x-index-sync-now" class="p3x-btn">${lang('syncNow', 'Sync now')}</button>
                        <button id="p3x-index-rebuild" class="p3x-btn">${lang('rebuildIndex', 'Rebuild index')}</button>
                    </span>
                </div>
            </div>
        </div>`

    inputEl = root.querySelector('#p3x-search-input')
    listEl = root.querySelector('.p3x-search-list')
    emptyEl = root.querySelector('.p3x-search-empty')
    statusEl = root.querySelector('#p3x-search-status')
    signinBtn = root.querySelector('#p3x-search-signin')
    searchViewEl = root.querySelector('#p3x-search-view')
    indexViewEl = root.querySelector('#p3x-index-view')
    tabSearchBtn = root.querySelector('#p3x-search-tab-search')
    tabIndexBtn = root.querySelector('#p3x-search-tab-index')
    indexStateEl = root.querySelector('#p3x-index-state')
    indexErrorsEl = root.querySelector('#p3x-index-errors')
    indexErrorsListEl = root.querySelector('#p3x-index-errors-list')
    indexNotebooksEl = root.querySelector('#p3x-index-notebooks')
    indexActivityEl = root.querySelector('#p3x-index-activity')
    syncNowBtn = root.querySelector('#p3x-index-sync-now')
    indexRebuildBtn = root.querySelector('#p3x-index-rebuild')

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
        }
    })

    tabSearchBtn.addEventListener('click', () => setMode('search'))
    tabIndexBtn.addEventListener('click', () => setMode('index'))

    root.querySelector('#p3x-search-close').addEventListener('click', hide)
    root.addEventListener('mousedown', (event) => {
        if (event.target === root) {
            hide()
        }
    })

    signinBtn.addEventListener('click', () => signIn())

    syncNowBtn.addEventListener('click', () => triggerSync('incremental'))
    indexRebuildBtn.addEventListener('click', () => triggerSync('full'))

    // Esc closes from anywhere in the overlay (a native <dialog> open above us
    // keeps its own Esc handling).
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && visible && !document.getElementById('p3x-dialog')?.open) {
            hide()
        }
    })
}

// ── Mode (Search / Index views) ─────────────────────────────────────

function setMode(next) {
    mode = next
    tabSearchBtn.classList.toggle('p3x-tab-active', mode === 'search')
    tabIndexBtn.classList.toggle('p3x-tab-active', mode === 'index')
    searchViewEl.classList.toggle('p3x-hidden', mode !== 'search')
    indexViewEl.classList.toggle('p3x-hidden', mode !== 'index')
    if (mode === 'index') {
        refreshIndexStatus()
    } else {
        inputEl.focus()
    }
}

// ── Visibility ──────────────────────────────────────────────────────

async function show() {
    build()
    visible = true
    overlay().classList.remove('p3x-hidden')
    bindAccount(registry.tabManager?.getActiveTab())
    if (mode === 'search') {
        inputEl.focus()
        inputEl.select()
        refreshStatus()
        if (inputEl.value.trim() !== '') {
            runQuery()
        }
    } else {
        refreshIndexStatus()
    }
}

function showIndex() {
    build()
    visible = true
    overlay().classList.remove('p3x-hidden')
    bindAccount(registry.tabManager?.getActiveTab())
    setMode('index')
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
    indexStatus = null
    renderResults()
    refreshStatus()
    if (mode === 'index') {
        refreshIndexStatus()
    }
}

function onTabSwitched(tab) {
    if (!visible) {
        return
    }
    bindAccount(tab)
}

// ── Search view ─────────────────────────────────────────────────────

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
            if (mode === 'index') {
                await refreshIndexStatus()
            }
        } else {
            setStatus(result?.message || lang('signInFailed', 'Sign-in failed — try again.'))
            showSignInButton(true)
        }
    } catch (error) {
        setStatus((error?.message || '').slice(0, 200) || lang('signInFailed', 'Sign-in failed — try again.'))
        showSignInButton(true)
    }
}

// ── Status (search view) ────────────────────────────────────────────

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

// ── Index view ──────────────────────────────────────────────────────

function formatClock(iso) {
    const date = new Date(iso)
    return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString()
}

async function refreshIndexStatus() {
    try {
        indexStatus = await ipcRenderer.invoke('p3x-onenote-search-status', { accountKey })
    } catch {
        indexStatus = null
    }
    renderIndexStatus()
}

function renderIndexStatus() {
    const s = indexStatus
    if (!s) {
        indexStateEl.textContent = ''
        return
    }

    // State line
    let text = ''
    if (s.syncing) {
        const p = lastProgress || {}
        text = lang('syncing', (a, b) => `Indexing notes... (${a}/${b} sections)`)(p.sectionsDone ?? 0, p.sectionsTotal ?? 0)
        if (p.notesDone) {
            text += ` · ${p.notesDone} ${lang('notesLabel', 'notes')}`
        }
        if (typeof p.calls === 'number') {
            text += ` · ${lang('requestsLabel', (calls) => `${calls} requests (budget 120/min, 400/hr)`)(p.calls)}`
        }
    } else {
        const totalPages = (s.notebooks || []).reduce((sum, nb) => sum + (nb.pages || 0), 0)
        text = `${lang('idleState', 'Idle')} · ${lang('indexedCount', (count) => `Indexed ${count} notes.`)(totalPages)}`
        if (s.lastSyncAt) {
            const time = formatTime(s.lastSyncAt)
            if (time) {
                text += ' ' + lang('lastSync', (t) => `Last updated: ${t}`)(time)
            }
        }
        const stats = s.lastSyncStats
        if (stats && !stats.error) {
            text += ' · ' + lang('syncSummary', (indexed, removed, seconds) => `${indexed} updated, ${removed} removed in ${seconds}s`)(
                stats.indexed ?? 0,
                stats.removed ?? 0,
                Math.round((stats.durationMs ?? 0) / 1000)
            )
            if (typeof stats.calls === 'number') {
                text += ' · ' + lang('requestsLabel', (calls) => `${calls} requests (budget 120/min, 400/hr)`)(stats.calls)
            }
        }
    }
    indexStateEl.textContent = text

    // Errors
    const errors = s.syncErrors || []
    indexErrorsEl.classList.toggle('p3x-hidden', errors.length === 0)
    indexErrorsListEl.innerHTML = ''
    for (const error of errors.slice(-5)) {
        const li = document.createElement('li')
        li.textContent = `${error.context || 'sync'}: ${error.message || ''}`.slice(0, 200)
        indexErrorsListEl.appendChild(li)
    }

    // Notebooks
    indexNotebooksEl.innerHTML = ''
    const notebooks = s.notebooks || []
    if (notebooks.length === 0) {
        const tr = document.createElement('tr')
        const td = document.createElement('td')
        td.colSpan = 4
        td.className = 'p3x-index-empty'
        td.textContent = lang('noNotebooks', 'No notebooks found yet — run a sync to discover them.')
        tr.appendChild(td)
        indexNotebooksEl.appendChild(tr)
    } else {
        for (const notebook of notebooks) {
            const tr = document.createElement('tr')

            const nameTd = document.createElement('td')
            nameTd.textContent = notebook.displayName

            const pagesTd = document.createElement('td')
            pagesTd.className = 'p3x-index-num'
            pagesTd.textContent = String(notebook.pages || 0)

            const updatedTd = document.createElement('td')
            updatedTd.textContent = notebook.lastModifiedDateTime
                ? formatTime(notebook.lastModifiedDateTime)
                : lang('neverSynced', 'Never synced')

            const checkboxTd = document.createElement('td')
            checkboxTd.className = 'p3x-index-num'
            const checkbox = document.createElement('input')
            checkbox.type = 'checkbox'
            checkbox.checked = notebook.enabled
            checkbox.title = lang('colIndex', 'Index')
            checkbox.addEventListener('change', async () => {
                checkbox.disabled = true
                const result = await ipcRenderer.invoke('p3x-onenote-search-set-notebook', {
                    accountKey,
                    notebookId: notebook.id,
                    enabled: checkbox.checked,
                })
                checkbox.disabled = false
                if (result?.ok) {
                    notebook.enabled = checkbox.checked
                    indexStateEl.textContent =
                        lang('notebookChanged', 'Notebook change saved — it applies on the next sync.')
                } else {
                    checkbox.checked = notebook.enabled
                }
            })
            checkboxTd.appendChild(checkbox)

            tr.append(nameTd, pagesTd, updatedTd, checkboxTd)
            indexNotebooksEl.appendChild(tr)
        }
    }

    // Recent activity
    indexActivityEl.innerHTML = ''
    const activity = s.activity || []
    if (activity.length === 0) {
        const li = document.createElement('li')
        li.className = 'p3x-index-empty'
        li.textContent = lang('noActivity', 'Nothing indexed yet in this session.')
        indexActivityEl.appendChild(li)
    } else {
        for (const entry of activity) {
            const li = document.createElement('li')
            const time = formatClock(entry.ts)
            const detail =
                entry.action === 'remove'
                    ? lang('activityRemoved', (title) => `Removed "${title}"`)(entry.title)
                    : lang('activityIndexed', (title, notebook) => `Indexed "${title}" — ${notebook}`)(entry.title, entry.notebookName)
            li.textContent = `${time ? time + ' — ' : ''}${detail}`
            indexActivityEl.appendChild(li)
        }
    }
}

async function triggerSync(syncMode) {
    const result = await ipcRenderer.invoke('p3x-onenote-search-sync-request', {
        mode: syncMode,
        accountKey,
    })
    if (result?.started) {
        indexStateEl.textContent =
            syncMode === 'full'
                ? lang('rebuildStarted', 'Rebuilding the index...')
                : lang('syncing', (a, b) => `Indexing notes... (${a}/${b} sections)`)(0, 0)
    } else if (result?.reason === 'auth') {
        indexStateEl.textContent = lang('signInRequired', 'Index unavailable — sign in to OneNote.')
        showSignInButton(true)
    } else if (result?.reason !== 'queued') {
        indexStateEl.textContent = lang('syncBusy', 'An index sync is already running.')
    }
}

// ── Events from the main process ────────────────────────────────────

function onSyncDone(data) {
    const stats = data?.stats
    if (!visible) {
        // Toast only when the overlay is closed — the status lines carry it otherwise
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
    if (mode === 'index') {
        refreshIndexStatus()
    }
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
            if (mode === 'search') {
                setStatus(lang('syncing', (a, b) => `Indexing notes... (${a}/${b} sections)`)(0, 0))
            } else {
                renderIndexStatus()
            }
            break

        case 'sync-progress':
            lastProgress = data
            if (mode === 'search') {
                setStatus(
                    lang('syncing', (a, b) => `Indexing notes... (${a}/${b} sections)`)(data.sectionsDone ?? 0, data.sectionsTotal ?? 0)
                )
            } else {
                renderIndexStatus()
            }
            break

        case 'sync-retrying':
            if (mode === 'search') {
                setStatus(lang('retrying', (a, b) => `Rate limited — retrying (${a}/${b})...`)(data.attempt, data.maxAttempts))
            }
            break

        case 'sync-error':
            if (mode === 'search') {
                setStatus(`${data.context || 'sync'}: ${data.message || ''}`.slice(0, 200))
            } else {
                refreshIndexStatus()
            }
            break

        case 'token-needed':
            if (mode === 'search') {
                setStatus(lang('harvestingToken', 'Signing in to search...'))
            }
            break

        case 'sign-in-needed':
            if (mode === 'search') {
                setStatus(lang('signInRequired', 'Index unavailable — sign in to OneNote.'))
                showSignInButton(true)
            }
            break

        case 'sync-done':
            onSyncDone(data)
            break
    }
}

export default { toggle, show, showIndex, hide, onTabSwitched, onEvent, signIn }
