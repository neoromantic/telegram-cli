/**
 * Tests for messages cache service
 */
import { Database } from 'bun:sqlite'
import { beforeEach, describe, expect, it } from 'bun:test'
import {
  createMessagesCache,
  type MessageInput,
  type MessagesCache,
} from '../db/messages-cache'
import { initCacheSchema } from '../db/schema'
import { initSyncSchema } from '../db/sync-schema'

describe('MessagesCache', () => {
  let db: Database
  let cache: MessagesCache

  beforeEach(() => {
    db = new Database(':memory:')
    initCacheSchema(db)
    initSyncSchema(db)
    cache = createMessagesCache(db)
  })

  describe('upsert', () => {
    it('inserts a new message', () => {
      const message: MessageInput = {
        chat_id: 100,
        message_id: 1,
        from_id: 123,
        text: 'Hello world',
        message_type: 'text',
        date: Date.now(),
        raw_json: '{"_":"message"}',
      }

      cache.upsert(message)

      const retrieved = cache.get(100, 1)
      expect(retrieved).not.toBeNull()
      expect(retrieved?.text).toBe('Hello world')
      expect(retrieved?.from_id).toBe(123)
    })

    it('updates an existing message', () => {
      const message: MessageInput = {
        chat_id: 100,
        message_id: 1,
        text: 'Original',
        message_type: 'text',
        date: Date.now(),
        raw_json: '{}',
      }

      cache.upsert(message)
      cache.upsert({ ...message, text: 'Updated', is_edited: true })

      const retrieved = cache.get(100, 1)
      expect(retrieved?.text).toBe('Updated')
      expect(retrieved?.is_edited).toBe(1)
    })
  })

  describe('get', () => {
    it('returns null for non-existent message', () => {
      expect(cache.get(100, 999)).toBeNull()
    })

    it('retrieves message by chat_id and message_id', () => {
      cache.upsert({
        chat_id: 100,
        message_id: 42,
        text: 'Test message',
        message_type: 'text',
        date: Date.now(),
        raw_json: '{}',
      })

      const result = cache.get(100, 42)
      expect(result).not.toBeNull()
      expect(result?.text).toBe('Test message')
    })
  })

  describe('listByChatId', () => {
    beforeEach(() => {
      // Insert test messages
      const baseTime = Date.now()
      for (let i = 1; i <= 5; i++) {
        cache.upsert({
          chat_id: 100,
          message_id: i,
          text: `Message ${i}`,
          message_type: 'text',
          date: baseTime + i * 1000, // Each message 1 second apart
          raw_json: '{}',
        })
      }
    })

    it('returns messages in reverse chronological order', () => {
      const messages = cache.listByChatId(100, { limit: 10 })
      expect(messages).toHaveLength(5)
      expect(messages[0]!.message_id).toBe(5) // Most recent first
      expect(messages[4]!.message_id).toBe(1)
    })

    it('respects limit parameter', () => {
      const messages = cache.listByChatId(100, { limit: 3 })
      expect(messages).toHaveLength(3)
    })

    it('supports offset parameter', () => {
      const messages = cache.listByChatId(100, { limit: 2, offset: 2 })
      expect(messages).toHaveLength(2)
      expect(messages[0]!.message_id).toBe(3)
    })

    it('returns empty array for chat with no messages', () => {
      const messages = cache.listByChatId(999, { limit: 10 })
      expect(messages).toEqual([])
    })
  })

  describe('markDeleted', () => {
    it('marks a single message as deleted', () => {
      cache.upsert({
        chat_id: 100,
        message_id: 1,
        text: 'Will be deleted',
        message_type: 'text',
        date: Date.now(),
        raw_json: '{}',
      })

      cache.markDeleted(100, [1])

      const msg = cache.get(100, 1)
      expect(msg?.is_deleted).toBe(1)
    })

    it('marks multiple messages as deleted', () => {
      for (let i = 1; i <= 3; i++) {
        cache.upsert({
          chat_id: 100,
          message_id: i,
          text: `Message ${i}`,
          message_type: 'text',
          date: Date.now(),
          raw_json: '{}',
        })
      }

      cache.markDeleted(100, [1, 3])

      expect(cache.get(100, 1)?.is_deleted).toBe(1)
      expect(cache.get(100, 2)?.is_deleted).toBe(0)
      expect(cache.get(100, 3)?.is_deleted).toBe(1)
    })
  })

  describe('updateText', () => {
    it('updates message text, sets is_edited flag, and stores edit_date', () => {
      const originalDate = Date.now()
      cache.upsert({
        chat_id: 100,
        message_id: 1,
        text: 'Original text',
        message_type: 'text',
        date: originalDate,
        raw_json: '{}',
      })

      const editDate = originalDate + 60000 // 1 minute later
      cache.updateText(100, 1, 'Edited text', editDate)

      const msg = cache.get(100, 1)
      expect(msg?.text).toBe('Edited text')
      expect(msg?.is_edited).toBe(1)
      expect(msg?.edit_date).toBe(editDate)
    })

    it('stores edit_date on subsequent edits', () => {
      const originalDate = Date.now()
      cache.upsert({
        chat_id: 100,
        message_id: 1,
        text: 'Original text',
        message_type: 'text',
        date: originalDate,
        raw_json: '{}',
      })

      const firstEditDate = originalDate + 60000
      cache.updateText(100, 1, 'First edit', firstEditDate)

      const secondEditDate = originalDate + 120000
      cache.updateText(100, 1, 'Second edit', secondEditDate)

      const msg = cache.get(100, 1)
      expect(msg?.text).toBe('Second edit')
      expect(msg?.is_edited).toBe(1)
      expect(msg?.edit_date).toBe(secondEditDate)
    })
  })

  describe('getLatestMessageId', () => {
    it('returns null for chat with no messages', () => {
      expect(cache.getLatestMessageId(100)).toBeNull()
    })

    it('returns the highest message_id for a chat', () => {
      cache.upsert({
        chat_id: 100,
        message_id: 5,
        text: 'A',
        message_type: 'text',
        date: 1000,
        raw_json: '{}',
      })
      cache.upsert({
        chat_id: 100,
        message_id: 10,
        text: 'B',
        message_type: 'text',
        date: 2000,
        raw_json: '{}',
      })
      cache.upsert({
        chat_id: 100,
        message_id: 3,
        text: 'C',
        message_type: 'text',
        date: 500,
        raw_json: '{}',
      })

      expect(cache.getLatestMessageId(100)).toBe(10)
    })
  })

  describe('getOldestMessageId', () => {
    it('returns null for chat with no messages', () => {
      expect(cache.getOldestMessageId(100)).toBeNull()
    })

    it('returns the lowest message_id for a chat', () => {
      cache.upsert({
        chat_id: 100,
        message_id: 5,
        text: 'A',
        message_type: 'text',
        date: 1000,
        raw_json: '{}',
      })
      cache.upsert({
        chat_id: 100,
        message_id: 10,
        text: 'B',
        message_type: 'text',
        date: 2000,
        raw_json: '{}',
      })
      cache.upsert({
        chat_id: 100,
        message_id: 3,
        text: 'C',
        message_type: 'text',
        date: 500,
        raw_json: '{}',
      })

      expect(cache.getOldestMessageId(100)).toBe(3)
    })
  })

  describe('countByChatId', () => {
    it('returns 0 for chat with no messages', () => {
      expect(cache.countByChatId(100)).toBe(0)
    })

    it('counts messages in a chat', () => {
      for (let i = 1; i <= 5; i++) {
        cache.upsert({
          chat_id: 100,
          message_id: i,
          text: `Msg ${i}`,
          message_type: 'text',
          date: Date.now(),
          raw_json: '{}',
        })
      }

      expect(cache.countByChatId(100)).toBe(5)
    })

    it('excludes deleted messages from count by default', () => {
      for (let i = 1; i <= 5; i++) {
        cache.upsert({
          chat_id: 100,
          message_id: i,
          text: `Msg ${i}`,
          message_type: 'text',
          date: Date.now(),
          raw_json: '{}',
        })
      }
      cache.markDeleted(100, [2, 4])

      expect(cache.countByChatId(100)).toBe(3)
    })
  })

  describe('upsertBatch', () => {
    it('inserts multiple messages in a transaction', () => {
      const messages: MessageInput[] = [
        {
          chat_id: 100,
          message_id: 1,
          text: 'One',
          message_type: 'text',
          date: 1000,
          raw_json: '{}',
        },
        {
          chat_id: 100,
          message_id: 2,
          text: 'Two',
          message_type: 'text',
          date: 2000,
          raw_json: '{}',
        },
        {
          chat_id: 100,
          message_id: 3,
          text: 'Three',
          message_type: 'text',
          date: 3000,
          raw_json: '{}',
        },
      ]

      cache.upsertBatch(messages)

      expect(cache.countByChatId(100)).toBe(3)
      expect(cache.get(100, 2)?.text).toBe('Two')
    })
  })
})
