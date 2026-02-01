/**
 * Send message command
 * Handles sending messages to users, groups, and channels
 */
import { defineCommand } from 'citty'

import { getCacheDb } from '../db'
import { createChatsCache } from '../db/chats-cache'
import { createUsersCache } from '../db/users-cache'
import { getClientForAccount } from '../services/telegram'
import { ErrorCodes } from '../types'
import { error, success, verbose } from '../utils/output'

/**
 * Resolve peer from identifier (ID, @username, or phone)
 * Returns the input peer for API calls
 */
async function resolvePeer(
  client: any,
  identifier: string,
  usersCache: ReturnType<typeof createUsersCache>,
  chatsCache: ReturnType<typeof createChatsCache>,
): Promise<{ inputPeer: any; name: string }> {
  // Check if it's a username
  if (identifier.startsWith('@')) {
    const username = identifier.slice(1)

    // Check users cache first
    const cachedUser = usersCache.getByUsername(username)
    if (cachedUser?.access_hash) {
      verbose(`Found user @${username} in cache`)
      return {
        inputPeer: {
          _: 'inputPeerUser',
          userId: Number(cachedUser.user_id),
          accessHash: BigInt(cachedUser.access_hash),
        },
        name: cachedUser.display_name || `@${username}`,
      }
    }

    // Check chats cache
    const cachedChat = chatsCache.getByUsername(username)
    if (cachedChat?.access_hash) {
      verbose(`Found chat @${username} in cache`)
      if (cachedChat.type === 'channel' || cachedChat.type === 'supergroup') {
        return {
          inputPeer: {
            _: 'inputPeerChannel',
            channelId: Number(cachedChat.chat_id),
            accessHash: BigInt(cachedChat.access_hash),
          },
          name: cachedChat.title || `@${username}`,
        }
      }
    }

    // Resolve via API
    verbose(`Resolving @${username} via API...`)
    const resolved = await client.call({
      _: 'contacts.resolveUsername',
      username,
    } as any)

    if (resolved.users && resolved.users.length > 0) {
      const user = resolved.users[0]
      return {
        inputPeer: {
          _: 'inputPeerUser',
          userId: user.id,
          accessHash: BigInt(user.accessHash || 0),
        },
        name:
          [user.firstName, user.lastName].filter(Boolean).join(' ') ||
          `@${username}`,
      }
    }

    if (resolved.chats && resolved.chats.length > 0) {
      const chat = resolved.chats[0]
      return {
        inputPeer: {
          _: 'inputPeerChannel',
          channelId: chat.id,
          accessHash: BigInt(chat.accessHash || 0),
        },
        name: chat.title || `@${username}`,
      }
    }

    throw new Error(`Could not resolve @${username}`)
  }

  // Check if it's a phone number
  if (identifier.startsWith('+') || /^\d{10,}$/.test(identifier)) {
    const phone = identifier.replace(/[\s\-+()]/g, '')

    // Check users cache
    const cachedUser = usersCache.getByPhone(phone)
    if (cachedUser?.access_hash) {
      verbose(`Found user with phone ${identifier} in cache`)
      return {
        inputPeer: {
          _: 'inputPeerUser',
          userId: Number(cachedUser.user_id),
          accessHash: BigInt(cachedUser.access_hash),
        },
        name: cachedUser.display_name || identifier,
      }
    }

    // Try to resolve via contacts.resolvePhone
    verbose(`Resolving phone ${identifier} via API...`)
    try {
      const resolved = await client.call({
        _: 'contacts.resolvePhone',
        phone,
      } as any)

      if (resolved.users && resolved.users.length > 0) {
        const user = resolved.users[0]
        return {
          inputPeer: {
            _: 'inputPeerUser',
            userId: user.id,
            accessHash: BigInt(user.accessHash || 0),
          },
          name:
            [user.firstName, user.lastName].filter(Boolean).join(' ') ||
            identifier,
        }
      }
    } catch {
      throw new Error(`Could not resolve phone number ${identifier}`)
    }

    throw new Error(`Could not resolve phone number ${identifier}`)
  }

  // It's a numeric ID
  const numericId = Number.parseInt(identifier, 10)
  if (Number.isNaN(numericId)) {
    throw new Error(`Invalid peer identifier: ${identifier}`)
  }

  // Check users cache
  const cachedUser = usersCache.getById(identifier)
  if (cachedUser?.access_hash) {
    verbose(`Found user ID ${identifier} in cache`)
    return {
      inputPeer: {
        _: 'inputPeerUser',
        userId: numericId,
        accessHash: BigInt(cachedUser.access_hash),
      },
      name: cachedUser.display_name || `User ${numericId}`,
    }
  }

  // Check chats cache
  const cachedChat = chatsCache.getById(identifier)
  if (cachedChat) {
    verbose(`Found chat ID ${identifier} in cache`)
    if (cachedChat.type === 'private') {
      // It's actually a user
      return {
        inputPeer: {
          _: 'inputPeerUser',
          userId: numericId,
          accessHash: BigInt(cachedChat.access_hash || 0),
        },
        name: cachedChat.title || `User ${numericId}`,
      }
    }
    if (cachedChat.type === 'group') {
      return {
        inputPeer: {
          _: 'inputPeerChat',
          chatId: numericId,
        },
        name: cachedChat.title || `Group ${numericId}`,
      }
    }
    // channel or supergroup
    return {
      inputPeer: {
        _: 'inputPeerChannel',
        channelId: numericId,
        accessHash: BigInt(cachedChat.access_hash || 0),
      },
      name: cachedChat.title || `Channel ${numericId}`,
    }
  }

  // Try as basic chat (legacy group)
  return {
    inputPeer: {
      _: 'inputPeerChat',
      chatId: numericId,
    },
    name: `Chat ${numericId}`,
  }
}

/**
 * Send message command
 */
export const sendCommand = defineCommand({
  meta: {
    name: 'send',
    description: 'Send a message to a user, group, or channel',
  },
  args: {
    to: {
      type: 'string',
      description: 'Recipient: user ID, @username, or phone number',
      required: true,
    },
    message: {
      type: 'string',
      alias: 'm',
      description: 'Message text to send',
      required: true,
    },
    account: {
      type: 'string',
      description: 'Account ID (uses active account if not specified)',
    },
    silent: {
      type: 'boolean',
      description: 'Send without notification sound',
      default: false,
    },
    'reply-to': {
      type: 'string',
      description: 'Message ID to reply to',
    },
  },
  async run({ args }) {
    const recipient = args.to
    const messageText = args.message
    const accountId = args.account
      ? Number.parseInt(args.account, 10)
      : undefined
    const silent = args.silent ?? false
    const replyTo = args['reply-to']
      ? Number.parseInt(args['reply-to'], 10)
      : undefined

    if (!messageText || messageText.trim() === '') {
      error(ErrorCodes.INVALID_ARGS, 'Message text cannot be empty')
    }

    try {
      const cacheDb = getCacheDb()
      const usersCache = createUsersCache(cacheDb)
      const chatsCache = createChatsCache(cacheDb)

      const client = getClientForAccount(accountId)

      // Resolve the recipient
      verbose(`Resolving recipient: ${recipient}`)
      const { inputPeer, name } = await resolvePeer(
        client,
        recipient,
        usersCache,
        chatsCache,
      )

      verbose(`Sending message to ${name}...`)

      // Generate random message ID
      const randomId = BigInt(
        Math.floor(Math.random() * Number.MAX_SAFE_INTEGER),
      )

      // Build the request
      const request: any = {
        _: 'messages.sendMessage',
        peer: inputPeer,
        message: messageText,
        randomId,
        noWebpage: false,
        silent,
      }

      // Add reply_to if specified
      if (replyTo) {
        request.replyTo = {
          _: 'inputReplyToMessage',
          replyToMsgId: replyTo,
        }
      }

      // Send the message
      const result = await client.call(request)

      // Extract message info from result
      let messageId: number | null = null
      let timestamp: number | null = null

      if (result._ === 'updateShortSentMessage') {
        messageId = result.id
        timestamp = result.date
      } else if (result.updates) {
        // Look for the message in updates
        for (const update of result.updates) {
          if (
            update._ === 'updateMessageID' ||
            update._ === 'updateNewMessage' ||
            update._ === 'updateNewChannelMessage'
          ) {
            messageId = update.id ?? update.message?.id
            timestamp = update.date ?? update.message?.date
            break
          }
        }
      }

      success({
        sent: true,
        to: {
          identifier: recipient,
          name,
        },
        messageId,
        timestamp: timestamp ? timestamp * 1000 : Date.now(),
        replyTo: replyTo ?? null,
        silent,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'

      // Check for specific Telegram errors
      if (message.includes('PEER_ID_INVALID')) {
        error(
          ErrorCodes.TELEGRAM_ERROR,
          `Invalid recipient: ${recipient}. Make sure the user/chat exists and you have access to it.`,
        )
      }
      if (message.includes('USER_IS_BOT')) {
        error(
          ErrorCodes.TELEGRAM_ERROR,
          'Cannot send messages to bots this way.',
        )
      }
      if (message.includes('CHAT_WRITE_FORBIDDEN')) {
        error(
          ErrorCodes.TELEGRAM_ERROR,
          'You do not have permission to send messages in this chat.',
        )
      }

      error(ErrorCodes.TELEGRAM_ERROR, `Failed to send message: ${message}`)
    }
  },
})
