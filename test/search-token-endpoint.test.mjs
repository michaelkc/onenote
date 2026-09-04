import { describe, it, expect } from 'vitest'
import {
    parseTokenResponse,
    parseTokenError,
    exchangeCode,
    refreshAccessToken,
    TokenEndpointError,
} from '../src/electron/lib/search/token-endpoint.mjs'

const jwtWithExp = (exp) => {
    const enc = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url')
    return `${enc({ alg: 'none' })}.${enc({ exp })}.sig`
}

function fakeFetch(responseBody, status = 200) {
    const calls = []
    const fetchImpl = async (url, options) => {
        calls.push({ url, options })
        return {
            ok: status >= 200 && status < 300,
            status,
            text: async () => responseBody,
        }
    }
    return { fetchImpl, calls }
}

describe('parseTokenResponse', () => {
    it('parses a token response preferring the JWT exp claim', () => {
        const exp = 1735689600
        const parsed = parseTokenResponse(
            JSON.stringify({ access_token: jwtWithExp(exp), refresh_token: 'r1', expires_in: '3600' })
        )
        expect(parsed.accessToken).toBe(jwtWithExp(exp))
        expect(parsed.refreshToken).toBe('r1')
        expect(parsed.expiresOn).toBe(exp * 1000)
    })

    it('falls back to expires_in seconds when exp is unreadable', () => {
        const before = Date.now()
        const parsed = parseTokenResponse(JSON.stringify({ access_token: 'not-a-jwt', expires_in: 3600 }))
        expect(parsed.refreshToken).toBe(null)
        expect(parsed.expiresOn).toBeGreaterThanOrEqual(before + 3599 * 1000)
    })

    it('throws when there is no access token', () => {
        expect(() => parseTokenResponse(JSON.stringify({ refresh_token: 'r1' }))).toThrow(TokenEndpointError)
        expect(() => parseTokenResponse('not json')).toThrow(TokenEndpointError)
    })
})

describe('parseTokenError', () => {
    it('extracts error fields', () => {
        expect(parseTokenError(JSON.stringify({ error: 'invalid_grant', error_description: 'bad' }))).toEqual({
            error: 'invalid_grant',
            errorDescription: 'bad',
        })
    })

    it('tolerates non-JSON bodies', () => {
        expect(parseTokenError('<html>')).toEqual({ error: null, errorDescription: null })
    })
})

describe('exchangeCode / refreshAccessToken', () => {
    it('posts the authorization-code grant', async () => {
        const token = jwtWithExp(1735689600)
        const { fetchImpl, calls } = fakeFetch(JSON.stringify({ access_token: token }))
        const bundle = await exchangeCode({
            code: 'c1',
            codeVerifier: 'v1',
            clientId: 'cid',
            redirectUri: 'http://localhost:1/',
            fetchImpl,
        })
        expect(bundle.accessToken).toBe(token)
        const form = new URLSearchParams(calls[0].options.body)
        expect(form.get('grant_type')).toBe('authorization_code')
        expect(form.get('code')).toBe('c1')
        expect(form.get('code_verifier')).toBe('v1')
        expect(form.get('client_id')).toBe('cid')
        expect(form.get('redirect_uri')).toBe('http://localhost:1/')
    })

    it('posts the refresh-token grant', async () => {
        const token = jwtWithExp(1735689600)
        const { fetchImpl, calls } = fakeFetch(JSON.stringify({ access_token: token, refresh_token: 'r2' }))
        const bundle = await refreshAccessToken({ refreshToken: 'r1', clientId: 'cid', fetchImpl })
        expect(bundle.accessToken).toBe(token)
        expect(bundle.refreshToken).toBe('r2')
        const form = new URLSearchParams(calls[0].options.body)
        expect(form.get('grant_type')).toBe('refresh_token')
        expect(form.get('refresh_token')).toBe('r1')
    })

    it('throws TokenEndpointError with parsed error on non-OK responses', async () => {
        const { fetchImpl } = fakeFetch(JSON.stringify({ error: 'invalid_grant', error_description: 'expired' }), 400)
        await expect(refreshAccessToken({ refreshToken: 'r1', clientId: 'cid', fetchImpl })).rejects.toMatchObject({
            name: 'Error',
            statusCode: 400,
            error: 'invalid_grant',
        })
    })
})
