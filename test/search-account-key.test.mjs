import { describe, it, expect } from 'vitest'
import accountKey from '../src/electron/lib/search/account-key.mjs'

describe('accountKey', () => {
    it('lowercases and keeps email-safe characters', () => {
        expect(accountKey('User.Name+tag@Example.com')).toBe('user.name+tag@example.com')
    })

    it('replaces unsafe filesystem characters', () => {
        expect(accountKey('a/b\\c:d*e?f"g<h>i|j')).toBe('a_b_c_d_e_f_g_h_i_j')
    })

    it('maps empty values to default', () => {
        expect(accountKey('')).toBe('default')
        expect(accountKey('   ')).toBe('default')
        expect(accountKey(null)).toBe('default')
        expect(accountKey(undefined)).toBe('default')
    })

    it('bounds the length', () => {
        const long = 'a'.repeat(200) + '@example.com'
        expect(accountKey(long).length).toBeLessThanOrEqual(64)
    })
})
