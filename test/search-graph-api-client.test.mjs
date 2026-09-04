import { describe, it, expect } from 'vitest'
import createOneNoteApiClient, { GraphApiError } from '../src/electron/search/graph-api-client.mjs'

const abortError = () => new DOMException('This operation was aborted', 'AbortError')

const okJson = (value) => async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ value }) })

describe('graph api client retry behavior', () => {
    it('parses a successful response without retrying', async () => {
        const retrying = []
        const api = createOneNoteApiClient({
            getAccessToken: async () => 't',
            events: { retrying: (a) => retrying.push(a) },
            fetchImpl: okJson([]),
        })
        expect(await api.getNotebooks()).toEqual([])
        expect(retrying).toHaveLength(0)
    })

    it('retries a 429 and succeeds on the next attempt', async () => {
        let calls = 0
        const retrying = []
        const api = createOneNoteApiClient({
            getAccessToken: async () => 't',
            baseRetryDelayMs: 5,
            events: { retrying: (a) => retrying.push(a) },
            fetchImpl: async () => {
                calls++
                if (calls === 1) {
                    return { ok: false, status: 429, text: async () => '{}' }
                }
                return { ok: true, status: 200, text: async () => JSON.stringify({ value: [] }) }
            },
        })
        expect(await api.getNotebooks()).toEqual([])
        expect(retrying).toHaveLength(1)
    })

    it('throws GraphApiError for a 401 without retrying', async () => {
        const retrying = []
        const api = createOneNoteApiClient({
            getAccessToken: async () => 't',
            events: { retrying: (a) => retrying.push(a) },
            fetchImpl: async () => ({ ok: false, status: 401, text: async () => '{"error":{"code":"x"}}' }),
        })
        await expect(api.getNotebooks()).rejects.toBeInstanceOf(GraphApiError)
        expect(retrying).toHaveLength(0)
    })

    it('retries a wedged (timed-out) attempt and then fails after max retries', async () => {
        const retrying = []
        const api = createOneNoteApiClient({
            getAccessToken: async () => 't',
            attemptTimeoutMs: 60,
            baseRetryDelayMs: 5,
            events: { retrying: (a, m) => retrying.push([a, m]) },
            fetchImpl: (url, { signal }) =>
                new Promise((_, reject) => {
                    signal.addEventListener('abort', () => reject(abortError()))
                }),
        })
        await expect(api.getNotebooks()).rejects.toMatchObject({ name: 'AbortError' })
        expect(retrying).toEqual([
            [1, 3],
            [2, 3],
            [3, 3],
        ])
    })

    it('does not retry an external cancellation', async () => {
        const ct = new AbortController()
        const retrying = []
        const api = createOneNoteApiClient({
            getAccessToken: async () => 't',
            baseRetryDelayMs: 5,
            events: { retrying: (a) => retrying.push(a) },
            fetchImpl: (url, { signal }) =>
                new Promise((_, reject) => {
                    if (signal.aborted) {
                        reject(abortError()) // already aborted before the call — like real fetch
                        return
                    }
                    signal.addEventListener('abort', () => reject(abortError()))
                }),
        })
        const promise = api.getNotebooks(ct.signal)
        ct.abort()
        await expect(promise).rejects.toMatchObject({ name: 'AbortError' })
        expect(retrying).toHaveLength(0)
    })

    it('counts requests for the throttle display', async () => {
        const api = createOneNoteApiClient({
            getAccessToken: async () => 't',
            fetchImpl: async () => ({ ok: false, status: 503, text: async () => '{}' }),
            baseRetryDelayMs: 5,
        })
        await expect(api.getNotebooks()).rejects.toBeInstanceOf(GraphApiError)
        expect(api.getStats().calls).toBe(4) // 1 initial + 3 retries
    })
})
