// Filesystem/electron-store-safe key derived from an account email: lowercased,
// non-safe characters replaced, bounded length. Empty values map to 'default'
// (unsigned tabs and pre-login harvests share one index).
export default function accountKey(account) {
    const value = typeof account === 'string' ? account.trim().toLowerCase() : ''
    const key = value.replace(/[^a-z0-9._@+-]/g, '_').slice(0, 64)
    return key === '' ? 'default' : key
}
