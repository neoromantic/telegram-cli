/**
 * Telegram client manager
 * Handles multi-account support with session persistence
 */
import { TelegramClient } from '@mtcute/bun'
import { join } from 'node:path'

import { accountsDb, getDataDir } from '../db'

// Store active clients by account ID
const clients = new Map<number, TelegramClient>()

// API credentials from environment
const API_ID = parseInt(process.env.TELEGRAM_API_ID ?? '0', 10)
const API_HASH = process.env.TELEGRAM_API_HASH ?? ''

// Verbose/debug mode - set via VERBOSE=1 or MTCUTE_LOG_LEVEL env var
const LOG_LEVEL = parseInt(process.env.MTCUTE_LOG_LEVEL ?? (process.env.VERBOSE === '1' ? '5' : '2'), 10)

if (!API_ID || !API_HASH) {
  console.error('Error: TELEGRAM_API_ID and TELEGRAM_API_HASH environment variables are required')
  console.error('Get them from https://my.telegram.org/apps')
  process.exit(1)
}

/**
 * Get session storage path for an account
 */
function getSessionPath(accountId: number): string {
  return join(getDataDir(), `session_${accountId}.db`)
}

/**
 * Create a new Telegram client for an account
 */
export function createClient(accountId: number): TelegramClient {
  const client = new TelegramClient({
    apiId: API_ID,
    apiHash: API_HASH,
    storage: getSessionPath(accountId),
    logLevel: LOG_LEVEL,
  })

  clients.set(accountId, client)
  return client
}

/**
 * Get or create a client for an account
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
  const account = accountsDb.getActive()
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
    const account = accountsDb.getById(accountId)
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

export { API_ID, API_HASH }
