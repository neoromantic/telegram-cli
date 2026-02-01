/**
 * Sync scheduler for managing background synchronization jobs
 * Implements priority-based job queue with forward catchup and backward history sync
 */
import type { Database } from 'bun:sqlite'
import type { ChatSyncStateService } from '../db/chat-sync-state'
import type { MessagesCache } from '../db/messages-cache'
import type { SyncJobsService } from '../db/sync-jobs'
import { type SyncJobRow, SyncJobType, SyncPriority } from '../db/sync-schema'

/**
 * Scheduler status
 */
export interface SchedulerStatus {
  /** Number of pending jobs */
  pendingJobs: number
  /** Number of running jobs */
  runningJobs: number
  /** Jobs by type */
  jobsByType: Record<string, number>
  /** Jobs by priority */
  jobsByPriority: Record<number, number>
}

/**
 * Sync scheduler interface
 */
export interface SyncScheduler {
  /** Queue forward catchup job for a chat */
  queueForwardCatchup(chatId: number): void
  /** Queue backward history sync job for a chat */
  queueBackwardHistory(chatId: number): void
  /** Queue initial load job for a chat */
  queueInitialLoad(chatId: number, messageCount: number): void
  /** Initialize scheduler with startup jobs */
  initializeForStartup(): Promise<void>
  /** Get next job to process */
  getNextJob(): SyncJobRow | null
  /** Mark job as running */
  startJob(jobId: number): void
  /** Mark job as completed */
  completeJob(jobId: number): void
  /** Mark job as failed */
  failJob(jobId: number, errorMessage: string): void
  /** Update job progress */
  updateProgress(jobId: number, messagesFetched: number, cursor?: number): void
  /** Get scheduler status */
  getStatus(): SchedulerStatus
  /** Clean up old completed jobs */
  cleanup(maxAgeMs?: number): number
  /** Cancel all pending jobs for a chat */
  cancelJobsForChat(chatId: number): number
  /** Recover jobs that were running when daemon crashed */
  recoverCrashedJobs(): number
}

/**
 * Options for creating sync scheduler
 */
export interface SyncSchedulerOptions {
  db: Database
  jobsService: SyncJobsService
  chatSyncState: ChatSyncStateService
  messagesCache: MessagesCache
}

/**
 * Create sync scheduler
 */
export function createSyncScheduler(
  options: SyncSchedulerOptions,
): SyncScheduler {
  const { jobsService, chatSyncState } = options

  return {
    queueForwardCatchup(chatId: number): void {
      // Check if there's already a pending catchup job
      if (
        jobsService.hasPendingJobForChat(chatId, SyncJobType.ForwardCatchup)
      ) {
        return
      }

      // Forward catchup is highest priority (P0)
      jobsService.create({
        chat_id: chatId,
        job_type: SyncJobType.ForwardCatchup,
        priority: SyncPriority.Realtime,
      })
    },

    queueBackwardHistory(chatId: number): void {
      // Check if history is already complete
      const state = chatSyncState.get(chatId)
      if (state?.history_complete) {
        return
      }

      // Check if there's already a pending history job
      if (
        jobsService.hasPendingJobForChat(chatId, SyncJobType.BackwardHistory)
      ) {
        return
      }

      // ISSUE-6 FIX: If backward_cursor is null and no cached messages exist,
      // skip backward sync. Using offsetId: 0 with Telegram API fetches from
      // latest (not beginning), causing infinite loop. Use initial load instead.
      if (state?.backward_cursor === null) {
        const cachedCount = options.messagesCache.countByChatId(chatId)
        if (cachedCount === 0) {
          // No cursor and no cached messages - use initial load instead
          // Queue initial load if not already pending
          if (
            !jobsService.hasPendingJobForChat(chatId, SyncJobType.InitialLoad)
          ) {
            jobsService.create({
              chat_id: chatId,
              job_type: SyncJobType.InitialLoad,
              priority: state?.sync_priority ?? SyncPriority.Medium,
            })
          }
          return
        }
      }

      // History sync is background priority (P4)
      jobsService.create({
        chat_id: chatId,
        job_type: SyncJobType.BackwardHistory,
        priority: SyncPriority.Background,
      })
    },

    queueInitialLoad(chatId: number, _messageCount: number): void {
      // Check if there's already a pending initial load job
      if (jobsService.hasPendingJobForChat(chatId, SyncJobType.InitialLoad)) {
        return
      }

      // Get chat priority from sync state
      const state = chatSyncState.get(chatId)
      const priority = state?.sync_priority ?? SyncPriority.Medium

      jobsService.create({
        chat_id: chatId,
        job_type: SyncJobType.InitialLoad,
        priority,
      })
    },

    async initializeForStartup(): Promise<void> {
      // Recover any jobs that were running when daemon crashed
      this.recoverCrashedJobs()

      // Get all enabled chats
      const enabledChats = chatSyncState.getEnabledChats()

      // Queue forward catchup for all enabled chats (P0 priority)
      for (const chat of enabledChats) {
        this.queueForwardCatchup(chat.chat_id)
      }

      // Queue initial load for medium priority chats without history
      const mediumChats = chatSyncState.getChatsByPriority(SyncPriority.Medium)
      for (const chat of mediumChats) {
        if (!chat.history_complete && chat.synced_messages === 0) {
          this.queueInitialLoad(chat.chat_id, 10)
        }
      }

      // Queue background history sync for chats with incomplete history
      const incompleteChats = chatSyncState.getIncompleteHistory()
      for (const chat of incompleteChats) {
        if (chat.sync_priority <= SyncPriority.Medium) {
          this.queueBackwardHistory(chat.chat_id)
        }
      }
    },

    getNextJob(): SyncJobRow | null {
      return jobsService.getNextPending()
    },

    startJob(jobId: number): void {
      jobsService.markRunning(jobId)
    },

    completeJob(jobId: number): void {
      jobsService.markCompleted(jobId)
    },

    failJob(jobId: number, errorMessage: string): void {
      jobsService.markFailed(jobId, errorMessage)
    },

    updateProgress(
      jobId: number,
      messagesFetched: number,
      cursor?: number,
    ): void {
      jobsService.updateProgress(jobId, {
        messages_fetched: messagesFetched,
        cursor_end: cursor,
      })
    },

    getStatus(): SchedulerStatus {
      const runningJobs = jobsService.getRunningJobs()
      const pendingJobs = jobsService.getPendingJobs()

      const jobsByType: Record<string, number> = {}
      const jobsByPriority: Record<number, number> = {}

      // Count pending jobs by type and priority
      for (const job of pendingJobs) {
        jobsByType[job.job_type] = (jobsByType[job.job_type] ?? 0) + 1
        jobsByPriority[job.priority] = (jobsByPriority[job.priority] ?? 0) + 1
      }

      return {
        pendingJobs: pendingJobs.length,
        runningJobs: runningJobs.length,
        jobsByType,
        jobsByPriority,
      }
    },

    cleanup(maxAgeMs = 24 * 60 * 60 * 1000): number {
      return jobsService.cleanupCompleted(maxAgeMs)
    },

    cancelJobsForChat(chatId: number): number {
      return jobsService.cancelPendingForChat(chatId)
    },

    recoverCrashedJobs(): number {
      return jobsService.recoverCrashedJobs()
    },
  }
}
