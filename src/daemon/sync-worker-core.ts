/**
 * Sync worker for processing background synchronization jobs
 *
 * Handles three types of jobs:
 * - ForwardCatchup: Fetch messages newer than the forward cursor
 * - BackwardHistory: Fetch messages older than the backward cursor
 * - InitialLoad: Fetch the N most recent messages for a new chat
 *
 * Uses the mtcute TelegramClient for actual Telegram API calls with
 * proper rate limiting and flood wait handling.
 */
import type { ChatSyncStateService } from '../db/chat-sync-state'
import type { MessageInput, MessagesCache } from '../db/messages-cache'
import type { RateLimitsService } from '../db/rate-limits'
import type { SyncJobsService } from '../db/sync-jobs'
import { type SyncJobRow, SyncJobType } from '../db/sync-schema'
import { runOnceBase } from './sync-worker-utils'

/**
 * Telegram API message representation (simplified)
 */
export interface TelegramMessage {
  id: number
  fromId?: { userId?: number }
  peerId?: { chatId?: number; channelId?: number; userId?: number }
  replyTo?: { replyToMsgId?: number }
  fwdFrom?: { fromId?: { userId?: number } }
  message?: string
  date: number
  out?: boolean
  editDate?: number
  pinned?: boolean
  media?: unknown
}

/**
 * Result from fetching messages
 */
export interface FetchMessagesResult {
  messages: TelegramMessage[]
  /** True if there are no more messages to fetch */
  noMoreMessages: boolean
}

/**
 * Telegram client interface for sync operations (abstract)
 */
export interface SyncTelegramClient {
  /**
   * Fetch messages from a chat
   * @param chatId The chat to fetch from
   * @param options Fetch options (limit, offsetId, direction)
   */
  getMessages(
    chatId: number,
    options: {
      limit: number
      offsetId?: number
      addOffset?: number
    },
  ): Promise<FetchMessagesResult>
}

/**
 * FLOOD_WAIT error from Telegram
 */
export class FloodWaitError extends Error {
  constructor(
    public readonly seconds: number,
    public readonly method: string,
  ) {
    super(`FLOOD_WAIT_${seconds}`)
    this.name = 'FloodWaitError'
  }
}

/**
 * Sync worker configuration
 */
export interface SyncWorkerConfig {
  /** Batch size for fetching messages */
  batchSize: number
  /** API method name for rate limiting */
  apiMethod: string
}

/**
 * Default sync worker configuration
 */
export const DEFAULT_SYNC_WORKER_CONFIG: SyncWorkerConfig = {
  batchSize: 100,
  apiMethod: 'messages.getHistory',
}

/**
 * Sync worker dependencies
 */
export interface SyncWorkerDeps {
  client: SyncTelegramClient
  messagesCache: MessagesCache
  chatSyncState: ChatSyncStateService
  jobsService: SyncJobsService
  rateLimits: RateLimitsService
  config?: Partial<SyncWorkerConfig>
}

/**
 * Result of processing a job
 */
export interface JobResult {
  success: boolean
  messagesFetched: number
  error?: string
  rateLimited?: boolean
  waitSeconds?: number
}

interface SyncWorkerContext {
  client: SyncTelegramClient
  messagesCache: MessagesCache
  chatSyncState: ChatSyncStateService
  jobsService: SyncJobsService
  rateLimits: RateLimitsService
  config: SyncWorkerConfig
}

/**
 * Convert a Telegram message to a MessageInput for caching
 */
export function telegramMessageToInput(
  chatId: number,
  msg: TelegramMessage,
): MessageInput {
  const hasMedia = msg.media !== undefined && msg.media !== null

  return {
    chat_id: chatId,
    message_id: msg.id,
    from_id: msg.fromId?.userId ?? null,
    reply_to_id: msg.replyTo?.replyToMsgId ?? null,
    forward_from_id: msg.fwdFrom?.fromId?.userId ?? null,
    text: msg.message ?? null,
    message_type: hasMedia ? 'media' : 'text',
    has_media: hasMedia,
    is_outgoing: msg.out ?? false,
    is_edited: msg.editDate !== undefined,
    is_pinned: msg.pinned ?? false,
    edit_date: msg.editDate ?? null,
    date: msg.date,
    raw_json: JSON.stringify(msg),
  }
}

function canMakeApiCall(ctx: SyncWorkerContext): boolean {
  return !ctx.rateLimits.isBlocked(ctx.config.apiMethod)
}

function getWaitTime(ctx: SyncWorkerContext): number {
  return ctx.rateLimits.getWaitTime(ctx.config.apiMethod)
}

function recordApiCall(ctx: SyncWorkerContext): void {
  ctx.rateLimits.recordCall(ctx.config.apiMethod)
}

function handleFloodWait(ctx: SyncWorkerContext, seconds: number): void {
  ctx.rateLimits.setFloodWait(ctx.config.apiMethod, seconds)
}

async function processForwardCatchup(
  ctx: SyncWorkerContext,
  job: SyncJobRow,
): Promise<JobResult> {
  const chatId = job.chat_id

  if (!canMakeApiCall(ctx)) {
    return {
      success: false,
      messagesFetched: 0,
      rateLimited: true,
      waitSeconds: getWaitTime(ctx),
    }
  }

  const state = ctx.chatSyncState.get(chatId)
  const forwardCursor = state?.forward_cursor ?? 0

  try {
    recordApiCall(ctx)

    const result = await ctx.client.getMessages(chatId, {
      limit: ctx.config.batchSize,
      offsetId: forwardCursor,
      addOffset: -ctx.config.batchSize,
    })

    const messages = result.messages
    if (messages.length === 0) {
      return { success: true, messagesFetched: 0 }
    }

    const messageInputs = messages.map((msg) =>
      telegramMessageToInput(chatId, msg),
    )
    ctx.messagesCache.upsertBatch(messageInputs)

    const newestMessageId = Math.max(...messages.map((m) => m.id))
    ctx.chatSyncState.updateCursors(chatId, { forward_cursor: newestMessageId })
    ctx.chatSyncState.incrementSyncedMessages(chatId, messages.length)
    ctx.chatSyncState.updateLastSync(chatId, 'forward')

    ctx.jobsService.updateProgress(job.id, {
      messages_fetched: messages.length,
      cursor_end: newestMessageId,
    })

    return { success: true, messagesFetched: messages.length }
  } catch (err) {
    if (err instanceof FloodWaitError) {
      handleFloodWait(ctx, err.seconds)
      return {
        success: false,
        messagesFetched: 0,
        rateLimited: true,
        waitSeconds: err.seconds,
      }
    }
    throw err
  }
}

async function processBackwardHistory(
  ctx: SyncWorkerContext,
  job: SyncJobRow,
): Promise<JobResult> {
  const chatId = job.chat_id

  if (!canMakeApiCall(ctx)) {
    return {
      success: false,
      messagesFetched: 0,
      rateLimited: true,
      waitSeconds: getWaitTime(ctx),
    }
  }

  const state = ctx.chatSyncState.get(chatId)
  if (state?.history_complete) {
    return { success: true, messagesFetched: 0 }
  }

  let backwardCursor = state?.backward_cursor
  if (backwardCursor === null || backwardCursor === undefined) {
    backwardCursor = ctx.messagesCache.getOldestMessageId(chatId) ?? 0
  }

  try {
    recordApiCall(ctx)

    const result = await ctx.client.getMessages(chatId, {
      limit: ctx.config.batchSize,
      offsetId: backwardCursor,
    })

    const messages = result.messages
    if (messages.length === 0) {
      ctx.chatSyncState.markHistoryComplete(chatId)
      return { success: true, messagesFetched: 0 }
    }

    const messageInputs = messages.map((msg) =>
      telegramMessageToInput(chatId, msg),
    )
    ctx.messagesCache.upsertBatch(messageInputs)

    const oldestMessageId = Math.min(...messages.map((m) => m.id))
    ctx.chatSyncState.updateCursors(chatId, {
      backward_cursor: oldestMessageId,
    })
    ctx.chatSyncState.incrementSyncedMessages(chatId, messages.length)
    ctx.chatSyncState.updateLastSync(chatId, 'backward')

    ctx.jobsService.updateProgress(job.id, {
      messages_fetched: messages.length,
      cursor_end: oldestMessageId,
    })

    if (result.noMoreMessages) {
      ctx.chatSyncState.markHistoryComplete(chatId)
    }

    return { success: true, messagesFetched: messages.length }
  } catch (err) {
    if (err instanceof FloodWaitError) {
      handleFloodWait(ctx, err.seconds)
      return {
        success: false,
        messagesFetched: 0,
        rateLimited: true,
        waitSeconds: err.seconds,
      }
    }
    throw err
  }
}

async function processInitialLoad(
  ctx: SyncWorkerContext,
  job: SyncJobRow,
): Promise<JobResult> {
  const chatId = job.chat_id

  if (!canMakeApiCall(ctx)) {
    return {
      success: false,
      messagesFetched: 0,
      rateLimited: true,
      waitSeconds: getWaitTime(ctx),
    }
  }

  try {
    recordApiCall(ctx)

    const result = await ctx.client.getMessages(chatId, {
      limit: ctx.config.batchSize,
    })

    const messages = result.messages
    if (messages.length === 0) {
      ctx.chatSyncState.markHistoryComplete(chatId)
      return { success: true, messagesFetched: 0 }
    }

    const messageInputs = messages.map((msg) =>
      telegramMessageToInput(chatId, msg),
    )
    ctx.messagesCache.upsertBatch(messageInputs)

    const newestMessageId = Math.max(...messages.map((m) => m.id))
    const oldestMessageId = Math.min(...messages.map((m) => m.id))

    ctx.chatSyncState.updateCursors(chatId, {
      forward_cursor: newestMessageId,
      backward_cursor: oldestMessageId,
    })
    ctx.chatSyncState.incrementSyncedMessages(chatId, messages.length)
    ctx.chatSyncState.updateLastSync(chatId, 'forward')

    if (messages.length < ctx.config.batchSize || result.noMoreMessages) {
      ctx.chatSyncState.markHistoryComplete(chatId)
    }

    ctx.jobsService.updateProgress(job.id, {
      messages_fetched: messages.length,
      cursor_start: newestMessageId,
      cursor_end: oldestMessageId,
    })

    return { success: true, messagesFetched: messages.length }
  } catch (err) {
    if (err instanceof FloodWaitError) {
      handleFloodWait(ctx, err.seconds)
      return {
        success: false,
        messagesFetched: 0,
        rateLimited: true,
        waitSeconds: err.seconds,
      }
    }
    throw err
  }
}

async function processJob(
  ctx: SyncWorkerContext,
  job: SyncJobRow,
): Promise<JobResult> {
  ctx.jobsService.markRunning(job.id)

  try {
    let result: JobResult

    switch (job.job_type) {
      case SyncJobType.ForwardCatchup:
        result = await processForwardCatchup(ctx, job)
        break
      case SyncJobType.BackwardHistory:
        result = await processBackwardHistory(ctx, job)
        break
      case SyncJobType.InitialLoad:
        result = await processInitialLoad(ctx, job)
        break
      default:
        result = {
          success: false,
          messagesFetched: 0,
          error: `Unknown job type: ${job.job_type}`,
        }
    }

    if (result.success) {
      ctx.jobsService.markCompleted(job.id)
    } else if (result.rateLimited) {
      ctx.jobsService.markFailed(
        job.id,
        `Rate limited: wait ${result.waitSeconds}s`,
      )
    } else if (result.error) {
      ctx.jobsService.markFailed(job.id, result.error)
    }

    return result
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error'
    ctx.jobsService.markFailed(job.id, errorMessage)
    return {
      success: false,
      messagesFetched: 0,
      error: errorMessage,
    }
  }
}

async function runOnce(ctx: SyncWorkerContext): Promise<JobResult | null> {
  return runOnceBase<JobResult>({
    canMakeApiCall: () => canMakeApiCall(ctx),
    getWaitTime: () => getWaitTime(ctx),
    getNextJob: () => ctx.jobsService.getNextPending(),
    processJob: (job) => processJob(ctx, job),
  })
}

/**
 * Create a sync worker for processing jobs
 */
export function createSyncWorker(deps: SyncWorkerDeps) {
  const config = { ...DEFAULT_SYNC_WORKER_CONFIG, ...deps.config }
  const ctx: SyncWorkerContext = {
    client: deps.client,
    messagesCache: deps.messagesCache,
    chatSyncState: deps.chatSyncState,
    jobsService: deps.jobsService,
    rateLimits: deps.rateLimits,
    config,
  }

  return {
    processJob: (job: SyncJobRow) => processJob(ctx, job),
    processForwardCatchup: (job: SyncJobRow) => processForwardCatchup(ctx, job),
    processBackwardHistory: (job: SyncJobRow) =>
      processBackwardHistory(ctx, job),
    processInitialLoad: (job: SyncJobRow) => processInitialLoad(ctx, job),
    runOnce: () => runOnce(ctx),
    canMakeApiCall: () => canMakeApiCall(ctx),
    getWaitTime: () => getWaitTime(ctx),
  }
}

export type SyncWorker = ReturnType<typeof createSyncWorker>
