/**
 * Job executor for processing sync jobs with rate limiting
 *
 * Implements inter-batch delays between pagination calls within a single job,
 * and inter-job delays between different sync jobs to respect Telegram rate limits.
 */

import type { SyncJobRow } from '../db/sync-schema'
import type { SyncScheduler } from './scheduler'
import { DEFAULT_SYNC_DELAYS } from './types'

/**
 * Default job executor configuration (re-export for compatibility)
 */
export const DEFAULT_JOB_EXECUTOR_CONFIG = DEFAULT_SYNC_DELAYS

/**
 * Result of a single batch fetch operation
 */
export interface BatchResult {
  /** Number of messages fetched in this batch */
  messagesFetched: number
  /** Cursor position after this batch (for pagination) */
  nextCursor?: number
  /** Whether there are more messages to fetch */
  hasMore: boolean
}

/**
 * Function that fetches a single batch of messages
 * Implementations should handle the actual Telegram API calls
 */
export type BatchFetcher = (
  job: SyncJobRow,
  cursor?: number,
) => Promise<BatchResult>

/**
 * Job executor configuration
 */
export interface JobExecutorConfig {
  /** Delay between pagination calls within a single job (ms) */
  interBatchDelayMs: number
  /** Delay between different sync jobs (ms) */
  interJobDelayMs: number
  /** Maximum batches per job execution (0 = unlimited) */
  maxBatchesPerJob: number
}

/**
 * Job execution result
 */
export interface JobExecutionResult {
  /** Whether the job completed successfully */
  success: boolean
  /** Total messages fetched across all batches */
  totalMessagesFetched: number
  /** Number of batches processed */
  batchesProcessed: number
  /** Error message if failed */
  error?: string
  /** Whether the job has more work to do (for resumable jobs) */
  hasMoreWork: boolean
}

/**
 * Create a job executor
 */
export function createJobExecutor(
  scheduler: SyncScheduler,
  batchFetcher: BatchFetcher,
  config: Partial<JobExecutorConfig> = {},
): JobExecutor {
  const fullConfig: JobExecutorConfig = {
    interBatchDelayMs:
      config.interBatchDelayMs ?? DEFAULT_SYNC_DELAYS.interBatchDelayMs,
    interJobDelayMs:
      config.interJobDelayMs ?? DEFAULT_SYNC_DELAYS.interJobDelayMs,
    maxBatchesPerJob: config.maxBatchesPerJob ?? 0,
  }

  return new JobExecutor(scheduler, batchFetcher, fullConfig)
}

/**
 * Job executor class
 * Processes sync jobs from the scheduler with proper delays between batches
 */
export class JobExecutor {
  private scheduler: SyncScheduler
  private batchFetcher: BatchFetcher
  private config: JobExecutorConfig
  private lastJobCompletedAt: number | null = null
  private running = false
  private stopRequested = false

  constructor(
    scheduler: SyncScheduler,
    batchFetcher: BatchFetcher,
    config: JobExecutorConfig,
  ) {
    this.scheduler = scheduler
    this.batchFetcher = batchFetcher
    this.config = config
  }

  /**
   * Get current configuration
   */
  getConfig(): Readonly<JobExecutorConfig> {
    return { ...this.config }
  }

  /**
   * Update configuration
   */
  updateConfig(updates: Partial<JobExecutorConfig>): void {
    if (updates.interBatchDelayMs !== undefined) {
      this.config.interBatchDelayMs = updates.interBatchDelayMs
    }
    if (updates.interJobDelayMs !== undefined) {
      this.config.interJobDelayMs = updates.interJobDelayMs
    }
    if (updates.maxBatchesPerJob !== undefined) {
      this.config.maxBatchesPerJob = updates.maxBatchesPerJob
    }
  }

  /**
   * Check if executor is running
   */
  isRunning(): boolean {
    return this.running
  }

  /**
   * Request executor to stop
   */
  requestStop(): void {
    this.stopRequested = true
  }

  /**
   * Execute a single job with inter-batch delays
   */
  async executeJob(job: SyncJobRow): Promise<JobExecutionResult> {
    if (!this.scheduler.startJob(job.id)) {
      return {
        success: false,
        totalMessagesFetched: 0,
        batchesProcessed: 0,
        error: `Job ${job.id} is not pending`,
        hasMoreWork: false,
      }
    }

    let totalMessagesFetched = 0
    let batchesProcessed = 0
    let cursor = job.cursor_end ?? undefined
    let hasMoreWork = false

    try {
      let hasMore = true

      while (hasMore && !this.stopRequested) {
        // Check batch limit
        if (
          this.config.maxBatchesPerJob > 0 &&
          batchesProcessed >= this.config.maxBatchesPerJob
        ) {
          hasMoreWork = true
          break
        }

        // Fetch a batch
        const result = await this.batchFetcher(job, cursor)

        totalMessagesFetched += result.messagesFetched
        batchesProcessed++
        cursor = result.nextCursor
        hasMore = result.hasMore

        // Update progress in scheduler (pass delta, not cumulative)
        this.scheduler.updateProgress(job.id, result.messagesFetched, cursor)

        // Apply inter-batch delay if there's more to fetch
        if (
          hasMore &&
          this.config.interBatchDelayMs > 0 &&
          !this.stopRequested
        ) {
          await this.delay(this.config.interBatchDelayMs)
        }
      }

      // Mark job as completed (or leave it for continuation if hasMoreWork)
      if (!hasMoreWork) {
        if (!this.scheduler.completeJob(job.id)) {
          return {
            success: false,
            totalMessagesFetched,
            batchesProcessed,
            error: `Job ${job.id} is not running`,
            hasMoreWork: false,
          }
        }
      }

      return {
        success: true,
        totalMessagesFetched,
        batchesProcessed,
        hasMoreWork,
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err)
      this.scheduler.failJob(job.id, errorMessage)

      return {
        success: false,
        totalMessagesFetched,
        batchesProcessed,
        error: errorMessage,
        hasMoreWork: false,
      }
    }
  }

  /**
   * Process the next available job with proper inter-job delay
   * Returns null if no job is available
   */
  async processNextJob(): Promise<JobExecutionResult | null> {
    // Apply inter-job delay if we recently completed a job
    if (this.lastJobCompletedAt !== null && this.config.interJobDelayMs > 0) {
      const elapsed = Date.now() - this.lastJobCompletedAt
      const remainingDelay = this.config.interJobDelayMs - elapsed

      if (remainingDelay > 0) {
        await this.delay(remainingDelay)
      }
    }

    // Get next job from scheduler
    const job = this.scheduler.getNextJob()
    if (!job) {
      return null
    }

    // Execute the job
    const result = await this.executeJob(job)

    // Record completion time for inter-job delay
    this.lastJobCompletedAt = Date.now()

    return result
  }

  /**
   * Run the executor continuously until stopped
   * Processes jobs as they become available
   */
  async run(): Promise<void> {
    this.running = true
    this.stopRequested = false

    try {
      while (!this.stopRequested) {
        const result = await this.processNextJob()

        if (result === null) {
          // No jobs available, wait a bit before checking again
          await this.delay(1000)
        }
      }
    } finally {
      this.running = false
    }
  }

  /**
   * Helper to create a delay using Bun's native sleep
   */
  private delay(ms: number): Promise<void> {
    return Bun.sleep(ms)
  }
}
