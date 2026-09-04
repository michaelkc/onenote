import { describe, it, expect } from 'vitest'
import {
    buildAuthorizeUrl,
    parseRedirect,
    StateMismatchError,
    AUTHORITY,
} from '../src/electron/lib/search/oauth-redirect.mjs'

describe('buildAuthorizeUrl', () => {
    it('builds the authorize URL with all parameters escaped', () => {
        const url = buildAuthorizeUrl({
            clientId: 'abc-123',
            redirectUri: 'http://localhost:54321/',
            scopes: 'Notes.Read offline_access',
            state: 'st8',
            codeChallenge: 'chall==',
        })
        const parsed = new URL(url)
        expect(parsed.origin + parsed.pathname).toBe(AUTHORITY + '/authorize')
        expect(parsed.searchParams.get('client_id')).toBe('abc-123')
        expect(parsed.searchParams.get('response_type')).toBe('code')
        expect(parsed.searchParams.get('redirect_uri')).toBe('http://localhost:54321/')
        expect(parsed.searchParams.get('scope')).toBe('Notes.Read offline_access')
        expect(parsed.searchParams.get('response_mode')).toBe('query')
        expect(parsed.searchParams.get('state')).toBe('st8')
        expect(parsed.searchParams.get('code_challenge')).toBe('chall==')
        expect(parsed.searchParams.get('code_challenge_method')).toBe('S256')
    })
})

describe('parseRedirect', () => {
    const base = 'http://localhost:54321/'

    it('returns the code when state matches', () => {
        expect(parseRedirect(`${base}?code=c123&state=st8`, 'st8')).toEqual({ code: 'c123' })
    })

    it('returns the error when state matches', () => {
        expect(parseRedirect(`${base}?error=access_denied&error_description=nope&state=st8`, 'st8')).toEqual({
            error: 'access_denied',
            errorDescription: 'nope',
        })
    })

    it('throws on state mismatch', () => {
        expect(() => parseRedirect(`${base}?code=c123&state=other`, 'st8')).toThrow(StateMismatchError)
    })

    it('throws when neither code nor error is present', () => {
        expect(() => parseRedirect(`${base}?state=st8`, 'st8')).toThrow(/neither a code nor an error/)
    })
})
