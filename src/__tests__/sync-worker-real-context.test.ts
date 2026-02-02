/**
 * Tests for sync worker real helpers/context
 */
import type { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import {
  canMakeApiCall,
  getInputPeer,
  getWaitTime,
  recordApiCall,
  resolveFloodWaitResult,
} from '../daemon/sync-worker-real-context'
import {
  buildInputPeer,
  createMessageInputs,
  extractFloodWaitSeconds,
  fetchMessagesRaw,
} from '../daemon/sync-worker-real-helpers'
import { createChatsCache } from '../db/chats-cache'
import { createRateLimitsService } from '../db/rate-limits'
import { createTestCacheDatabase } from '../db/schema'

describe('sync-worker real helpers/context', () => {
  let db: Database

  beforeEach(() => {
    const testDb = createTestCacheDatabase()
    db = testDb.db
  })

  afterEach(() => {
    db.close()
  })

  describe('buildInputPeer', () => {
    it('returns inputPeerUser for missing chat', () => {
      const chatsCache = createChatsCache(db)
      const peer = buildInputPeer(123, chatsCache)

      expect(peer).not.toBeNull()
      expect(peer?._).toBe('inputPeerUser')
      expect(peer?.userId).toBe(123)
      expect(peer?.accessHash).toBe(0n)
    })

    it('returns null for negative chatId without cache entry', () => {
      const chatsCache = createChatsCache(db)
      const peer = buildInputPeer(-42, chatsCache)
      expect(peer).toBeNull()
    })

    it('builds input peers based on cached chat type', () => {
      const chatsCache = createChatsCache(db)
      const now = Date.now()

      chatsCache.upsert({
        chat_id: '1',
        type: 'private',
        title: 'Alice',
        username: 'alice',
        member_count: null,
        access_hash: '999',
        is_creator: 0,
        is_admin: 0,
        last_message_id: null,
        last_message_at: null,
        fetched_at: now,
        raw_json: '{}',
      })

      chatsCache.upsert({
        chat_id: '2',
        type: 'group',
        title: 'Group',
        username: null,
        member_count: 10,
        access_hash: null,
        is_creator: 0,
        is_admin: 0,
        last_message_id: null,
        last_message_at: null,
        fetched_at: now,
        raw_json: '{}',
      })

      chatsCache.upsert({
        chat_id: '3',
        type: 'channel',
        title: 'Channel',
        username: 'channel',
        member_count: 100,
        access_hash: '555',
        is_creator: 0,
        is_admin: 0,
        last_message_id: null,
        last_message_at: null,
        fetched_at: now,
        raw_json: '{}',
      })

      const privatePeer = buildInputPeer(1, chatsCache)
      const groupPeer = buildInputPeer(2, chatsCache)
      const channelPeer = buildInputPeer(3, chatsCache)

      expect(privatePeer?._).toBe('inputPeerUser')
      expect(privatePeer?.accessHash).toBe(999n)
      expect(groupPeer?._).toBe('inputPeerChat')
      expect(groupPeer?.chatId).toBe(2)
      expect(channelPeer?._).toBe('inputPeerChannel')
      expect(channelPeer?.channelId).toBe(3)
      expect(channelPeer?.accessHash).toBe(555n)
    })
  })

  describe('extractFloodWaitSeconds', () => {
    it('extracts seconds from FLOOD_WAIT error message', () => {
      expect(extractFloodWaitSeconds(new Error('FLOOD_WAIT_42'))).toBe(42)
    })

    it('extracts seconds from error.seconds', () => {
      const err = new Error('rate limit') as Error & { seconds?: number }
      err.seconds = 15
      expect(extractFloodWaitSeconds(err)).toBe(15)
    })

    it('returns null when no flood wait present', () => {
      expect(extractFloodWaitSeconds(new Error('OTHER'))).toBeNull()
    })
  })

  describe('createMessageInputs', () => {
    it('creates inputs and updates min/max ids', () => {
      const messages = [
        { _: 'message', id: 10, date: 1700000000, message: 'new' },
        { _: 'messageEmpty', id: 0, date: 0 },
        { _: 'message', id: 5, date: 1699999999, message: 'old' },
      ]

      const result = createMessageInputs(messages, 1, 999, 0)

      expect(result.inputs.length).toBe(2)
      expect(result.minId).toBe(5)
      expect(result.maxId).toBe(10)
    })
  })

  describe('fetchMessagesRaw', () => {
    it('returns messages and count from client.call', async () => {
      const client = {
        call: mock(async (payload: Record<string, unknown>) => {
          expect(payload._).toBe('messages.getHistory')
          expect(payload.offsetId).toBe(5)
          return {
            messages: [{ _: 'message', id: 1, date: 1, message: 'hi' }],
            count: 1,
          }
        }),
      }

      const result = await fetchMessagesRaw(
        client as any,
        { _: 'inputPeerUser', userId: 1, accessHash: 0n },
        { offsetId: 5, limit: 1 },
      )

      expect(result.messages.length).toBe(1)
      expect(result.count).toBe(1)
    })
  })

  describe('sync-worker real context helpers', () => {
    it('records API call and checks wait state', () => {
      const rateLimits = createRateLimitsService(db)
      const ctx = {
        rateLimits,
        config: { apiMethod: 'messages.getHistory' },
        chatsCache: createChatsCache(db),
      } as any

      expect(canMakeApiCall(ctx)).toBe(true)
      recordApiCall(ctx)
      expect(rateLimits.getCallCount('messages.getHistory', 1)).toBe(1)
    })

    it('returns wait time when blocked and resolves flood waits', () => {
      const rateLimits = createRateLimitsService(db)
      const ctx = {
        rateLimits,
        config: { apiMethod: 'messages.getHistory' },
        chatsCache: createChatsCache(db),
      } as any

      rateLimits.setFloodWait('messages.getHistory', 10)
      expect(getWaitTime(ctx)).toBeGreaterThan(0)

      const result = resolveFloodWaitResult(ctx, new Error('FLOOD_WAIT_10'))
      expect(result?.rateLimited).toBe(true)
      expect(rateLimits.isBlocked('messages.getHistory')).toBe(true)
    })

    it('returns null when no flood wait is detected', () => {
      const rateLimits = createRateLimitsService(db)
      const ctx = {
        rateLimits,
        config: { apiMethod: 'messages.getHistory' },
        chatsCache: createChatsCache(db),
      } as any

      const result = resolveFloodWaitResult(ctx, new Error('OTHER'))
      expect(result).toBeNull()
    })

    it('delegates getInputPeer to buildInputPeer', () => {
      const chatsCache = createChatsCache(db)
      const ctx = {
        chatsCache,
        rateLimits: createRateLimitsService(db),
        config: { apiMethod: 'messages.getHistory' },
      } as any

      const inputPeer = getInputPeer(ctx, 77)
      expect(inputPeer?._).toBe('inputPeerUser')
      expect(inputPeer?.userId).toBe(77)
    })
  })
})
