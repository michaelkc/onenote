// Token endpoint calls for the personal-account (/consumers) authority:
// authorization-code exchange and refresh-token refresh, with response
// parsing. Port of TokenEndpoint.cs (dotnetonenoteindexer); the future
// PkceTokenProvider's refresh policy pairs this with
// token-refresh-policy.mjs.
import { decodeJwtExp } from './token-refresh-policy.mjs'

export const TOKEN_URL = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token'

export class TokenEndpointError extends Error {
    constructor(statusCode, error, errorDescription) {
        super(
            `Token endpoint returned ${statusCode}${error ? `: ${error}${errorDescription ? ` — ${errorDescription}` : ''}` : ''}`
        )
        this.statusCode = statusCode
        this.error = error
        this.errorDescription = errorDescription
    }
}

function parseExpiresIn(value) {
    if (value === null || value === undefined) {
        return 3600
    }
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : 3600
}

export function parseTokenResponse(body) {
    let data
    try {
        data = JSON.parse(body)
    } catch {
        throw new TokenEndpointError(200, 'invalid_json', 'Token endpoint returned a non-JSON response.')
    }
    if (typeof data?.access_token !== 'string' || data.access_token === '') {
        throw new TokenEndpointError(200, 'invalid_response', 'Token endpoint returned a response without an access token.')
    }
    return {
        accessToken: data.access_token,
        refreshToken: typeof data.refresh_token === 'string' ? data.refresh_token : null,
        // Prefer the JWT's exp claim when readable; otherwise the endpoint's
        // expires_in seconds.
        expiresOn: decodeJwtExp(data.access_token) ?? Date.now() + parseExpiresIn(data.expires_in) * 1000,
    }
}

export function parseTokenError(body) {
    try {
        const data = JSON.parse(body)
        return {
            error: data?.error ?? null,
            errorDescription: data?.error_description ?? null,
        }
    } catch {
        return { error: null, errorDescription: null }
    }
}

async function postToken(form, fetchImpl) {
    const fetchFn = fetchImpl ?? globalThis.fetch
    const response = await fetchFn(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(form).toString(),
    })
    const body = await response.text()
    if (!response.ok) {
        const { error, errorDescription } = parseTokenError(body)
        throw new TokenEndpointError(response.status, error, errorDescription)
    }
    return parseTokenResponse(body)
}

export function exchangeCode({ code, codeVerifier, clientId, redirectUri, fetchImpl }) {
    return postToken(
        {
            grant_type: 'authorization_code',
            client_id: clientId,
            code,
            redirect_uri: redirectUri,
            code_verifier: codeVerifier,
        },
        fetchImpl
    )
}

export function refreshAccessToken({ refreshToken, clientId, fetchImpl }) {
    return postToken(
        {
            grant_type: 'refresh_token',
            client_id: clientId,
            refresh_token: refreshToken,
        },
        fetchImpl
    )
}
