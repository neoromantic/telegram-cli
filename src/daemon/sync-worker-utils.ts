import type { SyncJobsService } from '../db/sync-jobs'
import type { SyncJobRow, SyncJobType } from '../db/sync-schema'

export interface JobResultLike {
  success: boolean
  messagesFetched: number
  error?: string
  rateLimited?: boolean
  waitSeconds?: number
}

export async function runOnceBase<
  TJobResult extends { success: boolean; messagesFetched: number },
>(options: {
  canMakeApiCall: () => boolean
  getWaitTime: () => number
  getNextJob: () => SyncJobRow | null
  processJob: (job: SyncJobRow) => Promise<TJobResult>
}): Promise<TJobResult | null> {
  if (!options.canMakeApiCall()) {
    return {
      success: false,
      messagesFetched: 0,
      rateLimited: true,
      waitSeconds: options.getWaitTime(),
    } as unknown as TJobResult
  }

  const job = options.getNextJob()
  if (!job) {
    return null
  }

  return options.processJob(job)
}

export function finalizeJobResult(
  jobsService: SyncJobsService,
  jobId: number,
  result: JobResultLike,
): void {
  if (result.success) {
    if (!jobsService.markCompleted(jobId)) {
      console.warn(`[sync-worker] Failed to mark job ${jobId} completed`)
    }
    return
  }

  if (result.rateLimited) {
    if (
      !jobsService.markFailed(
        jobId,
        `Rate limited: wait ${result.waitSeconds}s`,
      )
    ) {
      console.warn(`[sync-worker] Failed to mark job ${jobId} failed`)
    }
    return
  }

  if (result.error) {
    if (!jobsService.markFailed(jobId, result.error)) {
      console.warn(`[sync-worker] Failed to mark job ${jobId} failed`)
    }
  }
}

export function failJobResult(
  jobsService: SyncJobsService,
  jobId: number,
  err: unknown,
): JobResultLike {
  const errorMessage = err instanceof Error ? err.message : 'Unknown error'
  if (!jobsService.markFailed(jobId, errorMessage)) {
    console.warn(`[sync-worker] Failed to mark job ${jobId} failed`)
  }
  return {
    success: false,
    messagesFetched: 0,
    error: errorMessage,
  }
}

export async function processJobWithHandlers<
  TContext extends { jobsService: SyncJobsService },
  TResult extends JobResultLike,
>(
  ctx: TContext,
  job: SyncJobRow,
  handlers: Partial<
    Record<SyncJobType, (ctx: TContext, job: SyncJobRow) => Promise<TResult>>
  >,
  unknownResult: (jobType: SyncJobType) => TResult,
): Promise<TResult> {
  const started = ctx.jobsService.markRunning(job.id)
  if (!started) {
    return {
      success: false,
      messagesFetched: 0,
      error: `Job ${job.id} is not pending`,
    } as TResult
  }

  try {
    const jobType = job.job_type as SyncJobType
    const handler = handlers[jobType]
    const result = handler ? await handler(ctx, job) : unknownResult(jobType)
    finalizeJobResult(ctx.jobsService, job.id, result)
    return result
  } catch (err) {
    return failJobResult(ctx.jobsService, job.id, err) as TResult
  }
}
