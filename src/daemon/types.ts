/**
 * Daemon types and interfaces
 */
import type { TelegramClient } from '@mtcute/bun'

/**
 * Daemon exit codes
 */
export enum DaemonExitCode {
  /** Clean shutdown */
  Success = 0,
  /** General error */
  Error = 1,
  /** Already running (PID file exists with live process) */
  AlreadyRunning = 2,
  /** No accounts configured */
  NoAccounts = 3,
  /** All accounts failed to connect */
  AllAccountsFailed = 4,
}

/**
 * Daemon verbosity level
 */
export type DaemonVerbosity = 'quiet' | 'normal' | 'verbose'

/**
 * Daemon configuration
 */
export interface DaemonConfig {
  /** Verbosity level */
  verbosity: DaemonVerbosity
  /** Data directory path */
  dataDir: string
  /** PID file path */
  pidPath: string
  /** Delay between pagination calls within a single job (ms) */
  interBatchDelayMs: number
  /** Delay between different sync jobs (ms) */
  interJobDelayMs: number
}

/**
 * Default sync delay configuration
 */
export const DEFAULT_SYNC_DELAYS = {
  /** Default inter-batch delay: 1 second */
  interBatchDelayMs: 1000,
  /** Default inter-job delay: 3 seconds */
  interJobDelayMs: 3000,
} as const

/**
 * Account connection state
 */
export interface AccountConnectionState {
  /** Account ID */
  accountId: number
  /** Account phone number */
  phone: string
  /** Account display name */
  name: string | null
  /** Connection status */
  status: 'connecting' | 'connected' | 'disconnected' | 'error'
  /** Last error message */
  lastError?: string
  /** Last activity timestamp */
  lastActivity?: number
  /** Telegram client instance */
  client?: TelegramClient
}

/**
 * Daemon state
 */
export interface DaemonState {
  /** Whether daemon is running */
  running: boolean
  /** Start timestamp */
  startedAt?: number
  /** Connected accounts */
  accounts: Map<number, AccountConnectionState>
  /** Shutdown signal received */
  shutdownRequested: boolean
}

/**
 * Daemon status for display
 */
export interface DaemonStatus {
  /** Whether daemon is running */
  running: boolean
  /** Process ID */
  pid: number | null
  /** Uptime in milliseconds */
  uptimeMs: number | null
  /** Connected accounts count */
  connectedAccounts: number
  /** Total accounts count */
  totalAccounts: number
  /** Account details */
  accounts: Array<{
    id: number
    phone: string
    name: string | null
    status: string
    lastError?: string
  }>
  /** Messages synced count */
  messagesSynced: number
  /** Last update timestamp */
  lastUpdate: number | null
}
