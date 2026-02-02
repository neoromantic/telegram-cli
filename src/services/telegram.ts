/**
 * Global setTimeout patch to prevent crashes from invalid/negative timeouts
 * This must be applied before importing mtcute or any other library that uses timers
 */
const timeoutPatchKey = Symbol.for('tgcli.timeoutPatch')
if (!(globalThis as Record<symbol, boolean>)[timeoutPatchKey]) {
  const originalSetTimeout = globalThis.setTimeout
  globalThis.setTimeout = ((
    handler: (...args: unknown[]) => void,
    delay?: number,
    ...args: unknown[]
  ): ReturnType<typeof originalSetTimeout> => {
    const safeDelay = Math.max(0, Number.isFinite(delay) ? delay! : 0)
    return originalSetTimeout(handler, safeDelay, ...args)
  }) as typeof setTimeout
  ;(globalThis as Record<symbol, boolean>)[timeoutPatchKey] = true
}

/**
 * Telegram client manager
 * Handles multi-account support with session persistence
 */

import { join } from 'node:path'
import { TelegramClient } from '@mtcute/bun'
import { type FloodWaiterOptions, networkMiddlewares } from '@mtcute/core'

import {
  type AccountsDbInterface,
  accountsDb as defaultAccountsDb,
  getDataDir,
} from '../db'
import { wrapClientCallWithRecordReplay } from '../utils/telegram-record-replay'

// Store active clients by account ID
const clients = new Map<number, TelegramClient>()

// API credentials from environment
const API_ID = parseInt(process.env.TELEGRAM_API_ID ?? '0', 10)
const API_HASH = process.env.TELEGRAM_API_HASH ?? ''

// Verbose/debug mode - set via VERBOSE=1 or MTCUTE_LOG_LEVEL env var
const LOG_LEVEL = parseInt(
  process.env.MTCUTE_LOG_LEVEL ?? (process.env.VERBOSE === '1' ? '5' : '2'),
  10,
)

/**
 * Configuration for telegram service
 */
export interface TelegramConfig {
  apiId: number
  apiHash: string
  logLevel: number
  /** FloodWaiter middleware options */
  floodWaiter?: FloodWaiterOptions
}

/**
 * Default FloodWaiter options
 * - maxRetries: 5 attempts before giving up
 * - maxWait: 60 seconds max wait time (higher than default 10s for CLI use)
 * - store: true to remember wait times across requests
 */
const DEFAULT_FLOOD_WAITER_OPTIONS: FloodWaiterOptions = {
  maxRetries: 5,
  maxWait: 60000, // 60 seconds - CLI users can wait longer
  store: true,
  onBeforeWait: (ctx, seconds) => {
    // Log flood wait unless it's a common method that often triggers it
    const method = ctx.request._
    const quietMethods = [
      'messages.getDialogs',
      'messages.getHistory',
      'contacts.getContacts',
    ]
    if (!quietMethods.includes(method)) {
      console.error(`[flood-wait] ${method}: waiting ${seconds}s before retry`)
    }
  },
}

/**
 * Get default configuration from environment
 */
export function getDefaultConfig(): TelegramConfig {
  return {
    apiId: API_ID,
    apiHash: API_HASH,
    logLevel: LOG_LEVEL,
  }
}

/**
 * Validate API credentials
 */
export function validateConfig(config: TelegramConfig): {
  valid: boolean
  error?: string
} {
  if (!config.apiId || config.apiId <= 0) {
    return {
      valid: false,
      error: 'TELEGRAM_API_ID environment variable is required',
    }
  }
  if (!config.apiHash) {
    return {
      valid: false,
      error: 'TELEGRAM_API_HASH environment variable is required',
    }
  }
  return { valid: true }
}

/**
 * Get session storage path for an account
 */
export function getSessionPath(accountId: number, dataDir?: string): string {
  return join(dataDir ?? getDataDir(), `session_${accountId}.db`)
}

/**
 * Client factory interface for dependency injection
 */
export interface ClientFactory {
  create(accountId: number): TelegramClient
}

/**
 * Default client factory using mtcute
 */
export function createDefaultClientFactory(
  config: TelegramConfig,
  dataDir?: string,
): ClientFactory {
  // Build middleware stack
  const floodWaiterOpts = config.floodWaiter ?? DEFAULT_FLOOD_WAITER_OPTIONS
  const middlewares = [networkMiddlewares.floodWaiter(floodWaiterOpts)]

  return {
    create(accountId: number): TelegramClient {
      const client = new TelegramClient({
        apiId: config.apiId,
        apiHash: config.apiHash,
        storage: getSessionPath(accountId, dataDir),
        logLevel: config.logLevel,
        network: {
          middlewares,
        },
      })
      wrapClientCallWithRecordReplay(client, { accountId, dataDir })
      return client
    },
  }
}

/**
 * Telegram client manager interface
 */
export interface TelegramClientManager {
  createClient(accountId: number): TelegramClient
  getClient(accountId: number): TelegramClient
  getActiveClient(): TelegramClient
  getClientForAccount(accountId?: number): TelegramClient
  removeClient(accountId: number): void
  removeAllClients(): void
  hasClient(accountId: number): boolean
}

/**
 * Create a telegram client manager
 */
export function createClientManager(
  factory: ClientFactory,
  accountsDb: AccountsDbInterface = defaultAccountsDb,
): TelegramClientManager {
  const clientMap = new Map<number, TelegramClient>()

  return {
    /**
     * Create a new Telegram client for an account
     */
    createClient(accountId: number): TelegramClient {
      const client = factory.create(accountId)
      clientMap.set(accountId, client)
      return client
    },

    /**
     * Get or create a client for an account
     */
    getClient(accountId: number): TelegramClient {
      const existing = clientMap.get(accountId)
      if (existing) return existing
      return this.createClient(accountId)
    },

    /**
     * Get client for the active account
     */
    getActiveClient(): TelegramClient {
      const account = accountsDb.getActive()
      if (!account) {
        throw new Error('No active account. Use "tg accounts add" to add one.')
      }
      return this.getClient(account.id)
    },

    /**
     * Get client for a specific account (by ID or use active)
     */
    getClientForAccount(accountId?: number): TelegramClient {
      if (accountId !== undefined) {
        const account = accountsDb.getById(accountId)
        if (!account) {
          throw new Error(`Account with ID ${accountId} not found`)
        }
        return this.getClient(accountId)
      }
      return this.getActiveClient()
    },

    /**
     * Remove a specific client from cache
     */
    removeClient(accountId: number): void {
      clientMap.delete(accountId)
    },

    /**
     * Remove all clients from cache
     */
    removeAllClients(): void {
      clientMap.clear()
    },

    /**
     * Check if a client exists
     */
    hasClient(accountId: number): boolean {
      return clientMap.has(accountId)
    },
  }
}

/**
 * Check if a client is connected and authorized
 */
export async function isAuthorized(client: TelegramClient): Promise<boolean> {
  try {
    await client.getMe()
    return true
  } catch {
    return false
  }
}

// Validate credentials at startup (only warn, don't exit - for tests)
const defaultConfig = getDefaultConfig()
const validation = validateConfig(defaultConfig)
if (!validation.valid && process.env.NODE_ENV !== 'test') {
  console.error(`Error: ${validation.error}`)
  console.error('Get them from https://my.telegram.org/apps')
  if (process.env.BUN_ENV !== 'test') {
    process.exit(1)
  }
}

// Default client factory
const defaultFactory = createDefaultClientFactory(defaultConfig)

/**
 * Create a new Telegram client for an account (uses global manager)
 */
export function createClient(accountId: number): TelegramClient {
  const client = defaultFactory.create(accountId)
  clients.set(accountId, client)
  return client
}

/**
 * Get or create a client for an account (uses global clients map)
 */
export function getClient(accountId: number): TelegramClient {
  const existing = clients.get(accountId)
  if (existing) return existing
  return createClient(accountId)
}

/**
 * Get client for the active account
 */
export function getActiveClient(): TelegramClient {
  const account = defaultAccountsDb.getActive()
  if (!account) {
    throw new Error('No active account. Use "tg accounts add" to add one.')
  }
  return getClient(account.id)
}

/**
 * Get client for a specific account (by ID or use active)
 */
export function getClientForAccount(accountId?: number): TelegramClient {
  if (accountId !== undefined) {
    const account = defaultAccountsDb.getById(accountId)
    if (!account) {
      throw new Error(`Account with ID ${accountId} not found`)
    }
    return getClient(accountId)
  }
  return getActiveClient()
}

/**
 * Remove a specific client from cache
 */
export function removeClient(accountId: number): void {
  clients.delete(accountId)
}

/**
 * Remove all clients from cache
 */
export function removeAllClients(): void {
  clients.clear()
}

export { API_ID, API_HASH }
