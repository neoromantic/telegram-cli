import type { ChatsCache } from '../../db/chats-cache'
import type { UsersCache } from '../../db/users-cache'
import {
  isUsernameIdentifier,
  normalizeUsername,
} from '../../utils/identifiers'
import { verbose } from '../../utils/output'
import { resolveUsername } from '../../utils/telegram-resolve'

export type ResolvedPeer = { inputPeer: any; name: string }

type CacheDeps = {
  usersCache: UsersCache
  chatsCache: ChatsCache
}

function buildUserPeerFromCache(user: any, fallbackName: string): ResolvedPeer {
  return {
    inputPeer: {
      _: 'inputPeerUser',
      userId: Number(user.user_id),
      accessHash: BigInt(user.access_hash),
    },
    name: user.display_name || fallbackName,
  }
}

function buildUserPeerFromApi(user: any, fallbackName: string): ResolvedPeer {
  return {
    inputPeer: {
      _: 'inputPeerUser',
      userId: user.id,
      accessHash: BigInt(user.accessHash || 0),
    },
    name:
      [user.firstName, user.lastName].filter(Boolean).join(' ') || fallbackName,
  }
}

function buildChannelPeerFromCache(
  chat: any,
  fallbackName: string,
): ResolvedPeer {
  return {
    inputPeer: {
      _: 'inputPeerChannel',
      channelId: Number(chat.chat_id),
      accessHash: BigInt(chat.access_hash),
    },
    name: chat.title || fallbackName,
  }
}

function buildChannelPeerFromApi(
  chat: any,
  fallbackName: string,
): ResolvedPeer {
  return {
    inputPeer: {
      _: 'inputPeerChannel',
      channelId: chat.id,
      accessHash: BigInt(chat.accessHash || 0),
    },
    name: chat.title || fallbackName,
  }
}

function buildGroupPeer(chatId: number, fallbackName: string): ResolvedPeer {
  return {
    inputPeer: {
      _: 'inputPeerChat',
      chatId,
    },
    name: fallbackName,
  }
}

function normalizePhone(identifier: string): string | null {
  if (!identifier.startsWith('+') && !/^\d{10,}$/.test(identifier)) {
    return null
  }
  return identifier.replace(/[\s\-+()]/g, '')
}

async function resolveByUsername(
  client: any,
  username: string,
  { usersCache, chatsCache }: CacheDeps,
): Promise<ResolvedPeer> {
  const cachedUser = usersCache.getByUsername(username)
  if (cachedUser?.access_hash) {
    verbose(`Found user @${username} in cache`)
    return buildUserPeerFromCache(cachedUser, `@${username}`)
  }

  const cachedChat = chatsCache.getByUsername(username)
  if (
    cachedChat?.access_hash &&
    (cachedChat.type === 'channel' || cachedChat.type === 'supergroup')
  ) {
    verbose(`Found chat @${username} in cache`)
    return buildChannelPeerFromCache(cachedChat, `@${username}`)
  }

  verbose(`Resolving @${username} via API...`)
  const resolved = await resolveUsername(client, username)
  const resolvedUser = resolved.users?.[0]
  if (resolvedUser) {
    return buildUserPeerFromApi(resolvedUser, `@${username}`)
  }

  const resolvedChat = resolved.chats?.[0]
  if (resolvedChat) {
    return buildChannelPeerFromApi(resolvedChat, `@${username}`)
  }

  throw new Error(`Could not resolve @${username}`)
}

async function resolveByPhone(
  client: any,
  identifier: string,
  phone: string,
  { usersCache }: CacheDeps,
): Promise<ResolvedPeer> {
  const cachedUser = usersCache.getByPhone(phone)
  if (cachedUser?.access_hash) {
    verbose(`Found user with phone ${identifier} in cache`)
    return buildUserPeerFromCache(cachedUser, identifier)
  }

  verbose(`Resolving phone ${identifier} via API...`)
  let resolvedUser: any
  try {
    const resolved = await client.call({
      _: 'contacts.resolvePhone',
      phone,
    } as any)
    resolvedUser = resolved.users?.[0]
  } catch {
    resolvedUser = null
  }

  if (resolvedUser) {
    return buildUserPeerFromApi(resolvedUser, identifier)
  }

  throw new Error(`Could not resolve phone number ${identifier}`)
}

function resolveByNumericId(
  identifier: string,
  { usersCache, chatsCache }: CacheDeps,
): ResolvedPeer {
  const numericId = Number.parseInt(identifier, 10)
  if (Number.isNaN(numericId)) {
    throw new Error(`Invalid peer identifier: ${identifier}`)
  }

  const cachedUser = usersCache.getById(identifier)
  if (cachedUser?.access_hash) {
    verbose(`Found user ID ${identifier} in cache`)
    return buildUserPeerFromCache(cachedUser, `User ${numericId}`)
  }

  const cachedChat = chatsCache.getById(identifier)
  if (cachedChat) {
    verbose(`Found chat ID ${identifier} in cache`)
    if (cachedChat.type === 'private') {
      return buildUserPeerFromCache(
        {
          user_id: cachedChat.chat_id,
          access_hash: cachedChat.access_hash,
          display_name: cachedChat.title,
        },
        `User ${numericId}`,
      )
    }
    if (cachedChat.type === 'group') {
      return buildGroupPeer(numericId, cachedChat.title || `Group ${numericId}`)
    }
    return buildChannelPeerFromCache(
      cachedChat,
      cachedChat.title || `Channel ${numericId}`,
    )
  }

  return buildGroupPeer(numericId, `Chat ${numericId}`)
}

export async function resolvePeer(
  client: any,
  identifier: string,
  usersCache: UsersCache,
  chatsCache: ChatsCache,
): Promise<ResolvedPeer> {
  const normalized = identifier.trim()
  const deps = { usersCache, chatsCache }

  if (isUsernameIdentifier(normalized)) {
    const username = normalizeUsername(normalized)
    return resolveByUsername(client, username, deps)
  }

  const phone = normalizePhone(normalized)
  if (phone) {
    return resolveByPhone(client, normalized, phone, deps)
  }

  return resolveByNumericId(normalized, deps)
}
