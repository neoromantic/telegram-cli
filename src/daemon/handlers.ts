/**
 * Update handlers for processing Telegram events
 * Handles new messages, edits, deletions, and other updates
 */
import type { Database } from 'bun:sqlite'
import type { ChatSyncStateService } from '../db/chat-sync-state'
import type { MessageInput, MessagesCache } from '../db/messages-cache'
import { determineSyncPolicy, type SyncChatType } from '../db/sync-schema'
import type { DaemonLogger } from './types'

/**
 * Context for update processing
 */
export interface UpdateContext {
  /** Account that received the update */
  accountId: number
  /** Timestamp when update was received */
  receivedAt: number
}

/**
 * New message update data
 */
export interface NewMessageData {
  chatId: number
  messageId: number
  fromId?: number
  text?: string
  date: number
  isOutgoing: boolean
  replyToId?: number
  forwardFromId?: number
  messageType?: string
  hasMedia?: boolean
  isPinned?: boolean
}

/**
 * Edit message update data
 */
export interface EditMessageData {
  chatId: number
  messageId: number
  newText: string
  editDate: number
}

/**
 * Delete messages update data (with known chat ID, e.g., channels)
 */
export interface DeleteMessagesData {
  chatId: number
  messageIds: number[]
}

/**
 * Delete messages update data (without chat ID, e.g., DMs and basic groups)
 * For non-channel chats, mtcute only provides message IDs without the chat context.
 * The handler must look up the chat ID from the messages cache.
 */
export interface DeleteMessagesWithoutChatData {
  messageIds: number[]
}

/**
 * Update handlers interface
 */
export interface UpdateHandlers {
  /** Handle a new message */
  handleNewMessage(_ctx: UpdateContext, data: NewMessageData): Promise<void>
  /** Handle a message edit */
  handleEditMessage(_ctx: UpdateContext, data: EditMessageData): Promise<void>
  /** Handle message deletions (with known chat ID, e.g., channels) */
  handleDeleteMessages(
    _ctx: UpdateContext,
    data: DeleteMessagesData,
  ): Promise<void>
  /** Handle message deletions without chat ID (DMs and basic groups) */
  handleDeleteMessagesWithoutChat(
    _ctx: UpdateContext,
    data: DeleteMessagesWithoutChatData,
  ): Promise<number>
  /** Handle a batch of messages (for history sync) */
  handleBatchMessages(
    _ctx: UpdateContext,
    messages: NewMessageData[],
  ): Promise<void>
}

/**
 * Options for creating update handlers
 */
export interface UpdateHandlersOptions {
  db: Database
  messagesCache: MessagesCache
  chatSyncState: ChatSyncStateService
  logger?: DaemonLogger
}

/**
 * Default no-op logger for when logging is not needed
 */
const noopLogger: DaemonLogger = {
  info: () => {},
  debug: () => {},
  warn: () => {},
  error: () => {},
}

/**
 * Create update handlers
 */
export function createUpdateHandlers(
  options: UpdateHandlersOptions,
): UpdateHandlers {
  const { messagesCache, chatSyncState, logger = noopLogger } = options

  /**
   * Convert new message data to message input
   */
  function toMessageInput(data: NewMessageData): MessageInput {
    return {
      chat_id: data.chatId,
      message_id: data.messageId,
      from_id: data.fromId,
      text: data.text,
      message_type: data.messageType ?? 'text',
      date: data.date,
      is_outgoing: data.isOutgoing,
      reply_to_id: data.replyToId,
      forward_from_id: data.forwardFromId,
      has_media: data.hasMedia,
      is_pinned: data.isPinned,
      raw_json: '{}', // TODO: Store actual raw JSON when available
    }
  }

  /**
   * Ensure sync state exists for a chat
   */
  function ensureSyncState(
    chatId: number,
    chatType: SyncChatType = 'private',
  ): void {
    const existing = chatSyncState.get(chatId)
    if (!existing) {
      const policy = determineSyncPolicy(chatType)
      chatSyncState.upsert({
        chat_id: chatId,
        chat_type: chatType,
        sync_priority: policy.priority,
        sync_enabled: policy.enabled,
      })
    }
  }

  /**
   * Update forward cursor if message is newer
   */
  function updateForwardCursor(chatId: number, messageId: number): void {
    const state = chatSyncState.get(chatId)
    if (
      state &&
      (state.forward_cursor === null || messageId > state.forward_cursor)
    ) {
      chatSyncState.updateCursors(chatId, { forward_cursor: messageId })
    }
  }

  return {
    async handleNewMessage(
      __ctx: UpdateContext,
      data: NewMessageData,
    ): Promise<void> {
      try {
        // Ensure sync state exists
        ensureSyncState(data.chatId)

        // Store message
        const input = toMessageInput(data)
        messagesCache.upsert(input)

        // Update forward cursor
        updateForwardCursor(data.chatId, data.messageId)

        // Increment synced messages count
        chatSyncState.incrementSyncedMessages(data.chatId, 1)

        // Update last sync timestamp
        chatSyncState.updateLastSync(data.chatId, 'forward')
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err)
        logger.error(
          `Failed to handle new message: chatId=${data.chatId}, messageId=${data.messageId}, error=${errorMessage}`,
        )
        // Don't re-throw - let daemon continue processing other updates
      }
    },

    async handleEditMessage(
      _ctx: UpdateContext,
      data: EditMessageData,
    ): Promise<void> {
      try {
        // Update message text and edit_date
        messagesCache.updateText(
          data.chatId,
          data.messageId,
          data.newText,
          data.editDate,
        )
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err)
        logger.error(
          `Failed to handle edit message: chatId=${data.chatId}, messageId=${data.messageId}, error=${errorMessage}`,
        )
        // Don't re-throw - let daemon continue processing other updates
      }
    },

    async handleDeleteMessages(
      _ctx: UpdateContext,
      data: DeleteMessagesData,
    ): Promise<void> {
      try {
        // Mark messages as deleted
        messagesCache.markDeleted(data.chatId, data.messageIds)
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err)
        logger.error(
          `Failed to handle delete messages: chatId=${data.chatId}, messageIds=[${data.messageIds.join(',')}], error=${errorMessage}`,
        )
        // Don't re-throw - let daemon continue processing other updates
      }
    },

    async handleDeleteMessagesWithoutChat(
      _ctx: UpdateContext,
      data: DeleteMessagesWithoutChatData,
    ): Promise<number> {
      // For DMs and basic groups, mtcute doesn't provide the chat ID.
      // We look up the chat from our messages cache and mark them deleted.
      return messagesCache.markDeletedByMessageIds(data.messageIds)
    },

    async handleBatchMessages(
      _ctx: UpdateContext,
      messages: NewMessageData[],
    ): Promise<void> {
      if (messages.length === 0) return

      // Group by chat
      const byChatId = new Map<number, NewMessageData[]>()
      for (const msg of messages) {
        const existing = byChatId.get(msg.chatId) ?? []
        existing.push(msg)
        byChatId.set(msg.chatId, existing)
      }

      // Process each chat - continue processing other chats if one fails
      for (const [chatId, chatMessages] of byChatId) {
        try {
          // Ensure sync state exists
          ensureSyncState(chatId)

          // Convert to message inputs
          const inputs = chatMessages.map(toMessageInput)

          // Batch insert
          messagesCache.upsertBatch(inputs)

          // Find min/max message IDs
          const messageIds = chatMessages.map((m) => m.messageId)
          const maxId = Math.max(...messageIds)
          const minId = Math.min(...messageIds)

          // Update cursors
          const state = chatSyncState.get(chatId)
          if (state) {
            // Update forward cursor if we have newer messages
            if (state.forward_cursor === null || maxId > state.forward_cursor) {
              chatSyncState.updateCursors(chatId, { forward_cursor: maxId })
            }

            // Update backward cursor if we have older messages
            if (
              state.backward_cursor === null ||
              minId < state.backward_cursor
            ) {
              chatSyncState.updateCursors(chatId, { backward_cursor: minId })
            }
          }

          // Update synced count
          chatSyncState.incrementSyncedMessages(chatId, chatMessages.length)
        } catch (err) {
          const errorMessage = err instanceof Error ? err.message : String(err)
          const messageIds = chatMessages.map((m) => m.messageId)
          logger.error(
            `Failed to handle batch messages: chatId=${chatId}, messageCount=${chatMessages.length}, messageIds=[${messageIds.slice(0, 5).join(',')}${messageIds.length > 5 ? '...' : ''}], error=${errorMessage}`,
          )
          // Don't re-throw - continue processing other chats
        }
      }
    },
  }
}
