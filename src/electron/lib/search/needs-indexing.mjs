// Decide whether a live note needs (re-)extraction into the search index.
// Port of SearchService.NeedsIndexing (dotnetonenoteindexer): refresh when the
// note is new, moved between sections, or carries no trustworthy timestamp;
// otherwise only when its lastModifiedDateTime advanced past the indexed value.
// Timestamps may be ISO 8601 strings (as the Graph API returns and the store
// keeps them) or epoch millis — both convert through Date.

function toMs(value) {
    if (value === null || value === undefined) {
        return null
    }
    const ms = new Date(value).getTime()
    return Number.isNaN(ms) ? null : ms
}

export default function needsIndexing(live, indexed) {
    if (indexed === null || indexed === undefined) {
        return true
    }

    if (live.sectionId !== indexed.sectionId) {
        return true // moved between sections: refresh identity + content
    }

    const liveMs = toMs(live.lastModifiedDateTime)
    if (liveMs === null) {
        // No timestamp means there is no evidence the note is unchanged;
        // refresh so a later edit never sits silently stale in the index.
        return true
    }

    const indexedMs = toMs(indexed.lastModifiedDateTime)
    if (indexedMs === null) {
        return true
    }

    return liveMs > indexedMs
}
