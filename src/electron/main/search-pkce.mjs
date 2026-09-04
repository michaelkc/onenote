// Interactive PKCE sign-in for the search indexer: opens the system browser
// against the personal-account (/consumers) authority, catches the redirect
// on a loopback listener, exchanges the code, and returns the token bundle.
// The webview lift stays as a first attempt; this is the reliable path
// (refresh tokens keep it valid across restarts).

import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { shell } from 'electron'
import registry from '../registry.mjs'
import { generateVerifier, computeChallenge } from '../lib/search/pkce.mjs'
import { buildAuthorizeUrl, parseRedirect, StateMismatchError } from '../lib/search/oauth-redirect.mjs'
import { exchangeCode } from '../lib/search/token-endpoint.mjs'

const SCOPES = 'Notes.Read User.Read offline_access openid profile'
const SIGN_IN_TIMEOUT_MS = 5 * 60 * 1000

const log = (...args) => console.log('[P3X-Search]', ...args)

let activeSignIn = null

// The redirect must match the app registration. Default: a dynamic port on
// http://localhost (Azure's bare `http://localhost` registration covers any
// port). An explicit searchRedirectUri (with port) is used verbatim.
function resolveRedirect() {
    const configured = registry.conf.get('searchRedirectUri')
    if (configured) {
        const url = new URL(configured)
        if (url.protocol !== 'http:') {
            throw new Error('searchRedirectUri must be an http:// URI')
        }
        const port = url.port ? Number(url.port) : 80
        return { port, path: url.pathname + url.search, uri: configured }
    }
    return { port: 0, path: '/', uri: null }
}

function listen(server, port) {
    return new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, '127.0.0.1', () => {
            server.removeListener('error', reject)
            resolve(server.address().port)
        })
    })
}

const REDIRECT_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>P3X OneNote</title></head>
<body style="font-family: system-ui, sans-serif; padding: 2rem; text-align: center">
<p>Sign-in complete — you can close this window and return to P3X OneNote.</p>
</body></html>`

const ERROR_HTML = (message) => `<!doctype html><html><head><meta charset="utf-8"><title>P3X OneNote</title></head>
<body style="font-family: system-ui, sans-serif; padding: 2rem; text-align: center">
<p>Sign-in failed: ${message.replace(/[<>&]/g, '')}</p>
<p>You can close this window and return to P3X OneNote.</p>
</body></html>`

function waitForRedirect(server, state, timeoutMs) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            server.close()
            reject(new Error('Sign-in timed out — no redirect received. Try again.'))
        }, timeoutMs)

        server.on('request', (req, res) => {
            const url = new URL(req.url ?? '/', 'http://localhost')
            if (url.pathname !== server.redirectPath) {
                res.writeHead(404)
                res.end()
                return
            }

            let result
            try {
                result = parseRedirect(url.href, state)
            } catch (error) {
                clearTimeout(timer)
                server.close()
                res.writeHead(400)
                res.end(ERROR_HTML(error instanceof StateMismatchError ? 'state validation failed' : error.message))
                reject(error)
                return
            }

            clearTimeout(timer)
            server.close()
            if (result.code) {
                res.writeHead(200, { 'Content-Type': 'text/html' })
                res.end(REDIRECT_HTML)
                resolve(result)
            } else {
                const message = `${result.error}${result.errorDescription ? ` — ${result.errorDescription}` : ''}`
                res.writeHead(400)
                res.end(ERROR_HTML(message))
                reject(new Error(`Sign-in was not completed: ${message}`))
            }
        })
    })
}

// Start the interactive sign-in. Single-flight: concurrent calls share the
// in-progress attempt. Resolves { bundle } on success.
export default function startSignIn({ accountKey: rawKey } = {}) {
    const key = rawKey || 'default'

    if (activeSignIn) {
        return activeSignIn
    }

    const clientId = registry.conf.get('searchClientId')
    if (!clientId) {
        return Promise.reject(
            new Error(
                'Search sign-in is not configured: register an Azure app and set searchClientId in the P3X OneNote settings file (see README).'
            )
        )
    }

    log(`starting interactive sign-in for ${key}`)

    activeSignIn = (async () => {
        const { port, path, uri: configuredUri } = resolveRedirect()
        const server = createServer()
        const actualPort = await listen(server, port)
        const redirectUri = configuredUri || `http://localhost:${actualPort}${path}`
        server.redirectPath = path

        const verifier = generateVerifier()
        const state = randomBytes(16).toString('hex')
        const authorizeUrl = buildAuthorizeUrl({
            clientId,
            redirectUri,
            scopes: SCOPES,
            state,
            codeChallenge: computeChallenge(verifier),
        })

        log(`authorize url: ${authorizeUrl}`)

        try {
            await shell.openExternal(authorizeUrl)
        } catch (error) {
            server.close()
            throw new Error(`Could not open the browser for sign-in: ${error.message}`)
        }

        log('waiting for the sign-in redirect in the browser...')
        const result = await waitForRedirect(server, state, SIGN_IN_TIMEOUT_MS)
        const bundle = await exchangeCode({
            code: result.code,
            codeVerifier: verifier,
            clientId,
            redirectUri,
        })
        log(`sign-in complete for ${key}`)
        return { key, bundle }
    })().finally(() => {
        activeSignIn = null
    })

    return activeSignIn
}
