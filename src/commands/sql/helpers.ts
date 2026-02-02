const WRITE_KEYWORDS = [
  'INSERT',
  'UPDATE',
  'DELETE',
  'REPLACE',
  'DROP',
  'ALTER',
  'CREATE',
  'TRUNCATE',
  'ATTACH',
  'DETACH',
  'VACUUM',
  'REINDEX',
]

export function isReadOnlyQuery(query: string): boolean {
  const normalized = query.trim().replace(/\s+/g, ' ').toUpperCase()

  const startsWithAllowed =
    normalized.startsWith('SELECT ') ||
    normalized.startsWith('WITH ') ||
    normalized.startsWith('PRAGMA ')

  if (!startsWithAllowed) {
    return false
  }

  for (const keyword of WRITE_KEYWORDS) {
    const regex = new RegExp(`\\b${keyword}\\b`, 'i')
    if (regex.test(normalized)) {
      return false
    }
  }

  return true
}

export function applyQueryLimit(query: string, limit: number): string {
  const trimmed = query.trim()
  const withoutSemicolon = trimmed.endsWith(';')
    ? trimmed.slice(0, -1).trimEnd()
    : trimmed

  if (limit <= 0) return withoutSemicolon
  if (/\bLIMIT\b/i.test(withoutSemicolon)) return withoutSemicolon

  return `${withoutSemicolon} LIMIT ${limit}`
}
