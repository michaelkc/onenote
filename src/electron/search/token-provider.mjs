// The token seam between the API client and whatever supplies bearer tokens.
// Today the harness injects a token lifted from the signed-in webview; a
// future PkceTokenProvider implements the same getAccessToken() contract (its
// refresh policy lives in lib/search/token-refresh-policy.mjs). After the API
// client reports a 401, invalidate() drops the token and awaits a fresh one
// from the harness with a timeout.

export default function createTokenProvider({ initialToken, requestFreshToken, timeoutMs = 60000 }) {
    let token = initialToken || null
    let refreshPromise = null

    function withTimeout(promise) {
        return Promise.race([
            promise,
            new Promise((_, reject) => {
                setTimeout(() => reject(new Error('Token refresh timed out')), timeoutMs)
            }),
        ])
    }

    function refresh() {
        if (refreshPromise === null) {
            refreshPromise = withTimeout(Promise.resolve().then(() => requestFreshToken()))
                .then((fresh) => {
                    if (!fresh) {
                        throw new Error('Token refresh returned no token')
                    }
                    token = fresh
                    refreshPromise = null
                    return fresh
                })
                .catch((error) => {
                    refreshPromise = null
                    throw error
                })
        }
        return refreshPromise
    }

    return {
        async getAccessToken() {
            if (token !== null) {
                return token
            }
            return refresh()
        },

        invalidate() {
            token = null
            return refresh()
        },
    }
}
