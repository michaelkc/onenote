// The OneNote Graph API accessor behind the search index: the notebook
// hierarchy walk, a section's notes (with their web deep links), and the
// extracted plain text of a page. Reads are retried on transient failures with
// linear backoff; a 401 propagates so the caller's re-auth recovery takes over
// (silently skipping it would leave a stale index).
// Port of OneNoteApiClient (dotnetonenoteindexer), plus @odata.nextLink
// pagination of the pages listing.

import htmlToPlainText from '../lib/search/html-to-plain-text.mjs'

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0/me/onenote'
const MAX_RETRIES = 3
const BASE_RETRY_DELAY_MS = 1000
const ATTEMPT_TIMEOUT_MS = 30000
const MAX_PAGES = 50

function parseErrorCode(body) {
    try {
        const parsed = JSON.parse(body)
        return typeof parsed?.error?.code === 'string' ? parsed.error.code : null
    } catch {
        return null
    }
}

export class GraphApiError extends Error {
    constructor(statusCode, body) {
        super(`OneNote API returned HTTP ${statusCode}: ${body}`)
        this.statusCode = statusCode
        this.code = parseErrorCode(body)
        this.body = body
    }
}

function isTransient(statusCode) {
    return statusCode === 429 || (statusCode >= 500 && statusCode <= 599)
}

function sleep(ms, ct) {
    return new Promise((resolve, reject) => {
        if (ct?.aborted) {
            reject(ct.reason ?? new Error('Aborted'))
            return
        }
        const timer = setTimeout(resolve, ms)
        ct?.addEventListener(
            'abort',
            () => {
                clearTimeout(timer)
                reject(ct.reason ?? new Error('Aborted'))
            },
            { once: true }
        )
    })
}

export default function createOneNoteApiClient({ getAccessToken, events = {}, fetchImpl }) {
    const fetchFn = fetchImpl ?? globalThis.fetch

    async function getJson(url, ct) {
        for (let attempt = 0; ; attempt++) {
            // A per-attempt timeout turns a wedged connection into a transient
            // failure the retry loop can handle, rather than an unbounded hang.
            const attemptTimeout = new AbortController()
            const onAbort = () => attemptTimeout.abort()
            ct?.addEventListener('abort', onAbort, { once: true })
            const timer = setTimeout(() => attemptTimeout.abort(), ATTEMPT_TIMEOUT_MS)

            try {
                const response = await fetchFn(url, {
                    headers: { Authorization: `Bearer ${await getAccessToken()}` },
                    signal: attemptTimeout.signal,
                })
                const body = await response.text()

                if (response.ok) {
                    return JSON.parse(body)
                }

                if (!isTransient(response.status) || attempt >= MAX_RETRIES) {
                    throw new GraphApiError(response.status, body)
                }

                events.retrying?.(attempt + 1, MAX_RETRIES)
                await sleep(BASE_RETRY_DELAY_MS * (attempt + 1), ct)
            } finally {
                clearTimeout(timer)
                ct?.removeEventListener('abort', onAbort)
            }
        }
    }

    async function getContentHtml(url, ct) {
        for (let attempt = 0; ; attempt++) {
            const attemptTimeout = new AbortController()
            const onAbort = () => attemptTimeout.abort()
            ct?.addEventListener('abort', onAbort, { once: true })
            const timer = setTimeout(() => attemptTimeout.abort(), ATTEMPT_TIMEOUT_MS)

            try {
                const response = await fetchFn(url, {
                    headers: { Authorization: `Bearer ${await getAccessToken()}` },
                    signal: attemptTimeout.signal,
                })
                const html = await response.text()

                if (response.ok) {
                    return html
                }

                if (!isTransient(response.status) || attempt >= MAX_RETRIES) {
                    throw new GraphApiError(response.status, html)
                }

                events.retrying?.(attempt + 1, MAX_RETRIES)
                await sleep(BASE_RETRY_DELAY_MS * (attempt + 1), ct)
            } finally {
                clearTimeout(timer)
                ct?.removeEventListener('abort', onAbort)
            }
        }
    }

    function parseSections(parent, prop) {
        const arr = parent[prop]
        if (!Array.isArray(arr)) {
            return []
        }
        return arr.map((sec) => ({
            id: sec.id ?? '',
            displayName: sec.displayName ?? 'Untitled',
        }))
    }

    function parseSectionGroups(parent, prop, ct) {
        const arr = parent[prop]
        if (!Array.isArray(arr)) {
            return []
        }
        return arr.map((group) => {
            ct?.throwIfAborted?.()
            return {
                id: group.id ?? '',
                displayName: group.displayName ?? 'Untitled',
                sectionGroups: parseSectionGroups(group, 'sectionGroups', ct),
                sections: parseSections(group, 'sections'),
            }
        })
    }

    function parseNotebooks(doc, ct) {
        const value = doc.value
        if (!Array.isArray(value)) {
            return []
        }
        return value.map((nb) => {
            ct?.throwIfAborted?.()
            return {
                id: nb.id ?? '',
                displayName: nb.displayName ?? 'Untitled',
                sectionGroups: parseSectionGroups(nb, 'sectionGroups', ct),
                sections: parseSections(nb, 'sections'),
            }
        })
    }

    function parseNote(el, sectionId) {
        return {
            id: el.id ?? '',
            title: el.title ?? 'Untitled',
            sectionId,
            lastModifiedDateTime: el.lastModifiedDateTime ?? null,
            webUrl: el.links?.oneNoteWebUrl?.href ?? null,
        }
    }

    return {
        async getNotebooks(ct) {
            const url =
                GRAPH_BASE + '/notebooks?$expand=sections,sectionGroups($expand=sections,sectionGroups)'
            const doc = await getJson(url, ct)
            return parseNotebooks(doc, ct)
        },

        async getNotes(sectionId, ct) {
            const notes = []
            let url = `${GRAPH_BASE}/sections/${encodeURIComponent(sectionId)}/pages`
            for (let page = 0; url && page < MAX_PAGES; page++) {
                const doc = await getJson(url, ct)
                for (const el of doc.value ?? []) {
                    notes.push(parseNote(el, sectionId))
                }
                url = doc['@odata.nextLink'] ?? null
            }
            return notes
        },

        async getNoteContent(noteId, ct) {
            const url = `${GRAPH_BASE}/pages/${encodeURIComponent(noteId)}/content`
            return htmlToPlainText(await getContentHtml(url, ct))
        },
    }
}
