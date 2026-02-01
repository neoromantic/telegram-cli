/**
 * Chat/dialog management commands with caching
 * Uses ChatsCache for stale-while-revalidate pattern
 */
import { defineCommand } from 'citty'

import { getCacheDb } from '../db'
import {
  type CachedChatInput,
  type ChatsCache,
  createChatsCache,
} from '../db/chats-cache'
import { type ChatType, getDefaultCacheConfig, isCacheStale } from '../db/types'
import { createUsersCache, type UserCacheInput } from '../db/users-cache'
import { getClientForAccount } from '../services/telegram'
import { ErrorCodes, type PaginatedResult } from '../types'
import { error, success, verbose } from '../utils/output'

/**
 * Chat item for output
 */
interface ChatItem {
  id: number
  type: ChatType
  title: string
  username: string | null
  memberCount: number | null
  lastMessageAt: number | null
  isCreator: boolean
  isAdmin: boolean
}

/**
 * Convert cached chat to output format
 */
function cachedChatToItem(cached: ReturnType<ChatsCache['getById']>): ChatItem {
  if (!cached) throw new Error('Chat not found')
  return {
    id: Number(cached.chat_id),
    type: cached.type,
    title: cached.title ?? '',
    username: cached.username,
    memberCount: cached.member_count,
    lastMessageAt: cached.last_message_at,
    isCreator: cached.is_creator === 1,
    isAdmin: cached.is_admin === 1,
  }
}

/**
 * Extract chat type from dialog peer
 */
function getChatType(dialog: any, peer: any): ChatType {
  if (peer._ === 'peerUser') return 'private'
  if (peer._ === 'peerChat') return 'group'
  if (peer._ === 'peerChannel') {
    // Check if broadcast channel or supergroup
    const chat = dialog.chat || dialog.entity
    if (chat?.megagroup || chat?.gigagroup) return 'supergroup'
    return 'channel'
  }
  return 'private'
}

/**
 * Convert mtcute dialog to cache input
 */
function dialogToCacheInput(dialog: any): CachedChatInput {
  const peer = dialog.peer || dialog.raw?.peer
  const chat = dialog.chat || dialog.entity
  const type = getChatType(dialog, peer)

  let chatId: string
  let title: string | null = null
  let username: string | null = null
  let memberCount: number | null = null
  let accessHash: string | null = null

  if (type === 'private') {
    // For private chats, the "chat" is actually a user
    chatId = String(peer.userId)
    title = chat?.firstName
      ? [chat.firstName, chat.lastName].filter(Boolean).join(' ')
      : null
    username = chat?.username ?? null
  } else if (type === 'group') {
    chatId = String(peer.chatId)
    title = chat?.title ?? null
    memberCount = chat?.participantsCount ?? null
  } else {
    // channel or supergroup
    chatId = String(peer.channelId)
    title = chat?.title ?? null
    username = chat?.username ?? null
    memberCount = chat?.participantsCount ?? null
    accessHash = chat?.accessHash ? String(chat.accessHash) : null
  }

  return {
    chat_id: chatId,
    type,
    title,
    username,
    member_count: memberCount,
    access_hash: accessHash,
    is_creator: chat?.creator ? 1 : 0,
    is_admin: chat?.adminRights ? 1 : 0,
    last_message_id: dialog.topMessage ?? null,
    last_message_at: dialog.date ? dialog.date * 1000 : null,
    fetched_at: Date.now(),
    raw_json: JSON.stringify(dialog.raw || dialog),
  }
}

/**
 * Convert API user to cache input for private chats
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
 * List chats/dialogs
 */
export const listChatsCommand = defineCommand({
  meta: {
    name: 'list',
    description: 'List chats and dialogs with pagination',
  },
  args: {
    limit: {
      type: 'string',
      description: 'Maximum number of chats to return (default: 50)',
      default: '50',
    },
    offset: {
      type: 'string',
      description: 'Offset for pagination (default: 0)',
      default: '0',
    },
    type: {
      type: 'string',
      description:
        'Filter by chat type: private, group, supergroup, channel (default: all)',
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
    const limit = Number.parseInt(args.limit ?? '50', 10)
    const offset = Number.parseInt(args.offset ?? '0', 10)
    const typeFilter = args.type as ChatType | undefined
    const accountId = args.account
      ? Number.parseInt(args.account, 10)
      : undefined
    const fresh = args.fresh ?? false

    // Validate type filter
    if (
      typeFilter &&
      !['private', 'group', 'supergroup', 'channel'].includes(typeFilter)
    ) {
      error(
        ErrorCodes.INVALID_ARGS,
        `Invalid chat type: ${typeFilter}. Must be one of: private, group, supergroup, channel`,
      )
    }

    try {
      const cacheDb = getCacheDb()
      const chatsCache = createChatsCache(cacheDb)
      const cacheConfig = getDefaultCacheConfig()

      // Check cache first (unless --fresh)
      if (!fresh) {
        const cachedChats = chatsCache.list({
          limit: 1000, // Get all to check count
          type: typeFilter,
          orderBy: 'last_message_at',
        })

        if (cachedChats.length > 0) {
          // Check if any are stale
          const anyStale = cachedChats.some((c) =>
            isCacheStale(c.fetched_at, cacheConfig.staleness.dialogs),
          )

          // Apply pagination
          const paginatedChats = cachedChats
            .slice(offset, offset + limit)
            .map(cachedChatToItem)

          const response: PaginatedResult<ChatItem> & {
            source: string
            stale: boolean
          } = {
            items: paginatedChats,
            total: cachedChats.length,
            offset,
            limit,
            hasMore: offset + limit < cachedChats.length,
            source: 'cache',
            stale: anyStale,
          }

          if (anyStale) {
            verbose(
              'Cache is stale, consider using --fresh flag to refresh data',
            )
          }

          success(response)
          return
        }
      }

      // Fetch from API using iterDialogs
      verbose('Fetching dialogs from Telegram API...')
      const client = getClientForAccount(accountId)

      const dialogs: any[] = []
      const users: any[] = []

      // Fetch dialogs (limit to 200 for performance)
      for await (const dialog of client.iterDialogs({ limit: 200 })) {
        dialogs.push(dialog)

        // Collect users for caching (check raw data structure)
        const raw = (dialog as any).raw || dialog
        if (raw?.peer?._ === 'peerUser' && (dialog as any).chat) {
          users.push((dialog as any).chat)
        }
      }

      // Cache all dialogs
      const usersCache = createUsersCache(cacheDb)

      // Cache users first
      const userInputs = users.map(apiUserToCacheInput)
      if (userInputs.length > 0) {
        usersCache.upsertMany(userInputs)
        verbose(`Cached ${userInputs.length} users from dialogs`)
      }

      // Cache chats
      const chatInputs = dialogs.map(dialogToCacheInput)
      chatsCache.upsertMany(chatInputs)
      verbose(`Cached ${chatInputs.length} dialogs`)

      // Filter by type if specified
      let filteredChats = chatInputs
      if (typeFilter) {
        filteredChats = chatInputs.filter((c) => c.type === typeFilter)
      }

      // Sort by last_message_at descending
      filteredChats.sort(
        (a, b) => (b.last_message_at ?? 0) - (a.last_message_at ?? 0),
      )

      // Apply pagination
      const paginatedChats = filteredChats.slice(offset, offset + limit)

      // Convert to output format
      const items: ChatItem[] = paginatedChats.map((c) => ({
        id: Number(c.chat_id),
        type: c.type,
        title: c.title ?? '',
        username: c.username,
        memberCount: c.member_count,
        lastMessageAt: c.last_message_at,
        isCreator: c.is_creator === 1,
        isAdmin: c.is_admin === 1,
      }))

      const response: PaginatedResult<ChatItem> & {
        source: string
        stale: boolean
      } = {
        items,
        total: filteredChats.length,
        offset,
        limit,
        hasMore: offset + limit < filteredChats.length,
        source: 'api',
        stale: false,
      }

      success(response)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      error(ErrorCodes.TELEGRAM_ERROR, `Failed to fetch chats: ${message}`)
    }
  },
})

/**
 * Search chats
 */
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

      // Search in cache
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

      // No cached results, suggest fetching fresh data
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

/**
 * Get chat by ID or username
 */
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

    try {
      const cacheDb = getCacheDb()
      const chatsCache = createChatsCache(cacheDb)
      const cacheConfig = getDefaultCacheConfig()

      // Determine if ID or username
      const isUsername =
        identifier.startsWith('@') || Number.isNaN(Number(identifier))

      // Check cache first (unless --fresh)
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

      // Fetch from API
      verbose(`Fetching chat "${identifier}" from Telegram API...`)
      const client = getClientForAccount(accountId)

      let peer: any

      if (isUsername) {
        // Resolve username
        const resolved = await client.call({
          _: 'contacts.resolveUsername',
          username: identifier.replace('@', ''),
        } as any)

        if (resolved.chats && resolved.chats.length > 0) {
          peer = resolved.chats[0]
        } else if (resolved.users && resolved.users.length > 0) {
          // It's a user, not a chat
          const user = resolved.users[0]

          // Cache as private chat
          const cacheInput: CachedChatInput = {
            chat_id: String(user.id),
            type: 'private',
            title: [user.firstName, user.lastName].filter(Boolean).join(' '),
            username: user.username ?? null,
            member_count: null,
            access_hash: user.accessHash ? String(user.accessHash) : null,
            is_creator: 0,
            is_admin: 0,
            last_message_id: null,
            last_message_at: null,
            fetched_at: Date.now(),
            raw_json: JSON.stringify(user),
          }

          chatsCache.upsert(cacheInput)

          success({
            id: user.id,
            type: 'private' as ChatType,
            title: cacheInput.title ?? '',
            username: user.username ?? null,
            memberCount: null,
            lastMessageAt: null,
            isCreator: false,
            isAdmin: false,
            source: 'api',
            stale: false,
          })
          return
        } else {
          error(
            ErrorCodes.TELEGRAM_ERROR,
            `Chat @${identifier.replace('@', '')} not found`,
          )
        }
      } else {
        // TODO: Implement fetching by numeric ID
        // This requires knowing if it's a user, chat, or channel ID
        error(
          ErrorCodes.INVALID_ARGS,
          'Fetching by numeric ID is not yet supported. Use @username instead.',
        )
      }

      // Cache the chat
      const type: ChatType =
        peer.megagroup || peer.gigagroup
          ? 'supergroup'
          : peer.broadcast
            ? 'channel'
            : 'group'

      const cacheInput: CachedChatInput = {
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
        id: peer.id,
        type,
        title: peer.title ?? '',
        username: peer.username ?? null,
        memberCount: peer.participantsCount ?? null,
        lastMessageAt: null,
        isCreator: peer.creator ?? false,
        isAdmin: !!peer.adminRights,
        source: 'api',
        stale: false,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      error(ErrorCodes.TELEGRAM_ERROR, `Failed to get chat: ${message}`)
    }
  },
})

/**
 * Chats subcommand group
 */
export const chatsCommand = defineCommand({
  meta: {
    name: 'chats',
    description: 'Chat and dialog management commands',
  },
  subCommands: {
    list: listChatsCommand,
    search: searchChatsCommand,
    get: getChatCommand,
  },
})
