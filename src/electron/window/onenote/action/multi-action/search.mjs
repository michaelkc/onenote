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

        case 'search-signin':
            registry.searchOverlay?.show()
            registry.searchOverlay?.signIn()
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
            registry.searchOverlay?.showIndex()
            break
        }
    }
}
