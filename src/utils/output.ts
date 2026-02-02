/**
 * Output utilities for consistent CLI output
 */
import type { ErrorCode, Output, OutputFormat } from '../types'

/** Current output format (can be overridden per-command) */
let currentFormat: OutputFormat = 'json'

/**
 * Output writer interface for dependency injection (testing)
 */
export interface OutputWriter {
  log(message: string): void
  error(message: string): void
}

/**
 * Default output writer using console
 */
export const defaultWriter: OutputWriter = {
  log: (message: string) => console.log(message),
  error: (message: string) => console.error(message),
}

/** Current output writer */
let writer: OutputWriter = defaultWriter

/**
 * Set the output writer (for testing)
 */
export function setOutputWriter(newWriter: OutputWriter): void {
  writer = newWriter
}

/**
 * Reset output writer to default
 */
export function resetOutputWriter(): void {
  writer = defaultWriter
}

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
 * Reset output format to default
 */
export function resetOutputFormat(): void {
  currentFormat = 'json'
}

/**
 * Output success result
 * Note: In production mode, this exits the process to close any active connections.
 * In test mode, this just logs and returns.
 */
export function success<T>(data: T): void {
  const result: Output<T> = { success: true, data }

  switch (currentFormat) {
    case 'json':
      writer.log(JSON.stringify(result, null, 2))
      break
    case 'pretty':
      writer.log(JSON.stringify(data, null, 2))
      break
    case 'quiet':
      // No output for quiet mode
      break
  }

  // In production mode, exit to close any active connections (e.g., mtcute TelegramClient)
  // This prevents the process from hanging when the event loop is kept alive by open sockets
  if (process.env.BUN_ENV !== 'test' && process.env.NODE_ENV !== 'test') {
    process.exit(0)
  }
}

/**
 * Output error result
 * Note: In test mode, this throws instead of calling process.exit
 */
export function error(
  code: ErrorCode,
  message: string,
  details?: Record<string, unknown>,
): never {
  const result: Output<never> = {
    success: false,
    error: { code, message, details },
  }

  if (currentFormat !== 'quiet') {
    writer.error(JSON.stringify(result, null, 2))
  }

  // In test mode, throw instead of exiting
  if (process.env.BUN_ENV === 'test' || process.env.NODE_ENV === 'test') {
    const err = new Error(message) as Error & {
      code: ErrorCode
      details?: Record<string, unknown>
    }
    err.code = code
    err.details = details
    throw err
  }

  // Map error codes to exit codes
  const exitCode = getExitCode(code)
  process.exit(exitCode)
}

/**
 * Map error code to exit code
 */
export function getExitCode(code: ErrorCode): number {
  const exitCodes: Record<ErrorCode, number> = {
    AUTH_REQUIRED: 2,
    INVALID_ARGS: 3,
    NETWORK_ERROR: 4,
    TELEGRAM_ERROR: 5,
    RATE_LIMITED: 5,
    ACCOUNT_NOT_FOUND: 6,
    NO_ACTIVE_ACCOUNT: 1,
    PHONE_CODE_INVALID: 1,
    SESSION_PASSWORD_NEEDED: 1,
    DAEMON_NOT_RUNNING: 1,
    DAEMON_ALREADY_RUNNING: 1,
    DAEMON_SIGNAL_FAILED: 1,
    DAEMON_SHUTDOWN_TIMEOUT: 1,
    DAEMON_FORCE_KILL_FAILED: 1,
    GENERAL_ERROR: 1,
    SQL_WRITE_NOT_ALLOWED: 1,
    SQL_SYNTAX_ERROR: 1,
    SQL_TABLE_NOT_FOUND: 1,
    SQL_OPERATION_BLOCKED: 1,
  }

  return exitCodes[code] ?? 1
}

/**
 * Format a table for pretty output
 */
export function table(
  headers: string[],
  rows: (string | number | null | undefined)[][],
): void {
  if (currentFormat === 'quiet') return

  if (currentFormat === 'json') {
    // Convert to array of objects
    const data = rows.map((row) => {
      const obj: Record<string, string | number | null | undefined> = {}
      headers.forEach((h, i) => {
        obj[h.toLowerCase()] = row[i]
      })
      return obj
    })
    writer.log(JSON.stringify({ success: true, data }, null, 2))
    return
  }

  // Pretty table output
  const colWidths = headers.map((h, i) => {
    const maxDataWidth = Math.max(...rows.map((r) => String(r[i] ?? '').length))
    return Math.max(h.length, maxDataWidth)
  })

  const separator = '─'
  const headerLine = headers
    .map((h, i) => h.padEnd(colWidths[i] ?? 0))
    .join(' │ ')
  const separatorLine = colWidths.map((w) => separator.repeat(w)).join('─┼─')

  writer.log(headerLine)
  writer.log(separatorLine)

  for (const row of rows) {
    const line = row
      .map((cell, i) => String(cell ?? '').padEnd(colWidths[i] ?? 0))
      .join(' │ ')
    writer.log(line)
  }
}

/**
 * Log verbose output (only in verbose mode)
 */
export function verbose(message: string): void {
  if (process.env.VERBOSE === '1') {
    writer.error(`[verbose] ${message}`)
  }
}

/**
 * Log info message (not in quiet mode)
 */
export function info(message: string): void {
  if (currentFormat !== 'quiet') {
    writer.error(message)
  }
}
