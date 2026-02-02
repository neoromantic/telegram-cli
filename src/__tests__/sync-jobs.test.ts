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

  describe('claimNextJob', () => {
    it('atomically claims the highest priority pending job', () => {
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

      const claimed = service.claimNextJob()

      expect(claimed).not.toBeNull()
      expect(claimed?.chat_id).toBe(200) // Realtime priority
      expect(claimed?.status).toBe(SyncJobStatus.Running)
      expect(claimed?.started_at).not.toBeNull()
    })

    it('returns null when no pending jobs', () => {
      expect(service.claimNextJob()).toBeNull()
    })

    it('prevents double-claiming the same job (race condition fix)', () => {
      // Create a single job
      service.create({
        chat_id: 100,
        job_type: SyncJobType.ForwardCatchup,
        priority: SyncPriority.High,
      })

      // Simulate two workers claiming at the same time
      // First claim should succeed
      const claim1 = service.claimNextJob()
      // Second claim should get null (no more pending jobs)
      const claim2 = service.claimNextJob()

      expect(claim1).not.toBeNull()
      expect(claim1?.chat_id).toBe(100)
      expect(claim1?.status).toBe(SyncJobStatus.Running)

      expect(claim2).toBeNull()

      // Verify only one job is running
      const runningJobs = service.getRunningJobs()
      expect(runningJobs).toHaveLength(1)
    })

    it('claims jobs in priority order across multiple claims', () => {
      service.create({
        chat_id: 100,
        job_type: SyncJobType.BackwardHistory,
        priority: SyncPriority.Background,
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

      // First claim gets highest priority (Realtime)
      const claim1 = service.claimNextJob()
      expect(claim1?.chat_id).toBe(200)

      // Second claim gets next highest priority (Medium)
      const claim2 = service.claimNextJob()
      expect(claim2?.chat_id).toBe(300)

      // Third claim gets lowest priority (Background)
      const claim3 = service.claimNextJob()
      expect(claim3?.chat_id).toBe(100)

      // Fourth claim gets null (no more pending)
      const claim4 = service.claimNextJob()
      expect(claim4).toBeNull()

      // All three should be running
      expect(service.getRunningJobs()).toHaveLength(3)
    })
  })

  describe('markRunning', () => {
    it('sets status to running', () => {
      const job = service.create({
        chat_id: 100,
        job_type: SyncJobType.ForwardCatchup,
        priority: SyncPriority.High,
      })

      expect(service.markRunning(job.id)).toBe(true)

      const updated = service.getById(job.id)
      expect(updated?.status).toBe(SyncJobStatus.Running)
      expect(updated?.started_at).not.toBeNull()
    })

    it('returns false when job is not pending', () => {
      const job = service.create({
        chat_id: 200,
        job_type: SyncJobType.ForwardCatchup,
        priority: SyncPriority.High,
      })

      expect(service.markRunning(job.id)).toBe(true)
      expect(service.markRunning(job.id)).toBe(false)
    })
  })

  describe('markCompleted', () => {
    it('sets status to completed', () => {
      const job = service.create({
        chat_id: 100,
        job_type: SyncJobType.ForwardCatchup,
        priority: SyncPriority.High,
      })
      expect(service.markRunning(job.id)).toBe(true)

      expect(service.markCompleted(job.id)).toBe(true)

      const updated = service.getById(job.id)
      expect(updated?.status).toBe(SyncJobStatus.Completed)
      expect(updated?.completed_at).not.toBeNull()
    })

    it('returns false when job is not running', () => {
      const job = service.create({
        chat_id: 200,
        job_type: SyncJobType.ForwardCatchup,
        priority: SyncPriority.High,
      })

      expect(service.markCompleted(job.id)).toBe(false)
    })
  })

  describe('markFailed', () => {
    it('sets status to failed with error message', () => {
      const job = service.create({
        chat_id: 100,
        job_type: SyncJobType.ForwardCatchup,
        priority: SyncPriority.High,
      })
      expect(service.markRunning(job.id)).toBe(true)

      expect(service.markFailed(job.id, 'Network error')).toBe(true)

      const updated = service.getById(job.id)
      expect(updated?.status).toBe(SyncJobStatus.Failed)
      expect(updated?.error_message).toBe('Network error')
      expect(updated?.completed_at).not.toBeNull()
    })

    it('returns false when job is not running', () => {
      const job = service.create({
        chat_id: 200,
        job_type: SyncJobType.ForwardCatchup,
        priority: SyncPriority.High,
      })

      expect(service.markFailed(job.id, 'Network error')).toBe(false)
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

  describe('hasActiveJobForChat', () => {
    it('returns true if chat has pending job of given type', () => {
      service.create({
        chat_id: 100,
        job_type: SyncJobType.ForwardCatchup,
        priority: SyncPriority.High,
      })

      expect(service.hasActiveJobForChat(100, SyncJobType.ForwardCatchup)).toBe(
        true,
      )
      expect(
        service.hasActiveJobForChat(100, SyncJobType.BackwardHistory),
      ).toBe(false)
    })

    it('returns true if job is running', () => {
      const job = service.create({
        chat_id: 100,
        job_type: SyncJobType.ForwardCatchup,
        priority: SyncPriority.High,
      })
      service.markRunning(job.id)

      expect(service.hasActiveJobForChat(100, SyncJobType.ForwardCatchup)).toBe(
        true,
      )
    })

    it('returns false if job is not pending or running', () => {
      const job = service.create({
        chat_id: 100,
        job_type: SyncJobType.ForwardCatchup,
        priority: SyncPriority.High,
      })
      service.markRunning(job.id)
      service.markCompleted(job.id)

      expect(service.hasActiveJobForChat(100, SyncJobType.ForwardCatchup)).toBe(
        false,
      )
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

  describe('recoverCrashedJobs', () => {
    it('resets running jobs to pending after daemon crash', () => {
      const job1 = service.create({
        chat_id: 100,
        job_type: SyncJobType.ForwardCatchup,
        priority: SyncPriority.High,
      })
      const job2 = service.create({
        chat_id: 200,
        job_type: SyncJobType.BackwardHistory,
        priority: SyncPriority.Background,
      })
      const job3 = service.create({
        chat_id: 300,
        job_type: SyncJobType.InitialLoad,
        priority: SyncPriority.Medium,
      })

      // Mark some jobs as running (simulating daemon crash mid-execution)
      service.markRunning(job1.id)
      service.markRunning(job2.id)
      // job3 stays pending

      // Recover crashed jobs
      const recovered = service.recoverCrashedJobs()

      expect(recovered).toBe(2) // Two jobs were running

      // Verify recovered jobs are now pending with error message
      const recoveredJob1 = service.getById(job1.id)
      expect(recoveredJob1?.status).toBe(SyncJobStatus.Pending)
      expect(recoveredJob1?.error_message).toBe(
        'Daemon crashed during execution',
      )

      const recoveredJob2 = service.getById(job2.id)
      expect(recoveredJob2?.status).toBe(SyncJobStatus.Pending)
      expect(recoveredJob2?.error_message).toBe(
        'Daemon crashed during execution',
      )

      // Job that was pending should still be pending
      const pendingJob = service.getById(job3.id)
      expect(pendingJob?.status).toBe(SyncJobStatus.Pending)
      expect(pendingJob?.error_message).toBeNull()
    })

    it('returns 0 when no running jobs exist', () => {
      service.create({
        chat_id: 100,
        job_type: SyncJobType.ForwardCatchup,
        priority: SyncPriority.High,
      })

      const recovered = service.recoverCrashedJobs()

      expect(recovered).toBe(0)
    })

    it('makes recovered jobs available via getNextPending', () => {
      const job = service.create({
        chat_id: 100,
        job_type: SyncJobType.ForwardCatchup,
        priority: SyncPriority.High,
      })

      service.markRunning(job.id)

      // Before recovery, getNextPending should return null (no pending jobs)
      expect(service.getNextPending()).toBeNull()

      // Recover crashed jobs
      service.recoverCrashedJobs()

      // Now getNextPending should return the recovered job
      const nextJob = service.getNextPending()
      expect(nextJob).not.toBeNull()
      expect(nextJob?.id).toBe(job.id)
    })
  })
})
