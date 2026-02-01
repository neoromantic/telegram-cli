/**
 * Type definitions for telegram-cli
 */

/** Account stored in database */
export interface Account {
  id: number
  phone: string
  name: string | null
  session_data: string
  is_active: number
  created_at: string
  updated_at: string
}

/** Output format options */
export type OutputFormat = 'json' | 'pretty' | 'quiet'

/** Global CLI options */
export interface GlobalOptions {
  account?: number
  format?: OutputFormat
  verbose?: boolean
}

/** Result wrapper for consistent output */
export interface Result<T> {
  success: true
  data: T
}

/** Error wrapper for consistent output */
export interface ErrorResult {
  success: false
  error: {
    code: string
    message: string
    details?: Record<string, unknown>
  }
}

/** CLI output type */
export type Output<T> = Result<T> | ErrorResult

/** Contact from Telegram */
export interface Contact {
  id: number
  firstName: string
  lastName: string | null
  username: string | null
  phone: string | null
}

/** Paginated response */
export interface PaginatedResult<T> {
  items: T[]
  total: number
  offset: number
  limit: number
  hasMore: boolean
}

/** Auth state */
export type AuthState =
  | { state: 'unauthorized' }
  | { state: 'awaiting_code'; phone: string; phoneCodeHash: string }
  | { state: 'awaiting_password'; phone: string; hint?: string }
  | { state: 'authorized'; user: { id: number; firstName: string; username?: string } }

/** Error codes */
export const ErrorCodes = {
  GENERAL_ERROR: 'GENERAL_ERROR',
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  INVALID_ARGS: 'INVALID_ARGS',
  NETWORK_ERROR: 'NETWORK_ERROR',
  TELEGRAM_ERROR: 'TELEGRAM_ERROR',
  ACCOUNT_NOT_FOUND: 'ACCOUNT_NOT_FOUND',
  NO_ACTIVE_ACCOUNT: 'NO_ACTIVE_ACCOUNT',
  PHONE_CODE_INVALID: 'PHONE_CODE_INVALID',
  SESSION_PASSWORD_NEEDED: 'SESSION_PASSWORD_NEEDED',
} as const

export type ErrorCode = typeof ErrorCodes[keyof typeof ErrorCodes]
