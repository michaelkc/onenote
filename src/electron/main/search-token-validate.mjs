// Validate harvested bearer-token candidates against a cheap Graph read and
// return the first 200 winner. Runs in the main process (Node fetch — no CORS)
// so tokens are only ever used server-side for validation, never surfaced.
import { decodeJwtExp } from '../lib/search/token-refresh-policy.mjs'

const VALIDATE_URL = 'https://graph.microsoft.com/v1.0/me/onenote/notebooks?$top=1'
const MAX_CANDIDATES = 10
const TIMEOUT_MS = 10000

export default async function validateTokenCandidates(candidates) {
    const unique = [...new Set(candidates ?? [])].filter(Boolean).slice(0, MAX_CANDIDATES)

    for (const token of unique) {
        try {
            const response = await fetch(VALIDATE_URL, {
                headers: { Authorization: `Bearer ${token}` },
                signal: AbortSignal.timeout(TIMEOUT_MS),
            })
            if (response.ok) {
                return { token, expiresOn: decodeJwtExp(token) }
            }
        } catch {
            // Try the next candidate.
        }
    }

    return null
}
