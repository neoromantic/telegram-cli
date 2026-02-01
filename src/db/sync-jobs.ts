/**
 * Sync jobs service
 * Manages the job queue for background synchronization
 */
import type { Database } from 'bun:sqlite'
import {
  SyncJobRow,
  SyncJobStatus,
  SyncJobType,
  SyncPriority,
} from './sync-schema'

/**
 * Input for creating a sync job
 */
export interface SyncJobInput {
  chat_id: number
  job_type: SyncJobType
  priority: SyncPriority
  cursor_start?: number
  cursor_end?: number
}

/**
 * Progress update for a sync job
 */
export interface SyncJobProgress {
  cursor_start?: number
  cursor_end?: number
  messages_fetched?: number
}

/**
 * Sync jobs service interface
 */
export interface SyncJobsService {
  /** Create a new sync job */
  create(input: SyncJobInput): SyncJobRow
  /** Get job by ID */
  getById(id: number): SyncJobRow | null
  /** Get the next pending job (highest priority, oldest first) */
  getNextPending(): SyncJobRow | null
  /** Get all pending jobs */
  getPendingJobs(): SyncJobRow[]
  /** Mark job as running */
  markRunning(id: number): void
  /** Mark job as completed */
  markCompleted(id: number): void
  /** Mark job as failed */
  markFailed(id: number, errorMessage: string): void
  /** Update job progress */
  updateProgress(id: number, progress: SyncJobProgress): void
  /** Get all running jobs */
  getRunningJobs(): SyncJobRow[]
  /** Get jobs for a specific chat */
  getJobsForChat(chatId: number): SyncJobRow[]
  /** Check if chat has pending job of given type */
  hasPendingJobForChat(chatId: number, jobType: SyncJobType): boolean
  /** Clean up old completed jobs */
  cleanupCompleted(olderThanMs: number): number
  /** Clean up old failed jobs */
  cleanupFailed(olderThanMs: number): number
  /** Cancel pending jobs for a chat */
  cancelPendingForChat(chatId: number): number
}

/**
 * Create a sync jobs service
 */
export function createSyncJobsService(db: Database): SyncJobsService {
  const stmts = {
    create: db.prepare(`
      INSERT INTO sync_jobs (chat_id, job_type, priority, status, cursor_start, cursor_end, created_at)
      VALUES ($chat_id, $job_type, $priority, $status, $cursor_start, $cursor_end, $now)
    `),

    getById: db
      .query(`
      SELECT * FROM sync_jobs WHERE id = $id
    `)
      .as(SyncJobRow),

    getNextPending: db
      .query(`
      SELECT * FROM sync_jobs
      WHERE status = $status
      ORDER BY priority ASC, created_at ASC
      LIMIT 1
    `)
      .as(SyncJobRow),

    getPendingJobs: db
      .query(`
      SELECT * FROM sync_jobs
      WHERE status = $status
      ORDER BY priority ASC, created_at ASC
    `)
      .as(SyncJobRow),

    markRunning: db.prepare(`
      UPDATE sync_jobs
      SET status = $status, started_at = $now
      WHERE id = $id
    `),

    markCompleted: db.prepare(`
      UPDATE sync_jobs
      SET status = $status, completed_at = $now
      WHERE id = $id
    `),

    markFailed: db.prepare(`
      UPDATE sync_jobs
      SET status = $status, error_message = $error, completed_at = $now
      WHERE id = $id
    `),

    updateProgress: db.prepare(`
      UPDATE sync_jobs
      SET cursor_start = COALESCE($cursor_start, cursor_start),
          cursor_end = COALESCE($cursor_end, cursor_end),
          messages_fetched = messages_fetched + COALESCE($messages, 0)
      WHERE id = $id
    `),

    getRunningJobs: db
      .query(`
      SELECT * FROM sync_jobs WHERE status = $status
    `)
      .as(SyncJobRow),

    getJobsForChat: db
      .query(`
      SELECT * FROM sync_jobs WHERE chat_id = $chat_id ORDER BY created_at DESC
    `)
      .as(SyncJobRow),

    hasPendingJobForChat: db.query(`
      SELECT 1 FROM sync_jobs
      WHERE chat_id = $chat_id AND job_type = $job_type AND status = $status
      LIMIT 1
    `),

    cleanupCompleted: db.prepare(`
      DELETE FROM sync_jobs
      WHERE status = $status AND completed_at < $before
    `),

    cleanupFailed: db.prepare(`
      DELETE FROM sync_jobs
      WHERE status = $status AND completed_at < $before
    `),

    cancelPendingForChat: db.prepare(`
      DELETE FROM sync_jobs
      WHERE chat_id = $chat_id AND status = $status
    `),

    getLastInsertId: db.query(`SELECT last_insert_rowid() as id`),
  }

  return {
    create(input: SyncJobInput): SyncJobRow {
      const now = Date.now()
      stmts.create.run({
        $chat_id: input.chat_id,
        $job_type: input.job_type,
        $priority: input.priority,
        $status: SyncJobStatus.Pending,
        $cursor_start: input.cursor_start ?? null,
        $cursor_end: input.cursor_end ?? null,
        $now: now,
      })

      const result = stmts.getLastInsertId.get() as { id: number }
      return this.getById(result.id)!
    },

    getById(id: number): SyncJobRow | null {
      return stmts.getById.get({ $id: id }) ?? null
    },

    getNextPending(): SyncJobRow | null {
      return (
        stmts.getNextPending.get({ $status: SyncJobStatus.Pending }) ?? null
      )
    },

    getPendingJobs(): SyncJobRow[] {
      return stmts.getPendingJobs.all({ $status: SyncJobStatus.Pending })
    },

    markRunning(id: number): void {
      stmts.markRunning.run({
        $id: id,
        $status: SyncJobStatus.Running,
        $now: Date.now(),
      })
    },

    markCompleted(id: number): void {
      stmts.markCompleted.run({
        $id: id,
        $status: SyncJobStatus.Completed,
        $now: Date.now(),
      })
    },

    markFailed(id: number, errorMessage: string): void {
      stmts.markFailed.run({
        $id: id,
        $status: SyncJobStatus.Failed,
        $error: errorMessage,
        $now: Date.now(),
      })
    },

    updateProgress(id: number, progress: SyncJobProgress): void {
      stmts.updateProgress.run({
        $id: id,
        $cursor_start: progress.cursor_start ?? null,
        $cursor_end: progress.cursor_end ?? null,
        $messages: progress.messages_fetched ?? null,
      })
    },

    getRunningJobs(): SyncJobRow[] {
      return stmts.getRunningJobs.all({ $status: SyncJobStatus.Running })
    },

    getJobsForChat(chatId: number): SyncJobRow[] {
      return stmts.getJobsForChat.all({ $chat_id: chatId })
    },

    hasPendingJobForChat(chatId: number, jobType: SyncJobType): boolean {
      const result = stmts.hasPendingJobForChat.get({
        $chat_id: chatId,
        $job_type: jobType,
        $status: SyncJobStatus.Pending,
      })
      return result !== null
    },

    cleanupCompleted(olderThanMs: number): number {
      const before = Date.now() - olderThanMs
      const result = stmts.cleanupCompleted.run({
        $status: SyncJobStatus.Completed,
        $before: before,
      })
      return result.changes
    },

    cleanupFailed(olderThanMs: number): number {
      const before = Date.now() - olderThanMs
      const result = stmts.cleanupFailed.run({
        $status: SyncJobStatus.Failed,
        $before: before,
      })
      return result.changes
    },

    cancelPendingForChat(chatId: number): number {
      const result = stmts.cancelPendingForChat.run({
        $chat_id: chatId,
        $status: SyncJobStatus.Pending,
      })
      return result.changes
    },
  }
}

export { SyncJobStatus, SyncJobType, SyncPriority }
