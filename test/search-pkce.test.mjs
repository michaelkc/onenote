import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { generateVerifier, computeChallenge } from '../src/electron/lib/search/pkce.mjs'

describe('pkce', () => {
    it('generates verifiers of the requested length from unreserved characters', () => {
        const verifier = generateVerifier(64)
        expect(verifier).toHaveLength(64)
        expect(verifier).toMatch(/^[A-Za-z0-9\-._~]+$/)
    })

    it('generates unique verifiers', () => {
        expect(generateVerifier()).not.toBe(generateVerifier())
    })

    it('rejects out-of-range lengths', () => {
        expect(() => generateVerifier(42)).toThrow(RangeError)
        expect(() => generateVerifier(129)).toThrow(RangeError)
    })

    it('computes the S256 challenge as unpadded base64url sha256', () => {
        const verifier = generateVerifier()
        const expected = createHash('sha256').update(verifier, 'ascii').digest('base64url')
        expect(computeChallenge(verifier)).toBe(expected)
        expect(computeChallenge(verifier)).not.toMatch(/=/)
        expect(computeChallenge(verifier)).not.toMatch(/\+|\//)
    })

    it('plain method returns the verifier unchanged', () => {
        const verifier = generateVerifier()
        expect(computeChallenge(verifier, 'plain')).toBe(verifier)
    })
})
