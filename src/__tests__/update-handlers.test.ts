/**
 * Tests for update handlers
 */
import { Database } from 'bun:sqlite'
import { beforeEach, describe, expect, it } from 'bun:test'
import {
  createUpdateHandlers,
  type UpdateContext,
  type UpdateHandlers,
} from '../daemon/handlers'
import { createChatSyncStateService } from '../db/chat-sync-state'
import { createMessagesCache } from '../db/messages-cache'
import { initCacheSchema } from '../db/schema'
import { initSyncSchema } from '../db/sync-schema'

describe('UpdateHandlers', () => {
  let db: Database
  let handlers: UpdateHandlers
  let messagesCache: ReturnType<typeof createMessagesCache>
  let chatSyncState: ReturnType<typeof createChatSyncStateService>

  beforeEach(() => {
    db = new Database(':memory:')
    initCacheSchema(db)
    initSyncSchema(db)
    messagesCache = createMessagesCache(db)
    chatSyncState = createChatSyncStateService(db)
    handlers = createUpdateHandlers({ db, messagesCache, chatSyncState })
  })

  describe('handleNewMessage', () => {
    it('stores a new message in cache', async () => {
      const ctx: UpdateContext = {
        accountId: 1,
        receivedAt: Date.now(),
      }

      await handlers.handleNewMessage(ctx, {
        chatId: 100,
        messageId: 1,
        fromId: 123,
        text: 'Hello, world!',
        date: Date.now(),
        isOutgoing: false,
      })

      const cached = messagesCache.get(100, 1)
      expect(cached).not.toBeNull()
      expect(cached?.text).toBe('Hello, world!')
      expect(cached?.from_id).toBe(123)
    })

    it('updates forward cursor when message is newer', async () => {
      // Set up initial sync state
      chatSyncState.upsert({
        chat_id: 100,
        chat_type: 'private',
        sync_priority: 1,
        sync_enabled: true,
        forward_cursor: 5,
      })

      const ctx: UpdateContext = {
        accountId: 1,
        receivedAt: Date.now(),
      }

      await handlers.handleNewMessage(ctx, {
        chatId: 100,
        messageId: 10, // Newer than cursor
        fromId: 123,
        text: 'New message',
        date: Date.now(),
        isOutgoing: false,
      })

      const state = chatSyncState.get(100)
      expect(state?.forward_cursor).toBe(10)
    })

    it('increments synced messages count', async () => {
      chatSyncState.upsert({
        chat_id: 100,
        chat_type: 'private',
        sync_priority: 1,
        sync_enabled: true,
      })

      const ctx: UpdateContext = {
        accountId: 1,
        receivedAt: Date.now(),
      }

      await handlers.handleNewMessage(ctx, {
        chatId: 100,
        messageId: 1,
        fromId: 123,
        text: 'Message 1',
        date: Date.now(),
        isOutgoing: false,
      })

      await handlers.handleNewMessage(ctx, {
        chatId: 100,
        messageId: 2,
        fromId: 123,
        text: 'Message 2',
        date: Date.now(),
        isOutgoing: false,
      })

      const state = chatSyncState.get(100)
      expect(state?.synced_messages).toBe(2)
    })
  })

  describe('handleEditMessage', () => {
    it('updates message text', async () => {
      // Insert original message
      messagesCache.upsert({
        chat_id: 100,
        message_id: 1,
        text: 'Original text',
        message_type: 'text',
        date: Date.now(),
        raw_json: '{}',
      })

      const ctx: UpdateContext = {
        accountId: 1,
        receivedAt: Date.now(),
      }

      await handlers.handleEditMessage(ctx, {
        chatId: 100,
        messageId: 1,
        newText: 'Edited text',
        editDate: Date.now(),
      })

      const cached = messagesCache.get(100, 1)
      expect(cached?.text).toBe('Edited text')
      expect(cached?.is_edited).toBe(1)
    })
  })

  describe('handleDeleteMessages', () => {
    it('marks messages as deleted', async () => {
      // Insert messages
      messagesCache.upsert({
        chat_id: 100,
        message_id: 1,
        text: 'Message 1',
        message_type: 'text',
        date: Date.now(),
        raw_json: '{}',
      })
      messagesCache.upsert({
        chat_id: 100,
        message_id: 2,
        text: 'Message 2',
        message_type: 'text',
        date: Date.now(),
        raw_json: '{}',
      })

      const ctx: UpdateContext = {
        accountId: 1,
        receivedAt: Date.now(),
      }

      await handlers.handleDeleteMessages(ctx, {
        chatId: 100,
        messageIds: [1, 2],
      })

      expect(messagesCache.get(100, 1)?.is_deleted).toBe(1)
      expect(messagesCache.get(100, 2)?.is_deleted).toBe(1)
    })
  })

  describe('handleBatchMessages', () => {
    it('processes multiple messages efficiently', async () => {
      const ctx: UpdateContext = {
        accountId: 1,
        receivedAt: Date.now(),
      }

      const messages = Array.from({ length: 50 }, (_, i) => ({
        chatId: 100,
        messageId: i + 1,
        fromId: 123,
        text: `Message ${i + 1}`,
        date: Date.now() + i * 1000,
        isOutgoing: false,
      }))

      await handlers.handleBatchMessages(ctx, messages)

      expect(messagesCache.countByChatId(100)).toBe(50)
      expect(messagesCache.get(100, 1)?.text).toBe('Message 1')
      expect(messagesCache.get(100, 50)?.text).toBe('Message 50')
    })
  })
})
