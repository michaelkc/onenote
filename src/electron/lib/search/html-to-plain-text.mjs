// Reduce OneNote page HTML to searchable plain text: drop script/style blocks
// and tags, decode HTML entities, and collapse runs of whitespace. A pure,
// best-effort transform — not a full DOM parser; good enough for content
// indexing. Port of OneNoteApiClient.HtmlToPlainText (dotnetonenoteindexer).

const ENTITIES = {
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&apos;': "'",
    '&#39;': "'",
    '&nbsp;': ' ',
}

function codePointFrom(value) {
    try {
        return String.fromCodePoint(value)
    } catch {
        return '�'
    }
}

function decodeHtmlEntities(text) {
    return text
        .replace(/&#x([0-9a-f]+);/gi, (_, hex) => codePointFrom(parseInt(hex, 16)))
        .replace(/&#(\d+);/g, (_, dec) => codePointFrom(parseInt(dec, 10)))
        .replace(/&[a-z]+;/gi, (entity) => ENTITIES[entity.toLowerCase()] ?? entity)
}

export default function htmlToPlainText(html) {
    if (html === null || html === undefined || html.trim() === '') {
        return ''
    }

    let text = html
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')

    text = decodeHtmlEntities(text)
    return text.replace(/\s+/g, ' ').trim()
}
