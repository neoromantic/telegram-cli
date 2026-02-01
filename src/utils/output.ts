/**
 * Output utilities for consistent CLI output
 */
import type { Output, OutputFormat, ErrorCode } from '../types'

/** Current output format (can be overridden per-command) */
let currentFormat: OutputFormat = 'json'

/**
 * Set the output format
 */
export function setOutputFormat(format: OutputFormat): void {
  currentFormat = format
}

/**
 * Get current output format
 */
export function getOutputFormat(): OutputFormat {
  return currentFormat
}

/**
 * Output success result
 */
export function success<T>(data: T): void {
  const result: Output<T> = { success: true, data }

  switch (currentFormat) {
    case 'json':
      console.log(JSON.stringify(result, null, 2))
      break
    case 'pretty':
      console.log(JSON.stringify(data, null, 2))
      break
    case 'quiet':
      // No output for quiet mode
      break
  }
}

/**
 * Output error result
 */
export function error(code: ErrorCode, message: string, details?: Record<string, unknown>): never {
  const result: Output<never> = {
    success: false,
    error: { code, message, details },
  }

  if (currentFormat !== 'quiet') {
    console.error(JSON.stringify(result, null, 2))
  }

  // Map error codes to exit codes
  const exitCode = getExitCode(code)
  process.exit(exitCode)
}

/**
 * Map error code to exit code
 */
function getExitCode(code: ErrorCode): number {
  switch (code) {
    case 'AUTH_REQUIRED':
      return 2
    case 'INVALID_ARGS':
      return 3
    case 'NETWORK_ERROR':
      return 4
    case 'TELEGRAM_ERROR':
      return 5
    default:
      return 1
  }
}

/**
 * Format a table for pretty output
 */
export function table(headers: string[], rows: (string | number | null | undefined)[][]): void {
  if (currentFormat === 'quiet') return

  if (currentFormat === 'json') {
    // Convert to array of objects
    const data = rows.map(row => {
      const obj: Record<string, string | number | null | undefined> = {}
      headers.forEach((h, i) => {
        obj[h.toLowerCase()] = row[i]
      })
      return obj
    })
    console.log(JSON.stringify({ success: true, data }, null, 2))
    return
  }

  // Pretty table output
  const colWidths = headers.map((h, i) => {
    const maxDataWidth = Math.max(...rows.map(r => String(r[i] ?? '').length))
    return Math.max(h.length, maxDataWidth)
  })

  const separator = '─'
  const headerLine = headers.map((h, i) => h.padEnd(colWidths[i] ?? 0)).join(' │ ')
  const separatorLine = colWidths.map(w => separator.repeat(w)).join('─┼─')

  console.log(headerLine)
  console.log(separatorLine)

  for (const row of rows) {
    const line = row.map((cell, i) => String(cell ?? '').padEnd(colWidths[i] ?? 0)).join(' │ ')
    console.log(line)
  }
}

/**
 * Log verbose output (only in verbose mode)
 */
export function verbose(message: string): void {
  if (process.env.VERBOSE === '1') {
    console.error(`[verbose] ${message}`)
  }
}

/**
 * Log info message (not in quiet mode)
 */
export function info(message: string): void {
  if (currentFormat !== 'quiet') {
    console.error(message)
  }
}
