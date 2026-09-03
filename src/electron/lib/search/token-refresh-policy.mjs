// Shared token policy for the token-provider seam: decode the JWT's exp claim
// and decide whether the stored token is usable now or the caller must
// (re-)authenticate. Lift-only today; the future PkceTokenProvider plugs into
// the same decideTokenAction contract (mirrors TokenRefreshHelper semantics,
// dotnetonenoteindexer).

function base64UrlDecode(segment) {
    if (typeof segment !== 'string' || segment === '') {
        return null
    }
    const base64 = segment.replace(/-/g, '+').replace(/_/g, '/')
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4)
    try {
        return Buffer.from(padded, 'base64').toString('utf-8')
    } catch {
        return null
    }
}

export function decodeJwtExp(token) {
    if (typeof token !== 'string') {
        return null
    }
    const parts = token.split('.')
    if (parts.length < 3) {
        return null
    }
    const payload = base64UrlDecode(parts[1])
    if (payload === null) {
        return null
    }
    try {
        const exp = JSON.parse(payload).exp
        return typeof exp === 'number' ? exp * 1000 : null
    } catch {
        return null
    }
}

export function decideTokenAction({ token, expiresOnMs, nowMs, marginMs = 5 * 60 * 1000 }) {
    if (!token) {
        return 'reauth'
    }
    if (expiresOnMs === null || expiresOnMs === undefined) {
        return 'use' // no evidence of expiry; a 401 re-harvest path catches staleness
    }
    return nowMs + marginMs >= expiresOnMs ? 'reauth' : 'use'
}
