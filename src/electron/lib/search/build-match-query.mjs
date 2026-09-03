// Turn a free-form user query into a safe FTS5 MATCH expression: each
// alphanumeric run is quoted (so punctuation can't break the query grammar)
// and joined with AND, with a prefix operator on the final term for
// search-as-you-type. Returns '' for a blank query.
// Port of SqliteLocalStore.BuildMatchQuery (dotnetonenoteindexer).

export default function buildMatchQuery(query) {
    if (typeof query !== 'string' || query.trim() === '') {
        return ''
    }

    const terms = query
        .split(/[^\p{L}\p{N}]+/u)
        .filter((term) => term.length > 0)
        .map((term) => `"${term.replace(/"/g, '""')}"`)

    if (terms.length === 0) {
        return ''
    }

    terms[terms.length - 1] += '*'
    return terms.join(' AND ')
}
