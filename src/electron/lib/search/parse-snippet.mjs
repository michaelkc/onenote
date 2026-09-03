// Split SQLite snippet() output into text/mark segments. The store asks FTS5
// for the special marks char(1)/char(2) instead of HTML tags, so indexed note
// content can never smuggle markup into the overlay — the renderer builds DOM
// with textContent and <mark> elements from these segments.

export const SNIPPET_MARK_OPEN = ''
export const SNIPPET_MARK_CLOSE = ''

export default function parseSnippet(snippet) {
    if (typeof snippet !== 'string' || snippet === '') {
        return []
    }

    const segments = []
    const pattern = /[]/g
    let lastIndex = 0
    let open = false
    let match

    while ((match = pattern.exec(snippet)) !== null) {
        const text = snippet.slice(lastIndex, match.index)
        if (text !== '') {
            segments.push({ text, mark: open })
        }
        open = match[0] === SNIPPET_MARK_OPEN
        lastIndex = match.index + 1
    }

    const tail = snippet.slice(lastIndex)
    if (tail !== '') {
        segments.push({ text: tail, mark: open })
    }

    return segments
}
