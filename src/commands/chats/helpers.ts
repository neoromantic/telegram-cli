import type {
  CachedChat,
  CachedChatInput,
  ChatsCache,
} from '../../db/chats-cache'
import type { ChatType } from '../../db/types'

export interface ChatItem {
  id: number
  type: ChatType
  title: string
  username: string | null
  memberCount: number | null
  lastMessageAt: number | null
  isCreator: boolean
  isAdmin: boolean
}

export const CHAT_TYPE_VALUES = [
  'private',
  'group',
  'supergroup',
  'channel',
] as const satisfies ChatType[]

export function isValidChatType(value: string | undefined): value is ChatType {
  return value !== undefined && CHAT_TYPE_VALUES.includes(value as ChatType)
}

type ChatRow = CachedChat | CachedChatInput

export function chatRowToItem(chat: ChatRow): ChatItem {
  return {
    id: Number(chat.chat_id),
    type: chat.type,
    title: chat.title ?? '',
    username: chat.username,
    memberCount: chat.member_count,
    lastMessageAt: chat.last_message_at,
    isCreator: chat.is_creator === 1,
    isAdmin: chat.is_admin === 1,
  }
}

export function cachedChatToItem(
  cached: ReturnType<ChatsCache['getById']>,
): ChatItem {
  if (!cached) throw new Error('Chat not found')
  return chatRowToItem(cached)
}

export function filterChatsByType(
  chats: CachedChatInput[],
  typeFilter?: ChatType,
): CachedChatInput[] {
  if (!typeFilter) return chats
  return chats.filter((chat) => chat.type === typeFilter)
}

export function getChatType(dialog: any, peer: any): ChatType {
  if (peer._ === 'peerUser') return 'private'
  if (peer._ === 'peerChat') return 'group'
  if (peer._ === 'peerChannel') {
    const chat = dialog.chat || dialog.entity
    if (chat?.megagroup || chat?.gigagroup) return 'supergroup'
    return 'channel'
  }
  return 'private'
}

export function dialogToCacheInput(dialog: any): CachedChatInput {
  const peer = dialog.peer || dialog.raw?.peer
  const chat = dialog.chat || dialog.entity
  const type = getChatType(dialog, peer)

  let chatId: string
  let title: string | null = null
  let username: string | null = null
  let memberCount: number | null = null
  let accessHash: string | null = null

  if (type === 'private') {
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

export function userToPrivateChatCacheInput(user: any): CachedChatInput {
  return {
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
}
