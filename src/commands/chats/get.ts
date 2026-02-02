import { defineCommand } from 'citty'

import { getCacheDb } from '../../db'
import { createChatsCache } from '../../db/chats-cache'
import {
  type ChatType,
  getDefaultCacheConfig,
  isCacheStale,
} from '../../db/types'
import { getClientForAccount } from '../../services/telegram'
import { ErrorCodes } from '../../types'
import {
  isUsernameIdentifier,
  normalizeUsername,
} from '../../utils/identifiers'
import { error, success, verbose } from '../../utils/output'
import { resolveUsername } from '../../utils/telegram-resolve'
import {
  cachedChatToItem,
  chatRowToItem,
  userToPrivateChatCacheInput,
} from './helpers'

function peerToChatType(peer: any): ChatType {
  if (peer.megagroup || peer.gigagroup) return 'supergroup'
  if (peer.broadcast) return 'channel'
  return 'group'
}

export const getChatCommand = defineCommand({
  meta: {
    name: 'get',
    description: 'Get chat information by ID or username',
  },
  args: {
    id: {
      type: 'string',
      description: 'Chat ID or @username',
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
    const identifier = args.id
    const accountId = args.account
      ? Number.parseInt(args.account, 10)
      : undefined
    const fresh = args.fresh ?? false
    const isUsername = isUsernameIdentifier(identifier)

    try {
      const cacheDb = getCacheDb()
      const chatsCache = createChatsCache(cacheDb)
      const cacheConfig = getDefaultCacheConfig()

      if (!fresh) {
        const cached = isUsername
          ? chatsCache.getByUsername(identifier)
          : chatsCache.getById(identifier)

        if (cached) {
          const stale = isCacheStale(
            cached.fetched_at,
            cacheConfig.staleness.dialogs,
          )

          success({
            ...cachedChatToItem(cached),
            source: 'cache',
            stale,
          })
          return
        }
      }

      verbose(`Fetching chat "${identifier}" from Telegram API...`)
      const client = getClientForAccount(accountId)

      if (!isUsername) {
        error(
          ErrorCodes.INVALID_ARGS,
          'Fetching by numeric ID is not yet supported. Use @username instead.',
        )
      }

      const resolved = await resolveUsername(client, identifier)
      const resolvedChat = resolved.chats?.[0]
      const resolvedUser = resolved.users?.[0]

      if (!resolvedChat && !resolvedUser) {
        error(
          ErrorCodes.TELEGRAM_ERROR,
          `Chat @${normalizeUsername(identifier)} not found`,
        )
      }

      if (resolvedUser) {
        const cacheInput = userToPrivateChatCacheInput(resolvedUser)
        chatsCache.upsert(cacheInput)

        success({
          ...chatRowToItem(cacheInput),
          source: 'api',
          stale: false,
        })
        return
      }

      const peer = resolvedChat
      const type = peerToChatType(peer)

      const cacheInput = {
        chat_id: String(peer.id),
        type,
        title: peer.title ?? null,
        username: peer.username ?? null,
        member_count: peer.participantsCount ?? null,
        access_hash: peer.accessHash ? String(peer.accessHash) : null,
        is_creator: peer.creator ? 1 : 0,
        is_admin: peer.adminRights ? 1 : 0,
        last_message_id: null,
        last_message_at: null,
        fetched_at: Date.now(),
        raw_json: JSON.stringify(peer),
      }

      chatsCache.upsert(cacheInput)
      verbose('Cached chat data')

      success({
        ...chatRowToItem(cacheInput),
        source: 'api',
        stale: false,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      error(ErrorCodes.TELEGRAM_ERROR, `Failed to get chat: ${message}`)
    }
  },
})
