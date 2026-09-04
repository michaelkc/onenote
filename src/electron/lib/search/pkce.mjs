// PKCE (RFC 7636) helpers for the interactive authorization-code flow.
// Port of Pkce.cs (dotnetonenoteindexer).
import { randomBytes, createHash } from 'node:crypto'

const UNRESERVED = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~'

export function generateVerifier(length = 64) {
    if (length < 43 || length > 128) {
        throw new RangeError('code_verifier must be 43-128 characters')
    }
    const bytes = randomBytes(length)
    let chars = ''
    for (let i = 0; i < length; i++) {
        chars += UNRESERVED[bytes[i] % UNRESERVED.length]
    }
    return chars
}

export function computeChallenge(verifier, method = 'S256') {
    if (method === 'plain') {
        return verifier
    }
    if (method !== 'S256') {
        throw new RangeError(`unknown PKCE method: ${method}`)
    }
    // base64url: URL-safe alphabet, no padding (matches Convert.ToBase64String +
    // TrimEnd('=') + Replace in the spike)
    return createHash('sha256').update(verifier, 'ascii').digest('base64url')
}
