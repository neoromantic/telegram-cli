/**
 * Argument parsing utilities for the generic API command
 */

/**
 * Parse named arguments from argv-style array into an object
 * Supports: --key value, --key=value, --nested.key value
 */
export function parseNamedArgs(args: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(args)) {
    // Skip internal citty keys
    if (key === '_' || key === '--') continue

    // Handle nested keys (e.g., peer.username -> { peer: { username: value } })
    if (key.includes('.')) {
      setNestedValue(result, key.split('.'), value)
    } else {
      result[key] = parseValue(value)
    }
  }

  return result
}

/**
 * Set a value in a nested object structure
 */
function setNestedValue(obj: Record<string, unknown>, path: string[], value: unknown): void {
  let current = obj
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i]!
    if (!(key in current) || typeof current[key] !== 'object') {
      current[key] = {}
    }
    current = current[key] as Record<string, unknown>
  }
  const lastKey = path[path.length - 1]
  if (lastKey !== undefined) {
    current[lastKey] = parseValue(value)
  }
}

/**
 * Parse a value to its appropriate type
 */
function parseValue(value: unknown): unknown {
  if (value === undefined || value === null) return value
  if (typeof value !== 'string') return value

  // Boolean
  if (value === 'true') return true
  if (value === 'false') return false

  // Number
  if (/^-?\d+$/.test(value)) return parseInt(value, 10)
  if (/^-?\d+\.\d+$/.test(value)) return parseFloat(value)

  // JSON object/array
  if ((value.startsWith('{') && value.endsWith('}')) || (value.startsWith('[') && value.endsWith(']'))) {
    try {
      return JSON.parse(value)
    } catch {
      // Not valid JSON, return as string
    }
  }

  return value
}

/**
 * Parse a peer identifier into a format suitable for mtcute
 * Supports: @username, +phone, user_id
 */
export function parsePeer(peer: string): string | number {
  // Username
  if (peer.startsWith('@')) {
    return peer.slice(1)
  }

  // Phone number
  if (peer.startsWith('+')) {
    return peer
  }

  // Numeric ID
  if (/^-?\d+$/.test(peer)) {
    return parseInt(peer, 10)
  }

  // Assume it's a username without @
  return peer
}

/**
 * Merge CLI arguments with JSON input
 */
export function mergeArgs(cliArgs: Record<string, unknown>, jsonInput?: string): Record<string, unknown> {
  const parsed = parseNamedArgs(cliArgs)

  if (jsonInput) {
    try {
      const jsonArgs = JSON.parse(jsonInput)
      return { ...parsed, ...jsonArgs }
    } catch (e) {
      throw new Error(`Invalid JSON input: ${e instanceof Error ? e.message : 'unknown error'}`)
    }
  }

  return parsed
}
