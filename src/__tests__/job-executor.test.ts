/**
 * Tests for job executor with inter-batch delays
 */
import { Database } from 'bun:sqlite'
import { beforeEach, describe, expect, it, mock } from 'bun:test'
import {
  type BatchFetcher,
  type BatchResult,
  createJobExecutor,
  type JobExecutor,
} from '../daemon/job-executor'
import { createSyncScheduler, type SyncScheduler } from '../daemon/scheduler'
import { DEFAULT_SYNC_DELAYS } from '../daemon/types'
import { createChatSyncStateService } from '../db/chat-sync-state'
import { createMessagesCache } from '../db/messages-cache'
import { initCacheSchema } from '../db/schema'
import { createSyncJobsService } from '../db/sync-jobs'
import { initSyncSchema, SyncJobType, SyncPriority } from '../db/sync-schema'

describe('JobExecutor', () => {
  let db: Database
  let scheduler: SyncScheduler
  let jobsService: ReturnType<typeof createSyncJobsService>
  let chatSyncState: ReturnType<typeof createChatSyncStateService>
  let messagesCache: ReturnType<typeof createMessagesCache>
  let executor: JobExecutor
  let mockFetcher: BatchFetcher

  beforeEach(() => {
    db = new Database(':memory:')
    initCacheSchema(db)
    initSyncSchema(db)
    jobsService = createSyncJobsService(db)
    chatSyncState = createChatSyncStateService(db)
    messagesCache = createMessagesCache(db)
    scheduler = createSyncScheduler({
      db,
      jobsService,
      chatSyncState,
      messagesCache,
    })

    // Default mock fetcher that returns one batch and then stops
    mockFetcher = mock(
      async (): Promise<BatchResult> => ({
        messagesFetched: 10,
        hasMore: false,
      }),
    )

    executor = createJobExecutor(scheduler, mockFetcher, {
      interBatchDelayMs: 0, // No delay for tests
      interJobDelayMs: 0,
    })
  })

  describe('configuration', () => {
    it('uses default delays when not specified', () => {
      const defaultExecutor = createJobExecutor(scheduler, mockFetcher)
      const config = defaultExecutor.getConfig()

      expect(config.interBatchDelayMs).toBe(
        DEFAULT_SYNC_DELAYS.interBatchDelayMs,
      )
      expect(config.interJobDelayMs).toBe(DEFAULT_SYNC_DELAYS.interJobDelayMs)
    })

    it('allows custom delays', () => {
      const customExecutor = createJobExecutor(scheduler, mockFetcher, {
        interBatchDelayMs: 500,
        interJobDelayMs: 1500,
      })
      const config = customExecutor.getConfig()

      expect(config.interBatchDelayMs).toBe(500)
      expect(config.interJobDelayMs).toBe(1500)
    })

    it('allows updating configuration', () => {
      executor.updateConfig({
        interBatchDelayMs: 200,
        interJobDelayMs: 600,
      })
      const config = executor.getConfig()

      expect(config.interBatchDelayMs).toBe(200)
      expect(config.interJobDelayMs).toBe(600)
    })
  })

  describe('executeJob', () => {
    it('executes a single batch job', async () => {
      const job = jobsService.create({
        chat_id: 100,
        job_type: SyncJobType.ForwardCatchup,
        priority: SyncPriority.High,
      })

      const result = await executor.executeJob(job)

      expect(result.success).toBe(true)
      expect(result.totalMessagesFetched).toBe(10)
      expect(result.batchesProcessed).toBe(1)
      expect(result.hasMoreWork).toBe(false)
    })

    it('executes multiple batches with pagination', async () => {
      let callCount = 0
      const paginatedFetcher: BatchFetcher = mock(
        async (_job, cursor): Promise<BatchResult> => {
          callCount++
          if (callCount < 3) {
            return {
              messagesFetched: 10,
              nextCursor: (cursor ?? 0) + 10,
              hasMore: true,
            }
          }
          return {
            messagesFetched: 5,
            hasMore: false,
          }
        },
      )

      executor = createJobExecutor(scheduler, paginatedFetcher, {
        interBatchDelayMs: 0,
        interJobDelayMs: 0,
      })

      const job = jobsService.create({
        chat_id: 100,
        job_type: SyncJobType.BackwardHistory,
        priority: SyncPriority.Background,
      })

      const result = await executor.executeJob(job)

      expect(result.success).toBe(true)
      expect(result.totalMessagesFetched).toBe(25) // 10 + 10 + 5
      expect(result.batchesProcessed).toBe(3)
    })

    it('marks job as failed on error', async () => {
      const failingFetcher: BatchFetcher = mock(async (): Promise<never> => {
        throw new Error('API error')
      })

      executor = createJobExecutor(scheduler, failingFetcher, {
        interBatchDelayMs: 0,
        interJobDelayMs: 0,
      })

      const job = jobsService.create({
        chat_id: 100,
        job_type: SyncJobType.ForwardCatchup,
        priority: SyncPriority.High,
      })

      const result = await executor.executeJob(job)

      expect(result.success).toBe(false)
      expect(result.error).toBe('API error')

      const updatedJob = jobsService.getById(job.id)
      expect(updatedJob?.status).toBe('failed')
      expect(updatedJob?.error_message).toBe('API error')
    })

    it('respects maxBatchesPerJob limit', async () => {
      let callCount = 0
      const infiniteFetcher: BatchFetcher = mock(
        async (): Promise<BatchResult> => {
          callCount++
          return {
            messagesFetched: 10,
            nextCursor: callCount * 10,
            hasMore: true, // Always has more
          }
        },
      )

      executor = createJobExecutor(scheduler, infiniteFetcher, {
        interBatchDelayMs: 0,
        interJobDelayMs: 0,
        maxBatchesPerJob: 5,
      })

      const job = jobsService.create({
        chat_id: 100,
        job_type: SyncJobType.BackwardHistory,
        priority: SyncPriority.Background,
      })

      const result = await executor.executeJob(job)

      expect(result.batchesProcessed).toBe(5)
      expect(result.hasMoreWork).toBe(true)
    })

    it('updates progress during execution', async () => {
      let callCount = 0
      const paginatedFetcher: BatchFetcher = mock(
        async (_job, cursor): Promise<BatchResult> => {
          callCount++
          return {
            messagesFetched: 10,
            nextCursor: (cursor ?? 0) + 10,
            hasMore: callCount < 2,
          }
        },
      )

      executor = createJobExecutor(scheduler, paginatedFetcher, {
        interBatchDelayMs: 0,
        interJobDelayMs: 0,
      })

      const job = jobsService.create({
        chat_id: 100,
        job_type: SyncJobType.BackwardHistory,
        priority: SyncPriority.Background,
      })

      await executor.executeJob(job)

      // Check that progress was updated
      const updatedJob = jobsService.getById(job.id)
      expect(updatedJob?.messages_fetched).toBe(20)
      expect(updatedJob?.cursor_end).toBe(20)
    })
  })

  describe('processNextJob', () => {
    it('returns null when no jobs available', async () => {
      const result = await executor.processNextJob()
      expect(result).toBeNull()
    })

    it('processes the next available job', async () => {
      jobsService.create({
        chat_id: 100,
        job_type: SyncJobType.ForwardCatchup,
        priority: SyncPriority.High,
      })

      const result = await executor.processNextJob()

      expect(result).not.toBeNull()
      expect(result?.success).toBe(true)
    })
  })

  describe('inter-batch delay', () => {
    it('applies delay between batches', async () => {
      let callCount = 0
      const callTimes: number[] = []

      const timedFetcher: BatchFetcher = mock(
        async (): Promise<BatchResult> => {
          callCount++
          callTimes.push(Date.now())
          return {
            messagesFetched: 10,
            hasMore: callCount < 3,
          }
        },
      )

      executor = createJobExecutor(scheduler, timedFetcher, {
        interBatchDelayMs: 50, // 50ms delay
        interJobDelayMs: 0,
      })

      const job = jobsService.create({
        chat_id: 100,
        job_type: SyncJobType.BackwardHistory,
        priority: SyncPriority.Background,
      })

      await executor.executeJob(job)

      // Check that delays were applied between calls
      // First call should be immediate, subsequent calls delayed
      expect(callTimes.length).toBe(3)
      // Allow some tolerance for timing
      if (callTimes.length >= 2) {
        const gap1 = callTimes[1]! - callTimes[0]!
        expect(gap1).toBeGreaterThanOrEqual(40) // 50ms - tolerance
      }
      if (callTimes.length >= 3) {
        const gap2 = callTimes[2]! - callTimes[1]!
        expect(gap2).toBeGreaterThanOrEqual(40)
      }
    })
  })

  describe('inter-job delay', () => {
    it('applies delay between jobs', async () => {
      const jobTimes: number[] = []
      const timedFetcher: BatchFetcher = mock(
        async (): Promise<BatchResult> => {
          jobTimes.push(Date.now())
          return { messagesFetched: 10, hasMore: false }
        },
      )

      executor = createJobExecutor(scheduler, timedFetcher, {
        interBatchDelayMs: 0,
        interJobDelayMs: 50, // 50ms delay between jobs
      })

      // Create two jobs
      jobsService.create({
        chat_id: 100,
        job_type: SyncJobType.ForwardCatchup,
        priority: SyncPriority.High,
      })
      jobsService.create({
        chat_id: 200,
        job_type: SyncJobType.ForwardCatchup,
        priority: SyncPriority.High,
      })

      // Process both jobs
      await executor.processNextJob()
      await executor.processNextJob()

      expect(jobTimes.length).toBe(2)
      const gap = jobTimes[1]! - jobTimes[0]!
      expect(gap).toBeGreaterThanOrEqual(40) // 50ms - tolerance
    })
  })

  describe('run and stop', () => {
    it('can be stopped', async () => {
      // Create some jobs
      for (let i = 0; i < 5; i++) {
        jobsService.create({
          chat_id: i,
          job_type: SyncJobType.ForwardCatchup,
          priority: SyncPriority.High,
        })
      }

      let jobsProcessed = 0
      const countingFetcher: BatchFetcher = mock(
        async (): Promise<BatchResult> => {
          jobsProcessed++
          return { messagesFetched: 1, hasMore: false }
        },
      )

      executor = createJobExecutor(scheduler, countingFetcher, {
        interBatchDelayMs: 0,
        interJobDelayMs: 0,
      })

      // Start executor in background
      const runPromise = executor.run()

      // Let it process some jobs
      await Bun.sleep(50)

      // Stop it
      executor.requestStop()
      await runPromise

      // Should have processed some but not necessarily all jobs
      expect(jobsProcessed).toBeGreaterThan(0)
      expect(executor.isRunning()).toBe(false)
    })
  })
})
