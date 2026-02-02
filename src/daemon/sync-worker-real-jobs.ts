import { type SyncJobRow, SyncJobType } from '../db/sync-schema'
import {
  canMakeApiCall,
  getInputPeer,
  getWaitTime,
  recordApiCall,
  resolveFloodWaitResult,
} from './sync-worker-real-context'
import {
  createMessageInputs,
  fetchMessagesRaw,
} from './sync-worker-real-helpers'
import type {
  RealJobResult,
  RealSyncWorkerContext,
} from './sync-worker-real-types'

export async function processForwardCatchupReal(
  ctx: RealSyncWorkerContext,
  job: SyncJobRow,
): Promise<RealJobResult> {
  let result: RealJobResult
  const chatId = job.chat_id

  if (!canMakeApiCall(ctx)) {
    result = {
      success: false,
      messagesFetched: 0,
      rateLimited: true,
      waitSeconds: getWaitTime(ctx),
    }
    return result
  }

  const inputPeer = getInputPeer(ctx, chatId)
  if (!inputPeer) {
    result = {
      success: false,
      messagesFetched: 0,
      error: `Could not build InputPeer for chat ${chatId}`,
    }
    return result
  }

  const state = ctx.chatSyncState.get(chatId)
  const forwardCursor = state?.forward_cursor ?? 0

  try {
    recordApiCall(ctx)

    const { messages } = await fetchMessagesRaw(ctx.client, inputPeer, {
      minId: forwardCursor,
      limit: ctx.config.batchSize,
    })

    if (messages.length === 0) {
      ctx.chatSyncState.updateLastSync(chatId, 'forward')
      result = { success: true, messagesFetched: 0, hasMore: false }
      return result
    }

    const { inputs, maxId } = createMessageInputs(
      messages,
      chatId,
      forwardCursor,
      forwardCursor,
    )

    if (inputs.length > 0) {
      ctx.messagesCache.upsertBatch(inputs)
    }

    ctx.chatSyncState.updateCursors(chatId, { forward_cursor: maxId })
    ctx.chatSyncState.incrementSyncedMessages(chatId, inputs.length)
    ctx.chatSyncState.updateLastSync(chatId, 'forward')

    ctx.jobsService.updateProgress(job.id, {
      messages_fetched: inputs.length,
      cursor_end: maxId,
    })

    result = {
      success: true,
      messagesFetched: inputs.length,
      hasMore: messages.length >= ctx.config.batchSize,
      newCursor: maxId,
    }
  } catch (err) {
    const floodResult = resolveFloodWaitResult(ctx, err)
    if (floodResult) {
      return floodResult
    }
    const error = err instanceof Error ? err : new Error(String(err))
    result = {
      success: false,
      messagesFetched: 0,
      error: error.message,
    }
  }

  return result
}

export async function processBackwardHistoryReal(
  ctx: RealSyncWorkerContext,
  job: SyncJobRow,
): Promise<RealJobResult> {
  const chatId = job.chat_id

  if (!canMakeApiCall(ctx)) {
    return {
      success: false,
      messagesFetched: 0,
      rateLimited: true,
      waitSeconds: getWaitTime(ctx),
    }
  }

  const inputPeer = getInputPeer(ctx, chatId)
  if (!inputPeer) {
    return {
      success: false,
      messagesFetched: 0,
      error: `Could not build InputPeer for chat ${chatId}`,
    }
  }

  const state = ctx.chatSyncState.get(chatId)
  if (state?.history_complete) {
    return { success: true, messagesFetched: 0, historyComplete: true }
  }

  let backwardCursor = state?.backward_cursor
  if (backwardCursor === null || backwardCursor === undefined) {
    backwardCursor = ctx.messagesCache.getOldestMessageId(chatId) ?? 0
  }

  let result: RealJobResult

  try {
    recordApiCall(ctx)

    const { messages } = await fetchMessagesRaw(ctx.client, inputPeer, {
      offsetId: backwardCursor,
      limit: ctx.config.batchSize,
    })

    if (messages.length === 0) {
      ctx.chatSyncState.markHistoryComplete(chatId)
      ctx.chatSyncState.updateLastSync(chatId, 'backward')
      result = { success: true, messagesFetched: 0, historyComplete: true }
    } else {
      const { inputs, minId } = createMessageInputs(
        messages,
        chatId,
        backwardCursor || Number.MAX_SAFE_INTEGER,
        backwardCursor || 0,
      )

      if (inputs.length > 0) {
        ctx.messagesCache.upsertBatch(inputs)
      }

      ctx.chatSyncState.updateCursors(chatId, { backward_cursor: minId })
      ctx.chatSyncState.incrementSyncedMessages(chatId, inputs.length)
      ctx.chatSyncState.updateLastSync(chatId, 'backward')

      ctx.jobsService.updateProgress(job.id, {
        messages_fetched: inputs.length,
        cursor_end: minId,
      })

      const historyComplete =
        minId === 1 || messages.length < ctx.config.batchSize
      if (historyComplete) {
        ctx.chatSyncState.markHistoryComplete(chatId)
      }

      result = {
        success: true,
        messagesFetched: inputs.length,
        hasMore: !historyComplete,
        newCursor: minId,
        historyComplete,
      }
    }
  } catch (err) {
    const floodResult = resolveFloodWaitResult(ctx, err)
    if (floodResult) {
      return floodResult
    }
    const error = err instanceof Error ? err : new Error(String(err))
    result = {
      success: false,
      messagesFetched: 0,
      error: error.message,
    }
  }

  return result
}

export async function processInitialLoadReal(
  ctx: RealSyncWorkerContext,
  job: SyncJobRow,
): Promise<RealJobResult> {
  let result: RealJobResult
  const chatId = job.chat_id

  if (!canMakeApiCall(ctx)) {
    result = {
      success: false,
      messagesFetched: 0,
      rateLimited: true,
      waitSeconds: getWaitTime(ctx),
    }
    return result
  }

  const inputPeer = getInputPeer(ctx, chatId)
  if (!inputPeer) {
    result = {
      success: false,
      messagesFetched: 0,
      error: `Could not build InputPeer for chat ${chatId}`,
    }
    return result
  }

  try {
    recordApiCall(ctx)

    const { messages } = await fetchMessagesRaw(ctx.client, inputPeer, {
      limit: ctx.config.batchSize,
    })

    if (messages.length === 0) {
      ctx.chatSyncState.markHistoryComplete(chatId)
      result = { success: true, messagesFetched: 0 }
      return result
    }

    const { inputs, minId, maxId } = createMessageInputs(
      messages,
      chatId,
      Number.MAX_SAFE_INTEGER,
      0,
    )

    if (inputs.length > 0) {
      ctx.messagesCache.upsertBatch(inputs)
    }

    ctx.chatSyncState.updateCursors(chatId, {
      forward_cursor: maxId,
      backward_cursor: minId,
    })
    ctx.chatSyncState.incrementSyncedMessages(chatId, inputs.length)
    ctx.chatSyncState.updateLastSync(chatId, 'forward')

    const historyComplete = messages.length < ctx.config.batchSize
    if (historyComplete) {
      ctx.chatSyncState.markHistoryComplete(chatId)
    }

    ctx.jobsService.updateProgress(job.id, {
      messages_fetched: inputs.length,
      cursor_start: maxId,
      cursor_end: minId,
    })

    result = {
      success: true,
      messagesFetched: inputs.length,
      newCursor: maxId,
      historyComplete,
    }
  } catch (err) {
    const floodResult = resolveFloodWaitResult(ctx, err)
    if (floodResult) {
      return floodResult
    }
    const error = err instanceof Error ? err : new Error(String(err))
    result = {
      success: false,
      messagesFetched: 0,
      error: error.message,
    }
  }

  return result
}

export async function processJobReal(
  ctx: RealSyncWorkerContext,
  job: SyncJobRow,
): Promise<RealJobResult> {
  const started = ctx.jobsService.markRunning(job.id)
  if (!started) {
    return {
      success: false,
      messagesFetched: 0,
      error: `Job ${job.id} is not pending`,
    }
  }

  try {
    let result: RealJobResult

    switch (job.job_type) {
      case SyncJobType.ForwardCatchup:
        result = await processForwardCatchupReal(ctx, job)
        break
      case SyncJobType.BackwardHistory:
        result = await processBackwardHistoryReal(ctx, job)
        break
      case SyncJobType.InitialLoad:
        result = await processInitialLoadReal(ctx, job)
        break
      case SyncJobType.FullSync:
        result = await processInitialLoadReal(ctx, job)
        if (result.success && !result.historyComplete) {
          result.hasMore = true
        }
        break
      default:
        result = {
          success: false,
          messagesFetched: 0,
          error: `Unknown job type: ${job.job_type}`,
        }
    }

    if (result.success) {
      if (!ctx.jobsService.markCompleted(job.id)) {
        console.warn(`[sync-worker] Failed to mark job ${job.id} completed`)
      }
    } else if (result.rateLimited) {
      if (
        !ctx.jobsService.markFailed(
          job.id,
          `Rate limited: wait ${result.waitSeconds}s`,
        )
      ) {
        console.warn(`[sync-worker] Failed to mark job ${job.id} failed`)
      }
    } else if (result.error) {
      if (!ctx.jobsService.markFailed(job.id, result.error)) {
        console.warn(`[sync-worker] Failed to mark job ${job.id} failed`)
      }
    }

    return result
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error'
    if (!ctx.jobsService.markFailed(job.id, errorMessage)) {
      console.warn(`[sync-worker] Failed to mark job ${job.id} failed`)
    }
    return {
      success: false,
      messagesFetched: 0,
      error: errorMessage,
    }
  }
}
