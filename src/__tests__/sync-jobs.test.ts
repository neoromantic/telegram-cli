/**
 * Tests for sync jobs service
 */
import { Database } from 'bun:sqlite'
import { beforeEach, describe, expect, it } from 'bun:test'
import { initCacheSchema } from '../db/schema'
import { createSyncJobsService, type SyncJobsService } from '../db/sync-jobs'
import {
  initSyncSchema,
  SyncJobStatus,
  SyncJobType,
  SyncPriority,
} from '../db/sync-schema'

describe('SyncJobsService', () => {
  let db: Database
  let service: SyncJobsService

  beforeEach(() => {
    db = new Database(':memory:')
    initCacheSchema(db)
    initSyncSchema(db)
    service = createSyncJobsService(db)
  })

  describe('create', () => {
    it('creates a new sync job', () => {
      const job = service.create({
        chat_id: 100,
        job_type: SyncJobType.ForwardCatchup,
        priority: SyncPriority.Realtime,
      })

      expect(job.id).toBeGreaterThan(0)
      expect(job.chat_id).toBe(100)
      expect(job.job_type).toBe(SyncJobType.ForwardCatchup)
      expect(job.priority).toBe(SyncPriority.Realtime)
      expect(job.status).toBe(SyncJobStatus.Pending)
    })

    it('auto-increments job IDs', () => {
      const job1 = service.create({
        chat_id: 100,
        job_type: SyncJobType.ForwardCatchup,
        priority: SyncPriority.High,
      })
      const job2 = service.create({
        chat_id: 200,
        job_type: SyncJobType.BackwardHistory,
        priority: SyncPriority.Medium,
      })

      expect(job2.id).toBe(job1.id + 1)
    })
  })

  describe('getById', () => {
    it('returns job by ID', () => {
      const created = service.create({
        chat_id: 100,
        job_type: SyncJobType.ForwardCatchup,
        priority: SyncPriority.High,
      })

      const job = service.getById(created.id)
      expect(job).not.toBeNull()
      expect(job?.chat_id).toBe(100)
    })

    it('returns null for non-existent job', () => {
      expect(service.getById(999)).toBeNull()
    })
  })

  describe('getNextPending', () => {
    it('returns highest priority pending job', () => {
      service.create({
        chat_id: 100,
        job_type: SyncJobType.BackwardHistory,
        priority: SyncPriority.Low,
      })
      service.create({
        chat_id: 200,
        job_type: SyncJobType.ForwardCatchup,
        priority: SyncPriority.Realtime,
      })
      service.create({
        chat_id: 300,
        job_type: SyncJobType.InitialLoad,
        priority: SyncPriority.Medium,
      })

      const next = service.getNextPending()
      expect(next).not.toBeNull()
      expect(next?.chat_id).toBe(200) // Realtime priority
    })

    it('returns oldest job when same priority (FIFO)', () => {
      service.create({
        chat_id: 100,
        job_type: SyncJobType.ForwardCatchup,
        priority: SyncPriority.High,
      })
      service.create({
        chat_id: 200,
        job_type: SyncJobType.ForwardCatchup,
        priority: SyncPriority.High,
      })

      const next = service.getNextPending()
      expect(next?.chat_id).toBe(100) // First created
    })

    it('skips running jobs', () => {
      const job1 = service.create({
        chat_id: 100,
        job_type: SyncJobType.ForwardCatchup,
        priority: SyncPriority.High,
      })
      service.create({
        chat_id: 200,
        job_type: SyncJobType.ForwardCatchup,
        priority: SyncPriority.High,
      })

      service.markRunning(job1.id)

      const next = service.getNextPending()
      expect(next?.chat_id).toBe(200)
    })

    it('returns null when no pending jobs', () => {
      expect(service.getNextPending()).toBeNull()
    })
  })

  describe('markRunning', () => {
    it('sets status to running', () => {
      const job = service.create({
        chat_id: 100,
        job_type: SyncJobType.ForwardCatchup,
        priority: SyncPriority.High,
      })

      service.markRunning(job.id)

      const updated = service.getById(job.id)
      expect(updated?.status).toBe(SyncJobStatus.Running)
      expect(updated?.started_at).not.toBeNull()
    })
  })

  describe('markCompleted', () => {
    it('sets status to completed', () => {
      const job = service.create({
        chat_id: 100,
        job_type: SyncJobType.ForwardCatchup,
        priority: SyncPriority.High,
      })
      service.markRunning(job.id)

      service.markCompleted(job.id)

      const updated = service.getById(job.id)
      expect(updated?.status).toBe(SyncJobStatus.Completed)
      expect(updated?.completed_at).not.toBeNull()
    })
  })

  describe('markFailed', () => {
    it('sets status to failed with error message', () => {
      const job = service.create({
        chat_id: 100,
        job_type: SyncJobType.ForwardCatchup,
        priority: SyncPriority.High,
      })
      service.markRunning(job.id)

      service.markFailed(job.id, 'Network error')

      const updated = service.getById(job.id)
      expect(updated?.status).toBe(SyncJobStatus.Failed)
      expect(updated?.error_message).toBe('Network error')
      expect(updated?.completed_at).not.toBeNull()
    })
  })

  describe('updateProgress', () => {
    it('updates cursor positions and message count', () => {
      const job = service.create({
        chat_id: 100,
        job_type: SyncJobType.BackwardHistory,
        priority: SyncPriority.Background,
      })
      service.markRunning(job.id)

      service.updateProgress(job.id, {
        cursor_start: 1000,
        cursor_end: 500,
        messages_fetched: 50,
      })

      const updated = service.getById(job.id)
      expect(updated?.cursor_start).toBe(1000)
      expect(updated?.cursor_end).toBe(500)
      expect(updated?.messages_fetched).toBe(50)
    })

    it('accumulates messages_fetched', () => {
      const job = service.create({
        chat_id: 100,
        job_type: SyncJobType.BackwardHistory,
        priority: SyncPriority.Background,
      })
      service.markRunning(job.id)

      service.updateProgress(job.id, { messages_fetched: 50 })
      service.updateProgress(job.id, { messages_fetched: 30 })

      const updated = service.getById(job.id)
      expect(updated?.messages_fetched).toBe(80)
    })
  })

  describe('getRunningJobs', () => {
    it('returns all running jobs', () => {
      const job1 = service.create({
        chat_id: 100,
        job_type: SyncJobType.ForwardCatchup,
        priority: SyncPriority.High,
      })
      service.create({
        chat_id: 200,
        job_type: SyncJobType.ForwardCatchup,
        priority: SyncPriority.High,
      })
      const job3 = service.create({
        chat_id: 300,
        job_type: SyncJobType.ForwardCatchup,
        priority: SyncPriority.High,
      })

      service.markRunning(job1.id)
      service.markRunning(job3.id)

      const running = service.getRunningJobs()
      expect(running).toHaveLength(2)
      expect(running.map((j) => j.chat_id)).toContain(100)
      expect(running.map((j) => j.chat_id)).toContain(300)
    })
  })

  describe('getJobsForChat', () => {
    it('returns all jobs for a specific chat', () => {
      service.create({
        chat_id: 100,
        job_type: SyncJobType.ForwardCatchup,
        priority: SyncPriority.High,
      })
      service.create({
        chat_id: 100,
        job_type: SyncJobType.BackwardHistory,
        priority: SyncPriority.Background,
      })
      service.create({
        chat_id: 200,
        job_type: SyncJobType.ForwardCatchup,
        priority: SyncPriority.High,
      })

      const jobs = service.getJobsForChat(100)
      expect(jobs).toHaveLength(2)
      expect(jobs.every((j) => j.chat_id === 100)).toBe(true)
    })
  })

  describe('hasPendingJobForChat', () => {
    it('returns true if chat has pending job of given type', () => {
      service.create({
        chat_id: 100,
        job_type: SyncJobType.ForwardCatchup,
        priority: SyncPriority.High,
      })

      expect(
        service.hasPendingJobForChat(100, SyncJobType.ForwardCatchup),
      ).toBe(true)
      expect(
        service.hasPendingJobForChat(100, SyncJobType.BackwardHistory),
      ).toBe(false)
    })

    it('returns false if job is not pending', () => {
      const job = service.create({
        chat_id: 100,
        job_type: SyncJobType.ForwardCatchup,
        priority: SyncPriority.High,
      })
      service.markRunning(job.id)

      expect(
        service.hasPendingJobForChat(100, SyncJobType.ForwardCatchup),
      ).toBe(false)
    })
  })

  describe('cleanupCompleted', () => {
    it('removes old completed jobs', () => {
      const job1 = service.create({
        chat_id: 100,
        job_type: SyncJobType.ForwardCatchup,
        priority: SyncPriority.High,
      })
      const job2 = service.create({
        chat_id: 200,
        job_type: SyncJobType.ForwardCatchup,
        priority: SyncPriority.High,
      })

      service.markRunning(job1.id)
      service.markCompleted(job1.id)
      // job2 stays pending

      // Clean jobs older than -1000ms (effectively all completed jobs, since we're saying "before now + 1 second")
      // Using a large positive number to ensure all completed jobs qualify
      const deleted = service.cleanupCompleted(-1000)

      expect(deleted).toBe(1)
      expect(service.getById(job1.id)).toBeNull()
      expect(service.getById(job2.id)).not.toBeNull()
    })
  })

  describe('cleanupFailed', () => {
    it('removes old failed jobs', () => {
      const job1 = service.create({
        chat_id: 100,
        job_type: SyncJobType.ForwardCatchup,
        priority: SyncPriority.High,
      })
      const job2 = service.create({
        chat_id: 200,
        job_type: SyncJobType.ForwardCatchup,
        priority: SyncPriority.High,
      })

      service.markRunning(job1.id)
      service.markFailed(job1.id, 'Network error')
      // job2 stays pending

      // Clean jobs older than -1000ms (effectively all failed jobs)
      const deleted = service.cleanupFailed(-1000)

      expect(deleted).toBe(1)
      expect(service.getById(job1.id)).toBeNull()
      expect(service.getById(job2.id)).not.toBeNull()
    })

    it('does not remove recent failed jobs', () => {
      const job = service.create({
        chat_id: 100,
        job_type: SyncJobType.ForwardCatchup,
        priority: SyncPriority.High,
      })

      service.markRunning(job.id)
      service.markFailed(job.id, 'Network error')

      // Clean jobs older than 1 hour (our job is newer)
      const deleted = service.cleanupFailed(60 * 60 * 1000)

      expect(deleted).toBe(0)
      expect(service.getById(job.id)).not.toBeNull()
    })

    it('does not affect completed jobs', () => {
      const job1 = service.create({
        chat_id: 100,
        job_type: SyncJobType.ForwardCatchup,
        priority: SyncPriority.High,
      })
      const job2 = service.create({
        chat_id: 200,
        job_type: SyncJobType.ForwardCatchup,
        priority: SyncPriority.High,
      })

      service.markRunning(job1.id)
      service.markFailed(job1.id, 'Network error')
      service.markRunning(job2.id)
      service.markCompleted(job2.id)

      // Clean all old failed jobs
      const deleted = service.cleanupFailed(-1000)

      expect(deleted).toBe(1)
      expect(service.getById(job1.id)).toBeNull() // Failed job removed
      expect(service.getById(job2.id)).not.toBeNull() // Completed job still exists
    })
  })

  describe('cancelPendingForChat', () => {
    it('cancels all pending jobs for a chat', () => {
      const job1 = service.create({
        chat_id: 100,
        job_type: SyncJobType.ForwardCatchup,
        priority: SyncPriority.High,
      })
      const job2 = service.create({
        chat_id: 100,
        job_type: SyncJobType.BackwardHistory,
        priority: SyncPriority.Low,
      })
      const job3 = service.create({
        chat_id: 200,
        job_type: SyncJobType.ForwardCatchup,
        priority: SyncPriority.High,
      })

      service.markRunning(job1.id) // This one is running, should not be cancelled

      const cancelled = service.cancelPendingForChat(100)

      expect(cancelled).toBe(1) // Only job2 was pending
      expect(service.getById(job1.id)?.status).toBe(SyncJobStatus.Running)
      expect(service.getById(job2.id)).toBeNull()
      expect(service.getById(job3.id)).not.toBeNull()
    })
  })
})
