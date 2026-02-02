import { defineCommand } from 'citty'

import { getCacheDb } from '../../db'
import { getDefaultCacheConfig, isCacheStale } from '../../db/types'
import { createUsersCache } from '../../db/users-cache'
import { getClientForAccount } from '../../services/telegram'
import { ErrorCodes } from '../../types'
import { error, success, verbose } from '../../utils/output'
import { apiUserToCacheInput } from '../../utils/telegram-mappers'
import { apiUserToUserInfo, cachedUserToUserInfo } from './helpers'

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

      const client = getClientForAccount(accountId)

      const cacheDb = getCacheDb()
      const usersCache = createUsersCache(cacheDb)
      const cacheConfig = getDefaultCacheConfig()

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

      verbose('Fetching current user info from API...')
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
