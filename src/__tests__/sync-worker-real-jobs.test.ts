/**
 * Tests for sync worker real job handlers
 */
import type { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import {
  processBackwardHistoryReal,
  processForwardCatchupReal,
  processInitialLoadReal,
  processJobReal,
} from '../daemon/sync-worker-real-jobs'
import type { RealSyncWorkerContext } from '../daemon/sync-worker-real-types'
import { createChatSyncStateService } from '../db/chat-sync-state'
import { createChatsCache } from '../db/chats-cache'
import { createMessagesCache } from '../db/messages-cache'
import { createRateLimitsService } from '../db/rate-limits'
import { createTestCacheDatabase } from '../db/schema'
import { createSyncJobsService } from '../db/sync-jobs'
import { initSyncSchema, SyncJobType, SyncPriority } from '../db/sync-schema'

describe('sync-worker real jobs', () => {
  let db: Database
  let ctx: RealSyncWorkerContext

  beforeEach(() => {
    const testDb = createTestCacheDatabase()
    db = testDb.db
    initSyncSchema(db)

    ctx = {
      client: { call: mock(async () => ({ messages: [] })) } as any,
      messagesCache: createMessagesCache(db),
      chatSyncState: createChatSyncStateService(db),
      jobsService: createSyncJobsService(db),
      rateLimits: createRateLimitsService(db),
      chatsCache: createChatsCache(db),
      config: {
        apiMethod: 'messages.getHistory',
        batchSize: 2,
      },
    }
  })

  afterEach(() => {
    db.close()
  })

  it('returns rate limited when API calls are blocked (forward catchup)', async () => {
    const job = ctx.jobsService.create({
      chat_id: 1,
      job_type: SyncJobType.ForwardCatchup,
      priority: SyncPriority.High,
    })

    ctx.rateLimits.setFloodWait(ctx.config.apiMethod, 10)

    const result = await processForwardCatchupReal(ctx, job)

    expect(result.rateLimited).toBe(true)
    expect(result.waitSeconds).toBeGreaterThan(0)
  })

  it('returns error when input peer is missing (forward catchup)', async () => {
    const job = ctx.jobsService.create({
      chat_id: -123,
      job_type: SyncJobType.ForwardCatchup,
      priority: SyncPriority.High,
    })

    const result = await processForwardCatchupReal(ctx, job)

    expect(result.success).toBe(false)
    expect(result.error).toContain('InputPeer')
  })

  it('processes forward catchup and updates cursors + progress', async () => {
    const chatId = 42
    ctx.chatSyncState.upsert({
      chat_id: chatId,
      chat_type: 'private',
      sync_priority: SyncPriority.High,
      sync_enabled: true,
      forward_cursor: 5,
    })

    const job = ctx.jobsService.create({
      chat_id: chatId,
      job_type: SyncJobType.ForwardCatchup,
      priority: SyncPriority.High,
    })

    const clientCall = mock(async (payload: Record<string, unknown>) => {
      expect(payload.minId).toBe(5)
      expect(payload.limit).toBe(2)
      return {
        messages: [
          { _: 'message', id: 6, date: 1700000000, message: 'one' },
          { _: 'message', id: 7, date: 1700000001, message: 'two' },
        ],
      }
    })

    ctx.client = { call: clientCall } as any

    const result = await processForwardCatchupReal(ctx, job)

    expect(result.success).toBe(true)
    expect(result.messagesFetched).toBe(2)
    expect(result.hasMore).toBe(true)
    expect(result.newCursor).toBe(7)

    const state = ctx.chatSyncState.get(chatId)
    expect(state?.forward_cursor).toBe(7)
    expect(state?.synced_messages).toBe(2)

    const updatedJob = ctx.jobsService.getById(job.id)
    expect(updatedJob?.messages_fetched).toBe(2)
    expect(updatedJob?.cursor_end).toBe(7)

    expect(ctx.messagesCache.countByChatId(chatId)).toBe(2)
  })

  it('skips backward history when history is already complete', async () => {
    const chatId = 7
    ctx.chatSyncState.upsert({
      chat_id: chatId,
      chat_type: 'private',
      sync_priority: SyncPriority.High,
      sync_enabled: true,
    })
    ctx.chatSyncState.markHistoryComplete(chatId)

    const job = ctx.jobsService.create({
      chat_id: chatId,
      job_type: SyncJobType.BackwardHistory,
      priority: SyncPriority.High,
    })

    const result = await processBackwardHistoryReal(ctx, job)

    expect(result.success).toBe(true)
    expect(result.historyComplete).toBe(true)
    expect(result.messagesFetched).toBe(0)
  })

  it('uses oldest cached message id when backward cursor is unset', async () => {
    const chatId = 99
    ctx.chatSyncState.upsert({
      chat_id: chatId,
      chat_type: 'private',
      sync_priority: SyncPriority.High,
      sync_enabled: true,
    })

    ctx.messagesCache.upsert({
      chat_id: chatId,
      message_id: 20,
      message_type: 'text',
      date: 1700000000,
      raw_json: '{}',
    })

    const job = ctx.jobsService.create({
      chat_id: chatId,
      job_type: SyncJobType.BackwardHistory,
      priority: SyncPriority.High,
    })

    const clientCall = mock(async (payload: Record<string, unknown>) => {
      expect(payload.offsetId).toBe(20)
      return {
        messages: [{ _: 'message', id: 15, date: 1699999999, message: 'old' }],
      }
    })

    ctx.client = { call: clientCall } as any
    ctx.config.batchSize = 5

    const result = await processBackwardHistoryReal(ctx, job)

    expect(result.success).toBe(true)
    expect(result.historyComplete).toBe(true)
    expect(result.newCursor).toBe(15)

    const state = ctx.chatSyncState.get(chatId)
    expect(state?.backward_cursor).toBe(15)
    expect(state?.history_complete).toBe(1)
  })

  it('marks history complete when backward history returns empty', async () => {
    const chatId = 101
    ctx.chatSyncState.upsert({
      chat_id: chatId,
      chat_type: 'private',
      sync_priority: SyncPriority.High,
      sync_enabled: true,
    })

    const job = ctx.jobsService.create({
      chat_id: chatId,
      job_type: SyncJobType.BackwardHistory,
      priority: SyncPriority.High,
    })

    const clientCall = mock(async () => ({ messages: [] }))
    ctx.client = { call: clientCall } as any

    const result = await processBackwardHistoryReal(ctx, job)

    expect(result.success).toBe(true)
    expect(result.historyComplete).toBe(true)

    const state = ctx.chatSyncState.get(chatId)
    expect(state?.history_complete).toBe(1)
  })

  it('initial load updates cursors and marks history complete when batch is short', async () => {
    const chatId = 55
    ctx.chatSyncState.upsert({
      chat_id: chatId,
      chat_type: 'private',
      sync_priority: SyncPriority.High,
      sync_enabled: true,
    })

    const job = ctx.jobsService.create({
      chat_id: chatId,
      job_type: SyncJobType.InitialLoad,
      priority: SyncPriority.High,
    })

    const clientCall = mock(async () => ({
      messages: [{ _: 'message', id: 3, date: 1700000002, message: 'a' }],
    }))
    ctx.client = { call: clientCall } as any
    ctx.config.batchSize = 5

    const result = await processInitialLoadReal(ctx, job)

    expect(result.success).toBe(true)
    expect(result.historyComplete).toBe(true)
    expect(result.newCursor).toBe(3)

    const state = ctx.chatSyncState.get(chatId)
    expect(state?.forward_cursor).toBe(3)
    expect(state?.backward_cursor).toBe(3)
    expect(state?.history_complete).toBe(1)
  })

  it('marks job failed for unknown job type', async () => {
    const job = ctx.jobsService.create({
      chat_id: 1,
      job_type: 'BogusType' as SyncJobType,
      priority: SyncPriority.High,
    })

    const result = await processJobReal(ctx, job)

    expect(result.success).toBe(false)
    expect(result.error).toContain('Unknown job type')

    const stored = ctx.jobsService.getById(job.id)
    expect(stored?.status).toBe('failed')
    expect(stored?.error_message).toContain('Unknown job type')
  })
})
