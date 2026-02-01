/**
 * User commands - tg me and tg user @username
 *
 * Get information about the current user or look up any user.
 */
import { defineCommand } from 'citty'

import { getCacheDb } from '../db'
import { getDefaultCacheConfig, isCacheStale } from '../db/types'
import { createUsersCache, type UserCacheInput } from '../db/users-cache'
import { getClientForAccount } from '../services/telegram'
import { ErrorCodes } from '../types'
import { error, success, verbose } from '../utils/output'

/**
 * User info returned by commands
 */
export interface UserInfo {
  id: number
  firstName: string
  lastName: string | null
  username: string | null
  phone: string | null
  isBot: boolean
  isPremium: boolean
  isContact: boolean
}

/**
 * Convert API user to UserInfo
 */
function apiUserToUserInfo(user: any): UserInfo {
  return {
    id: user.id,
    firstName: user.firstName ?? '',
    lastName: user.lastName ?? null,
    username: user.username ?? null,
    phone: user.phone ?? null,
    isBot: Boolean(user.bot),
    isPremium: Boolean(user.premium),
    isContact: Boolean(user.contact),
  }
}

/**
 * Convert cached user to UserInfo
 */
function cachedUserToUserInfo(cached: any): UserInfo {
  return {
    id: Number(cached.user_id),
    firstName: cached.first_name ?? '',
    lastName: cached.last_name ?? null,
    username: cached.username ?? null,
    phone: cached.phone ?? null,
    isBot: cached.is_bot === 1,
    isPremium: cached.is_premium === 1,
    isContact: cached.is_contact === 1,
  }
}

/**
 * Convert API user to cache input
 */
function apiUserToCacheInput(user: any): UserCacheInput {
  return {
    user_id: String(user.id),
    username: user.username ?? null,
    first_name: user.firstName ?? null,
    last_name: user.lastName ?? null,
    phone: user.phone ?? null,
    access_hash: user.accessHash ? String(user.accessHash) : null,
    is_contact: user.contact ? 1 : 0,
    is_bot: user.bot ? 1 : 0,
    is_premium: user.premium ? 1 : 0,
    fetched_at: Date.now(),
    raw_json: JSON.stringify(user),
  }
}

/**
 * tg me - Get current user info
 */
export const meCommand = defineCommand({
  meta: {
    name: 'me',
    description: 'Get current user information',
  },
  args: {
    account: {
      type: 'string',
      description: 'Account ID (uses active account if not specified)',
    },
    fresh: {
      type: 'boolean',
      description: 'Bypass cache and fetch from API',
      default: false,
    },
  },
  async run({ args }) {
    try {
      const accountId = args.account
        ? Number.parseInt(args.account, 10)
        : undefined
      const fresh = args.fresh ?? false

      // Get client
      const client = getClientForAccount(accountId)

      // Initialize cache
      const cacheDb = getCacheDb()
      const usersCache = createUsersCache(cacheDb)
      const cacheConfig = getDefaultCacheConfig()

      // Check if we're authorized
      let me: any
      try {
        me = await client.getMe()
      } catch {
        error(
          ErrorCodes.AUTH_REQUIRED,
          'Not authorized. Please log in first with "tg auth login"',
        )
      }

      const userId = String(me.id)

      // Check cache first (unless --fresh)
      if (!fresh) {
        const cached = usersCache.getById(userId)
        if (cached) {
          const stale = isCacheStale(
            cached.fetched_at,
            cacheConfig.staleness.peers,
          )

          verbose(`Returning cached user (stale: ${stale})`)
          success({
            user: cachedUserToUserInfo(cached),
            source: 'cache' as const,
            stale,
          })
          return
        }
      }

      // Fetch fresh data and cache it
      verbose('Fetching current user info from API...')

      // Cache the user
      usersCache.upsert(apiUserToCacheInput(me))

      success({
        user: apiUserToUserInfo(me),
        source: 'api' as const,
        stale: false,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      error(ErrorCodes.TELEGRAM_ERROR, `Failed to get user info: ${message}`)
    }
  },
})

/**
 * tg user <identifier> - Look up any user
 */
export const userCommand = defineCommand({
  meta: {
    name: 'user',
    description: 'Look up a user by ID, @username, or phone number',
  },
  args: {
    identifier: {
      type: 'positional',
      description: 'User ID, @username, or phone number',
      required: true,
    },
    account: {
      type: 'string',
      description: 'Account ID (uses active account if not specified)',
    },
    fresh: {
      type: 'boolean',
      description: 'Bypass cache and fetch from API',
      default: false,
    },
  },
  async run({ args }) {
    try {
      const identifier = args.identifier as string
      const accountId = args.account
        ? Number.parseInt(args.account, 10)
        : undefined
      const fresh = args.fresh ?? false

      // Determine identifier type
      const isUsername =
        identifier.startsWith('@') ||
        (Number.isNaN(Number(identifier)) && !identifier.startsWith('+'))
      const isPhone = identifier.startsWith('+') || /^\d{10,}$/.test(identifier)
      const isUserId =
        !isUsername && !isPhone && !Number.isNaN(Number(identifier))

      // Initialize cache
      const cacheDb = getCacheDb()
      const usersCache = createUsersCache(cacheDb)
      const cacheConfig = getDefaultCacheConfig()

      // Check cache first (unless --fresh)
      if (!fresh) {
        let cached = null
        if (isUsername) {
          cached = usersCache.getByUsername(identifier)
        } else if (isPhone) {
          cached = usersCache.getByPhone(identifier)
        } else if (isUserId) {
          cached = usersCache.getById(identifier)
        }

        if (cached) {
          const stale = isCacheStale(
            cached.fetched_at,
            cacheConfig.staleness.peers,
          )

          verbose(`Returning cached user (stale: ${stale})`)
          success({
            user: cachedUserToUserInfo(cached),
            source: 'cache' as const,
            stale,
          })
          return
        }
      }

      // Fetch from API
      verbose(`Fetching user from API...`)
      const client = getClientForAccount(accountId)

      let user: any = null

      if (isUsername) {
        // Resolve username
        const username = identifier.startsWith('@')
          ? identifier.slice(1)
          : identifier

        verbose(`Resolving username: ${username}`)
        const resolved = (await client.call({
          _: 'contacts.resolveUsername',
          username,
        } as any)) as any

        user = resolved.users?.[0]
      } else if (isPhone) {
        // Resolve phone
        const phone = identifier.replace(/[\s+\-()]/g, '')

        verbose(`Resolving phone: ${phone}`)
        const resolved = (await client.call({
          _: 'contacts.resolvePhone',
          phone,
        } as any)) as any

        user = resolved.users?.[0]
      } else if (isUserId) {
        // Get by user ID
        const userId = Number.parseInt(identifier, 10)

        verbose(`Fetching user ID: ${userId}`)
        const result = (await client.call({
          _: 'users.getUsers',
          id: [{ _: 'inputUser', userId, accessHash: BigInt(0) }],
        } as any)) as any[]

        user = result.find((u: any) => u._ === 'user')
      }

      if (!user || user._ !== 'user') {
        error(ErrorCodes.TELEGRAM_ERROR, `User not found: ${identifier}`)
      }

      // Cache the user (type narrowed after error() check)
      usersCache.upsert(apiUserToCacheInput(user!))

      success({
        user: apiUserToUserInfo(user),
        source: 'api' as const,
        stale: false,
      })
    } catch (err: any) {
      // Handle specific Telegram errors with friendly messages
      const errMsg = err?.message ?? String(err)
      if (errMsg.includes('USERNAME_NOT_OCCUPIED')) {
        error(ErrorCodes.TELEGRAM_ERROR, `Username not found`)
      }
      if (errMsg.includes('PHONE_NOT_OCCUPIED')) {
        error(ErrorCodes.TELEGRAM_ERROR, `Phone number not found`)
      }
      error(ErrorCodes.TELEGRAM_ERROR, `Failed to get user: ${errMsg}`)
    }
  },
})
