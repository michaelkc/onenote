import { describe, it, expect } from 'vitest'
import { decodeJwtExp, decideTokenAction } from '../src/electron/lib/search/token-refresh-policy.mjs'

// A JWT-shaped token with a controllable payload: header.payload.signature
function jwtWithPayload(payload) {
    const enc = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url')
    return `${enc({ alg: 'none' })}.${enc(payload)}.sig`
}

describe('decodeJwtExp', () => {
    it('reads exp from the payload and converts to millis', () => {
        const token = jwtWithPayload({ exp: 1735689600 })
        expect(decodeJwtExp(token)).toBe(1735689600 * 1000)
    })

    it('returns null for malformed or missing input', () => {
        expect(decodeJwtExp('')).toBe(null)
        expect(decodeJwtExp('not-a-jwt')).toBe(null)
        expect(decodeJwtExp(null)).toBe(null)
        expect(decodeJwtExp(undefined)).toBe(null)
        expect(decodeJwtExp(jwtWithPayload({ nope: 1 }))).toBe(null)
    })
})

describe('decideTokenAction', () => {
    const now = 1735689600000

    it('requires reauth without a token', () => {
        expect(decideTokenAction({ token: null, expiresOnMs: now + 60000, nowMs: now })).toBe('reauth')
    })

    it('uses a fresh token (outside the safety margin)', () => {
        expect(decideTokenAction({ token: 't', expiresOnMs: now + 10 * 60 * 1000, nowMs: now })).toBe('use')
    })

    it('requires reauth when inside the safety margin', () => {
        expect(decideTokenAction({ token: 't', expiresOnMs: now + 4 * 60 * 1000, nowMs: now })).toBe('reauth')
    })

    it('uses the token when no expiry evidence exists', () => {
        expect(decideTokenAction({ token: 't', expiresOnMs: null, nowMs: now })).toBe('use')
    })

    it('respects a custom margin', () => {
        expect(decideTokenAction({ token: 't', expiresOnMs: now + 1000, nowMs: now, marginMs: 10000 })).toBe('reauth')
        expect(decideTokenAction({ token: 't', expiresOnMs: now + 1000, nowMs: now, marginMs: 0 })).toBe('use')
    })
})
