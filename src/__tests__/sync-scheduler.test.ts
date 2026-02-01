/**
 * Tests for sync scheduler
 */
import { Database } from 'bun:sqlite'
import { beforeEach, describe, expect, it } from 'bun:test'
import { createSyncScheduler, type SyncScheduler } from '../daemon/scheduler'
import { createChatSyncStateService } from '../db/chat-sync-state'
import { createMessagesCache } from '../db/messages-cache'
import { initCacheSchema } from '../db/schema'
import { createSyncJobsService } from '../db/sync-jobs'
import {
  initSyncSchema,
  SyncJobStatus,
  SyncJobType,
  SyncPriority,
} from '../db/sync-schema'

describe('SyncScheduler', () => {
  let db: Database
  let scheduler: SyncScheduler
  let jobsService: ReturnType<typeof createSyncJobsService>
  let chatSyncState: ReturnType<typeof createChatSyncStateService>
  let messagesCache: ReturnType<typeof createMessagesCache>

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
  })

  describe('queueForwardCatchup', () => {
    it('queues forward catchup job for a chat', () => {
      chatSyncState.upsert({
        chat_id: 100,
        chat_type: 'private',
        sync_priority: SyncPriority.High,
        sync_enabled: true,
      })

      scheduler.queueForwardCatchup(100)

      const jobs = jobsService.getJobsForChat(100)
      expect(jobs).toHaveLength(1)
      expect(jobs[0]!.job_type).toBe(SyncJobType.ForwardCatchup)
      expect(jobs[0]!.priority).toBe(SyncPriority.Realtime)
    })

    it('does not queue duplicate catchup job', () => {
      chatSyncState.upsert({
        chat_id: 100,
        chat_type: 'private',
        sync_priority: SyncPriority.High,
        sync_enabled: true,
      })

      scheduler.queueForwardCatchup(100)
      scheduler.queueForwardCatchup(100) // Duplicate

      const jobs = jobsService.getJobsForChat(100)
      expect(jobs).toHaveLength(1)
    })
  })

  describe('queueBackwardHistory', () => {
    it('queues backward history job for a chat', () => {
      chatSyncState.upsert({
        chat_id: 100,
        chat_type: 'private',
        sync_priority: SyncPriority.High,
        sync_enabled: true,
      })

      scheduler.queueBackwardHistory(100)

      const jobs = jobsService.getJobsForChat(100)
      expect(jobs).toHaveLength(1)
      expect(jobs[0]!.job_type).toBe(SyncJobType.BackwardHistory)
      expect(jobs[0]!.priority).toBe(SyncPriority.Background)
    })

    it('does not queue if history is complete', () => {
      chatSyncState.upsert({
        chat_id: 100,
        chat_type: 'private',
        sync_priority: SyncPriority.High,
        sync_enabled: true,
      })
      chatSyncState.markHistoryComplete(100)

      scheduler.queueBackwardHistory(100)

      const jobs = jobsService.getJobsForChat(100)
      expect(jobs).toHaveLength(0)
    })
  })

  describe('queueInitialLoad', () => {
    it('queues initial load job with specified message count', () => {
      chatSyncState.upsert({
        chat_id: 100,
        chat_type: 'group',
        sync_priority: SyncPriority.Medium,
        sync_enabled: true,
        member_count: 50,
      })

      scheduler.queueInitialLoad(100, 10)

      const jobs = jobsService.getJobsForChat(100)
      expect(jobs).toHaveLength(1)
      expect(jobs[0]!.job_type).toBe(SyncJobType.InitialLoad)
    })
  })

  describe('initializeForStartup', () => {
    beforeEach(() => {
      // Create some chats with sync enabled
      chatSyncState.upsert({
        chat_id: 1,
        chat_type: 'private',
        sync_priority: SyncPriority.High,
        sync_enabled: true,
      })
      chatSyncState.upsert({
        chat_id: 2,
        chat_type: 'group',
        sync_priority: SyncPriority.Medium,
        sync_enabled: true,
        member_count: 50,
      })
      chatSyncState.upsert({
        chat_id: 3,
        chat_type: 'channel',
        sync_priority: SyncPriority.Low,
        sync_enabled: false, // Disabled
      })
    })

    it('queues forward catchup for enabled chats', async () => {
      await scheduler.initializeForStartup()

      // Check jobs were created for enabled chats
      expect(jobsService.getJobsForChat(1).length).toBeGreaterThan(0)
      expect(jobsService.getJobsForChat(2).length).toBeGreaterThan(0)
      // Disabled chat should not have jobs
      expect(jobsService.getJobsForChat(3).length).toBe(0)
    })
  })

  describe('getNextJob', () => {
    it('returns highest priority job first', () => {
      // Queue jobs with different priorities
      jobsService.create({
        chat_id: 100,
        job_type: SyncJobType.BackwardHistory,
        priority: SyncPriority.Background,
      })
      jobsService.create({
        chat_id: 200,
        job_type: SyncJobType.ForwardCatchup,
        priority: SyncPriority.Realtime,
      })
      jobsService.create({
        chat_id: 300,
        job_type: SyncJobType.InitialLoad,
        priority: SyncPriority.Medium,
      })

      const nextJob = scheduler.getNextJob()
      expect(nextJob).not.toBeNull()
      expect(nextJob?.chat_id).toBe(200) // Realtime priority is highest
    })

    it('returns null when no pending jobs', () => {
      expect(scheduler.getNextJob()).toBeNull()
    })
  })

  describe('completeJob', () => {
    it('marks job as completed', () => {
      const job = jobsService.create({
        chat_id: 100,
        job_type: SyncJobType.ForwardCatchup,
        priority: SyncPriority.High,
      })
      jobsService.markRunning(job.id)

      scheduler.completeJob(job.id)

      const updated = jobsService.getById(job.id)
      expect(updated?.status).toBe(SyncJobStatus.Completed)
    })
  })

  describe('failJob', () => {
    it('marks job as failed with error message', () => {
      const job = jobsService.create({
        chat_id: 100,
        job_type: SyncJobType.ForwardCatchup,
        priority: SyncPriority.High,
      })
      jobsService.markRunning(job.id)

      scheduler.failJob(job.id, 'Network error')

      const updated = jobsService.getById(job.id)
      expect(updated?.status).toBe(SyncJobStatus.Failed)
      expect(updated?.error_message).toBe('Network error')
    })
  })

  describe('getStatus', () => {
    it('returns current scheduler status', () => {
      // Add some jobs
      jobsService.create({
        chat_id: 100,
        job_type: SyncJobType.ForwardCatchup,
        priority: SyncPriority.High,
      })
      const runningJob = jobsService.create({
        chat_id: 200,
        job_type: SyncJobType.BackwardHistory,
        priority: SyncPriority.Background,
      })
      jobsService.markRunning(runningJob.id)

      const status = scheduler.getStatus()

      expect(status.pendingJobs).toBe(1)
      expect(status.runningJobs).toBe(1)
    })
  })
})
