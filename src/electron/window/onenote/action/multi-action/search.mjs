// Menu-initiated search actions: toggle the overlay, force a full index
// rebuild, or toast the current index status.

import registry from '../../registry.mjs'

const { ipcRenderer } = window.electronShim

const lang = (key, fallback) => registry.lang?.search?.[key] ?? fallback

function activeAccountKey() {
    const tab = registry.tabManager?.getActiveTab()
    return (tab?.account || 'default').trim().toLowerCase() || 'default'
}

export default async (data) => {
    switch (data.action) {
        case 'search-notes':
            registry.searchOverlay?.toggle()
            break

        case 'search-rebuild-index': {
            const result = await ipcRenderer.invoke('p3x-onenote-search-sync-request', {
                mode: 'full',
                accountKey: activeAccountKey(),
            })
            if (result?.started) {
                registry.toast.action({ message: lang('rebuildStarted', 'Rebuilding the index...') })
            } else if (result?.reason === 'auth') {
                registry.toast.action({ message: lang('signInRequired', 'Index unavailable — sign in to OneNote.') })
            } else if (result?.reason !== 'queued') {
                registry.toast.action({ message: lang('syncBusy', 'An index sync is already running.') })
            }
            break
        }

        case 'search-index-status': {
            const state = await ipcRenderer.invoke('p3x-onenote-search-count', {
                accountKey: activeAccountKey(),
            })
            let message
            if (state.count > 0) {
                message = lang('indexedCount', (count) => `Indexed ${count} notes.`)(state.count)
                if (state.lastSyncAt) {
                    const time = new Date(state.lastSyncAt).toLocaleString()
                    message += ' ' + lang('lastSync', (t) => `Last updated: ${t}`)(time)
                }
            } else {
                message = lang('indexEmpty', 'No notes indexed yet. The index builds in the background after sign-in.')
            }
            registry.toast.action({ message })
            break
        }
    }
}
