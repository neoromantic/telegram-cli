import type { SyncJobRow } from '../db/sync-schema'

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
