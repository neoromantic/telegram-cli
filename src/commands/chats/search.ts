import { defineCommand } from 'citty'

import { getCacheDb } from '../../db'
import { createChatsCache } from '../../db/chats-cache'
import { getDefaultCacheConfig, isCacheStale } from '../../db/types'
import { ErrorCodes } from '../../types'
import { error, success } from '../../utils/output'
import { cachedChatToItem } from './helpers'

export const searchChatsCommand = defineCommand({
  meta: {
    name: 'search',
    description: 'Search chats by title or username',
  },
  args: {
    query: {
      type: 'string',
      description: 'Search query',
      required: true,
    },
    limit: {
      type: 'string',
      description: 'Maximum number of results (default: 20)',
      default: '20',
    },
    account: {
      type: 'string',
      description: 'Account ID (uses active account if not specified)',
    },
  },
  async run({ args }) {
    const query = args.query
    const limit = Number.parseInt(args.limit ?? '20', 10)

    try {
      const cacheDb = getCacheDb()
      const chatsCache = createChatsCache(cacheDb)
      const cacheConfig = getDefaultCacheConfig()

      const results = chatsCache.search(query, limit)

      if (results.length > 0) {
        const anyStale = results.some((c) =>
          isCacheStale(c.fetched_at, cacheConfig.staleness.dialogs),
        )

        const items = results.map(cachedChatToItem)

        success({
          query,
          results: items,
          total: items.length,
          source: 'cache',
          stale: anyStale,
        })
        return
      }

      success({
        query,
        results: [],
        total: 0,
        source: 'cache',
        stale: false,
        message:
          'No results in cache. Run "tg chats list --fresh" to populate cache first.',
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      error(ErrorCodes.TELEGRAM_ERROR, `Search failed: ${message}`)
    }
  },
})
