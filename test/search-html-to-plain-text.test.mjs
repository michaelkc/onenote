import { describe, it, expect } from 'vitest'
import htmlToPlainText from '../src/electron/lib/search/html-to-plain-text.mjs'

describe('htmlToPlainText', () => {
    it('returns empty for blank input', () => {
        expect(htmlToPlainText('')).toBe('')
        expect(htmlToPlainText('   \n\t ')).toBe('')
        expect(htmlToPlainText(null)).toBe('')
        expect(htmlToPlainText(undefined)).toBe('')
    })

    it('strips tags and keeps visible text', () => {
        expect(htmlToPlainText('<html><body><p>Hello <b>world</b></p></body></html>')).toBe('Hello world')
    })

    it('removes script and style blocks entirely', () => {
        const html = '<style>.x { color: red }</style><script>alert(1)</script><p>Keep me</p>'
        expect(htmlToPlainText(html)).toBe('Keep me')
    })

    it('removes multiline script blocks', () => {
        const html = '<p>before</p><script>\nvar x = "<div>not content</div>";\n</script><p>after</p>'
        expect(htmlToPlainText(html)).toBe('before after')
    })

    it('decodes HTML entities', () => {
        expect(htmlToPlainText('a &amp; b &lt;tag&gt; &quot;q&quot; &#39;s&#39; &nbsp; x')).toBe("a & b <tag> \"q\" 's' x")
    })

    it('decodes numeric entities', () => {
        expect(htmlToPlainText('&#65; &#x42;')).toBe('A B')
    })

    it('collapses whitespace runs and trims', () => {
        expect(htmlToPlainText('<p>a\n\n   b\t\tc</p>')).toBe('a b c')
    })

    it('preserves unicode (CJK, accents)', () => {
        expect(htmlToPlainText('<p>café 東京 你好</p>')).toBe('café 東京 你好')
    })
})
