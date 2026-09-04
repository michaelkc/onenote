// Build the authorize URL and parse the authorization redirect for the
// personal-account (/consumers) authorization-code flow with PKCE.
// Port of AuthorizationRequest.cs / RedirectParser.cs (dotnetonenoteindexer).

export const AUTHORITY = 'https://login.microsoftonline.com/consumers/oauth2/v2.0'

export function buildAuthorizeUrl({
    clientId,
    redirectUri,
    scopes,
    state,
    codeChallenge,
    codeChallengeMethod = 'S256',
}) {
    const query = new URLSearchParams({
        client_id: clientId,
        response_type: 'code',
        redirect_uri: redirectUri,
        scope: scopes,
        response_mode: 'query',
        state,
        code_challenge: codeChallenge,
        code_challenge_method: codeChallengeMethod,
    })
    return `${AUTHORITY}/authorize?${query.toString()}`
}

export class StateMismatchError extends Error {
    constructor(expected, actual) {
        super(`OAuth state mismatch: expected '${expected}', got '${actual ?? '<none>'}'`)
        this.expected = expected
        this.actual = actual
    }
}

// Extract the auth result from the redirect URL, validating state.
// Returns { code } or { error, errorDescription }.
export function parseRedirect(redirectUrl, expectedState) {
    const url = new URL(redirectUrl)
    const actualState = url.searchParams.get('state')
    if (actualState !== expectedState) {
        throw new StateMismatchError(expectedState, actualState)
    }

    const code = url.searchParams.get('code')
    if (code) {
        return { code }
    }

    const error = url.searchParams.get('error')
    if (error) {
        return { error, errorDescription: url.searchParams.get('error_description') }
    }

    throw new Error('Authorization redirect contained neither a code nor an error.')
}
