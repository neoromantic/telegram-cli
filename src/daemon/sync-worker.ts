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
import type { TelegramClient } from '@mtcute/bun'
import type { ChatSyncStateService } from '../db/chat-sync-state'
import type { ChatsCache } from '../db/chats-cache'
import type { MessageInput, MessagesCache } from '../db/messages-cache'
import type { RateLimitsService } from '../db/rate-limits'
import type { SyncJobsService } from '../db/sync-jobs'
import { type SyncJobRow, SyncJobType } from '../db/sync-schema'

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

/**
 * Create a sync worker for processing jobs
 */
export function createSyncWorker(deps: SyncWorkerDeps) {
  const config = { ...DEFAULT_SYNC_WORKER_CONFIG, ...deps.config }
  const { client, messagesCache, chatSyncState, jobsService, rateLimits } = deps

  /**
   * Check if we can make an API call (not rate limited)
   */
  function canMakeApiCall(): boolean {
    return !rateLimits.isBlocked(config.apiMethod)
  }

  /**
   * Get wait time if rate limited
   */
  function getWaitTime(): number {
    return rateLimits.getWaitTime(config.apiMethod)
  }

  /**
   * Record an API call
   */
  function recordApiCall(): void {
    rateLimits.recordCall(config.apiMethod)
  }

  /**
   * Handle FLOOD_WAIT error
   */
  function handleFloodWait(seconds: number): void {
    rateLimits.setFloodWait(config.apiMethod, seconds)
  }

  /**
   * Process a ForwardCatchup job
   * Fetches messages newer than the forward cursor
   */
  async function processForwardCatchup(job: SyncJobRow): Promise<JobResult> {
    const chatId = job.chat_id

    // Check rate limiting
    if (!canMakeApiCall()) {
      return {
        success: false,
        messagesFetched: 0,
        rateLimited: true,
        waitSeconds: getWaitTime(),
      }
    }

    // Get current sync state
    const state = chatSyncState.get(chatId)
    const forwardCursor = state?.forward_cursor ?? 0

    try {
      recordApiCall()

      // Fetch messages after the cursor
      // For forward catchup, we want messages with ID > forwardCursor
      // offsetId = forwardCursor means start from that message
      // addOffset = -limit means get messages AFTER the offset (newer)
      const result = await client.getMessages(chatId, {
        limit: config.batchSize,
        offsetId: forwardCursor,
        addOffset: -config.batchSize,
      })

      const messages = result.messages

      if (messages.length === 0) {
        // No new messages - job complete
        return { success: true, messagesFetched: 0 }
      }

      // Convert and cache messages
      const messageInputs = messages.map((msg) =>
        telegramMessageToInput(chatId, msg),
      )
      messagesCache.upsertBatch(messageInputs)

      // Update cursor to the newest message
      const newestMessageId = Math.max(...messages.map((m) => m.id))
      chatSyncState.updateCursors(chatId, { forward_cursor: newestMessageId })
      chatSyncState.incrementSyncedMessages(chatId, messages.length)
      chatSyncState.updateLastSync(chatId, 'forward')

      // Update job progress
      jobsService.updateProgress(job.id, {
        messages_fetched: messages.length,
        cursor_end: newestMessageId,
      })

      return { success: true, messagesFetched: messages.length }
    } catch (err) {
      if (err instanceof FloodWaitError) {
        handleFloodWait(err.seconds)
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

  /**
   * Process a BackwardHistory job
   * Fetches messages older than the backward cursor
   */
  async function processBackwardHistory(job: SyncJobRow): Promise<JobResult> {
    const chatId = job.chat_id

    // Check rate limiting
    if (!canMakeApiCall()) {
      return {
        success: false,
        messagesFetched: 0,
        rateLimited: true,
        waitSeconds: getWaitTime(),
      }
    }

    // Get current sync state
    const state = chatSyncState.get(chatId)

    // If history is already complete, nothing to do
    if (state?.history_complete) {
      return { success: true, messagesFetched: 0 }
    }

    // Use backward cursor, or oldest cached message, or start from the end
    let backwardCursor = state?.backward_cursor
    if (backwardCursor === null || backwardCursor === undefined) {
      backwardCursor = messagesCache.getOldestMessageId(chatId) ?? 0
    }

    try {
      recordApiCall()

      // Fetch messages before the cursor
      // offsetId = backwardCursor means start from that message
      // No addOffset needed - default is to get older messages
      const result = await client.getMessages(chatId, {
        limit: config.batchSize,
        offsetId: backwardCursor,
      })

      const messages = result.messages

      if (messages.length === 0) {
        // No more messages - history complete
        chatSyncState.markHistoryComplete(chatId)
        return { success: true, messagesFetched: 0 }
      }

      // Convert and cache messages
      const messageInputs = messages.map((msg) =>
        telegramMessageToInput(chatId, msg),
      )
      messagesCache.upsertBatch(messageInputs)

      // Update cursor to the oldest message
      const oldestMessageId = Math.min(...messages.map((m) => m.id))
      chatSyncState.updateCursors(chatId, { backward_cursor: oldestMessageId })
      chatSyncState.incrementSyncedMessages(chatId, messages.length)
      chatSyncState.updateLastSync(chatId, 'backward')

      // Update job progress
      jobsService.updateProgress(job.id, {
        messages_fetched: messages.length,
        cursor_end: oldestMessageId,
      })

      // If noMoreMessages flag is set, mark history as complete after caching
      if (result.noMoreMessages) {
        chatSyncState.markHistoryComplete(chatId)
      }

      return { success: true, messagesFetched: messages.length }
    } catch (err) {
      if (err instanceof FloodWaitError) {
        handleFloodWait(err.seconds)
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

  /**
   * Process an InitialLoad job
   * Fetches the N most recent messages for a new chat
   */
  async function processInitialLoad(job: SyncJobRow): Promise<JobResult> {
    const chatId = job.chat_id

    // Check rate limiting
    if (!canMakeApiCall()) {
      return {
        success: false,
        messagesFetched: 0,
        rateLimited: true,
        waitSeconds: getWaitTime(),
      }
    }

    try {
      recordApiCall()

      // Fetch most recent messages (no offset = start from newest)
      const result = await client.getMessages(chatId, {
        limit: config.batchSize,
      })

      const messages = result.messages

      if (messages.length === 0) {
        // Empty chat
        chatSyncState.markHistoryComplete(chatId)
        return { success: true, messagesFetched: 0 }
      }

      // Convert and cache messages
      const messageInputs = messages.map((msg) =>
        telegramMessageToInput(chatId, msg),
      )
      messagesCache.upsertBatch(messageInputs)

      // Set both cursors
      const newestMessageId = Math.max(...messages.map((m) => m.id))
      const oldestMessageId = Math.min(...messages.map((m) => m.id))

      chatSyncState.updateCursors(chatId, {
        forward_cursor: newestMessageId,
        backward_cursor: oldestMessageId,
      })
      chatSyncState.incrementSyncedMessages(chatId, messages.length)
      chatSyncState.updateLastSync(chatId, 'forward')

      // If we got fewer messages than requested, history is complete
      if (messages.length < config.batchSize || result.noMoreMessages) {
        chatSyncState.markHistoryComplete(chatId)
      }

      // Update job progress
      jobsService.updateProgress(job.id, {
        messages_fetched: messages.length,
        cursor_start: newestMessageId,
        cursor_end: oldestMessageId,
      })

      return { success: true, messagesFetched: messages.length }
    } catch (err) {
      if (err instanceof FloodWaitError) {
        handleFloodWait(err.seconds)
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

  /**
   * Process a single job
   */
  async function processJob(job: SyncJobRow): Promise<JobResult> {
    // Mark job as running
    jobsService.markRunning(job.id)

    try {
      let result: JobResult

      switch (job.job_type) {
        case SyncJobType.ForwardCatchup:
          result = await processForwardCatchup(job)
          break
        case SyncJobType.BackwardHistory:
          result = await processBackwardHistory(job)
          break
        case SyncJobType.InitialLoad:
          result = await processInitialLoad(job)
          break
        default:
          result = {
            success: false,
            messagesFetched: 0,
            error: `Unknown job type: ${job.job_type}`,
          }
      }

      if (result.success) {
        jobsService.markCompleted(job.id)
      } else if (result.rateLimited) {
        // Re-queue the job by marking it as pending again
        // The job will be retried when rate limit expires
        jobsService.markFailed(
          job.id,
          `Rate limited: wait ${result.waitSeconds}s`,
        )
      } else if (result.error) {
        jobsService.markFailed(job.id, result.error)
      }

      return result
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error'
      jobsService.markFailed(job.id, errorMessage)
      return {
        success: false,
        messagesFetched: 0,
        error: errorMessage,
      }
    }
  }

  /**
   * Run a single work cycle
   * Processes one job if available and not rate limited
   */
  async function runOnce(): Promise<JobResult | null> {
    // Check global rate limit
    if (!canMakeApiCall()) {
      return {
        success: false,
        messagesFetched: 0,
        rateLimited: true,
        waitSeconds: getWaitTime(),
      }
    }

    // Get next pending job
    const job = jobsService.getNextPending()
    if (!job) {
      return null // No jobs to process
    }

    return processJob(job)
  }

  return {
    processJob,
    processForwardCatchup,
    processBackwardHistory,
    processInitialLoad,
    runOnce,
    canMakeApiCall,
    getWaitTime,
  }
}

export type SyncWorker = ReturnType<typeof createSyncWorker>

// ============================================================================
// Real mtcute Client Integration
// ============================================================================

/**
 * Build InputPeer from chat ID using cached chat data
 */
export function buildInputPeer(
  chatId: number,
  chatsCache: ChatsCache,
): { _: string; [key: string]: unknown } | null {
  const chat = chatsCache.getById(String(chatId))

  if (!chat) {
    // Try as a basic user peer if not in cache
    // Negative IDs are typically channels/groups
    if (chatId < 0) {
      // Without access_hash we can't make API calls to channels
      return null
    }
    // Positive ID could be a user or basic chat - try with zero access hash
    return {
      _: 'inputPeerUser',
      userId: chatId,
      accessHash: 0n,
    }
  }

  switch (chat.type) {
    case 'private':
      return {
        _: 'inputPeerUser',
        userId: Number(chat.chat_id),
        accessHash: BigInt(chat.access_hash || '0'),
      }
    case 'group':
      return {
        _: 'inputPeerChat',
        chatId: Number(chat.chat_id),
      }
    case 'supergroup':
    case 'channel':
      return {
        _: 'inputPeerChannel',
        channelId: Number(chat.chat_id),
        accessHash: BigInt(chat.access_hash || '0'),
      }
    default:
      return null
  }
}

/**
 * JSON replacer for BigInt values
 */
function bigIntReplacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') {
    return value.toString()
  }
  return value
}

/**
 * Parse raw Telegram API message to MessageInput format
 */
export function parseRawMessage(
  msg: unknown,
  chatId: number,
): MessageInput | null {
  const m = msg as Record<string, unknown>

  // Skip empty messages or service messages we don't want to store
  if (!m || m._ === 'messageEmpty') {
    return null
  }

  // Determine message type based on media
  let messageType = 'text'
  let hasMedia = false

  if (m.media) {
    hasMedia = true
    const mediaObj = m.media as Record<string, unknown>
    const mediaType = mediaObj._
    switch (mediaType) {
      case 'messageMediaPhoto':
        messageType = 'photo'
        break
      case 'messageMediaDocument':
        messageType = 'document'
        break
      case 'messageMediaVideo':
        messageType = 'video'
        break
      case 'messageMediaAudio':
        messageType = 'audio'
        break
      case 'messageMediaGeo':
      case 'messageMediaGeoLive':
        messageType = 'location'
        break
      case 'messageMediaContact':
        messageType = 'contact'
        break
      case 'messageMediaPoll':
        messageType = 'poll'
        break
      case 'messageMediaWebPage':
        messageType = 'webpage'
        break
      case 'messageMediaVenue':
        messageType = 'venue'
        break
      case 'messageMediaGame':
        messageType = 'game'
        break
      case 'messageMediaInvoice':
        messageType = 'invoice'
        break
      case 'messageMediaSticker':
        messageType = 'sticker'
        break
      default:
        messageType = 'media'
    }
  } else if (m._ === 'messageService') {
    messageType = 'service'
  }

  // Extract sender ID from fromId peer
  let fromId: number | null = null
  if (m.fromId) {
    const fromIdObj = m.fromId as Record<string, unknown>
    if (fromIdObj._ === 'peerUser') {
      fromId = fromIdObj.userId as number
    } else if (fromIdObj._ === 'peerChannel') {
      fromId = fromIdObj.channelId as number
    } else if (fromIdObj._ === 'peerChat') {
      fromId = fromIdObj.chatId as number
    }
  }

  // Extract reply to message ID
  let replyToId: number | null = null
  if (m.replyTo) {
    const replyToObj = m.replyTo as Record<string, unknown>
    if (replyToObj.replyToMsgId) {
      replyToId = replyToObj.replyToMsgId as number
    }
  }

  // Extract forward from ID
  let forwardFromId: number | null = null
  if (m.fwdFrom) {
    const fwdFromObj = m.fwdFrom as Record<string, unknown>
    if (fwdFromObj.fromId) {
      const fwdFromIdObj = fwdFromObj.fromId as Record<string, unknown>
      if (fwdFromIdObj._ === 'peerUser') {
        forwardFromId = fwdFromIdObj.userId as number
      } else if (fwdFromIdObj._ === 'peerChannel') {
        forwardFromId = fwdFromIdObj.channelId as number
      }
    }
  }

  return {
    chat_id: chatId,
    message_id: m.id as number,
    from_id: fromId,
    reply_to_id: replyToId,
    forward_from_id: forwardFromId,
    text: (m.message as string) || null,
    message_type: messageType,
    has_media: hasMedia,
    is_outgoing: Boolean(m.out),
    is_edited: Boolean(m.editDate),
    is_pinned: Boolean(m.pinned),
    edit_date: (m.editDate as number) || null,
    date: m.date as number,
    raw_json: JSON.stringify(m, bigIntReplacer),
  }
}

/**
 * Extract FLOOD_WAIT seconds from error message
 */
export function extractFloodWaitSeconds(error: Error): number | null {
  // Check error message for FLOOD_WAIT pattern
  const match = error.message.match(/FLOOD_WAIT_(\d+)/)
  if (match?.[1]) {
    return parseInt(match[1], 10)
  }

  // Check error object properties (mtcute may set this)
  const anyError = error as unknown as Record<string, unknown>
  if (typeof anyError.seconds === 'number') {
    return anyError.seconds
  }

  return null
}

/**
 * Fetch messages using raw Telegram API call
 * This provides more control than iterMessages() for sync operations
 */
export async function fetchMessagesRaw(
  client: TelegramClient,
  inputPeer: { _: string; [key: string]: unknown },
  options: {
    offsetId?: number
    addOffset?: number
    limit?: number
    minId?: number
    maxId?: number
  },
): Promise<{ messages: unknown[]; count?: number }> {
  const result = await client.call({
    _: 'messages.getHistory',
    peer: inputPeer,
    offsetId: options.offsetId ?? 0,
    offsetDate: 0,
    addOffset: options.addOffset ?? 0,
    limit: options.limit ?? 100,
    maxId: options.maxId ?? 0,
    minId: options.minId ?? 0,
    hash: 0n,
  } as any)

  // Result can be messages.Messages, messages.MessagesSlice, or messages.ChannelMessages
  const res = result as Record<string, unknown>
  const messages = (res.messages as unknown[]) || []
  const count = res.count as number | undefined

  return { messages, count }
}

/**
 * Extended dependencies for real Telegram client integration
 */
export interface RealSyncWorkerDeps {
  client: TelegramClient
  messagesCache: MessagesCache
  chatSyncState: ChatSyncStateService
  jobsService: SyncJobsService
  rateLimits: RateLimitsService
  chatsCache: ChatsCache
  config?: Partial<SyncWorkerConfig>
}

/**
 * Extended job result for real sync operations
 */
export interface RealJobResult extends JobResult {
  /** Whether more messages are available (pagination needed) */
  hasMore?: boolean
  /** New cursor position */
  newCursor?: number
  /** Whether history is complete */
  historyComplete?: boolean
}

/**
 * Create a sync worker that uses the real mtcute TelegramClient
 */
export function createRealSyncWorker(deps: RealSyncWorkerDeps) {
  const config = { ...DEFAULT_SYNC_WORKER_CONFIG, ...deps.config }
  const {
    client,
    messagesCache,
    chatSyncState,
    jobsService,
    rateLimits,
    chatsCache,
  } = deps

  /**
   * Check if we can make an API call (not rate limited)
   */
  function canMakeApiCall(): boolean {
    return !rateLimits.isBlocked(config.apiMethod)
  }

  /**
   * Get wait time if rate limited
   */
  function getWaitTime(): number {
    return rateLimits.getWaitTime(config.apiMethod)
  }

  /**
   * Record an API call
   */
  function recordApiCall(): void {
    rateLimits.recordCall(config.apiMethod)
  }

  /**
   * Handle FLOOD_WAIT error
   */
  function handleFloodWait(seconds: number): void {
    rateLimits.setFloodWait(config.apiMethod, seconds)
  }

  /**
   * Get InputPeer for a chat
   */
  function getInputPeer(
    chatId: number,
  ): { _: string; [key: string]: unknown } | null {
    return buildInputPeer(chatId, chatsCache)
  }

  /**
   * Process a ForwardCatchup job using raw API
   * Fetches messages newer than the forward cursor
   */
  async function processForwardCatchupReal(
    job: SyncJobRow,
  ): Promise<RealJobResult> {
    const chatId = job.chat_id

    // Check rate limiting
    if (!canMakeApiCall()) {
      return {
        success: false,
        messagesFetched: 0,
        rateLimited: true,
        waitSeconds: getWaitTime(),
      }
    }

    // Get InputPeer
    const inputPeer = getInputPeer(chatId)
    if (!inputPeer) {
      return {
        success: false,
        messagesFetched: 0,
        error: `Could not build InputPeer for chat ${chatId}`,
      }
    }

    // Get current sync state
    const state = chatSyncState.get(chatId)
    const forwardCursor = state?.forward_cursor ?? 0

    try {
      recordApiCall()

      // For forward catchup, use minId to get messages with ID > forwardCursor
      const { messages } = await fetchMessagesRaw(client, inputPeer, {
        minId: forwardCursor,
        limit: config.batchSize,
      })

      if (messages.length === 0) {
        // No new messages
        chatSyncState.updateLastSync(chatId, 'forward')
        return { success: true, messagesFetched: 0, hasMore: false }
      }

      // Parse and store messages
      const messageInputs: MessageInput[] = []
      let maxMessageId = forwardCursor

      for (const msg of messages) {
        const parsed = parseRawMessage(msg, chatId)
        if (parsed) {
          messageInputs.push(parsed)
          if (parsed.message_id > maxMessageId) {
            maxMessageId = parsed.message_id
          }
        }
      }

      if (messageInputs.length > 0) {
        messagesCache.upsertBatch(messageInputs)
      }

      // Update cursors
      chatSyncState.updateCursors(chatId, { forward_cursor: maxMessageId })
      chatSyncState.incrementSyncedMessages(chatId, messageInputs.length)
      chatSyncState.updateLastSync(chatId, 'forward')

      // Update job progress
      jobsService.updateProgress(job.id, {
        messages_fetched: messageInputs.length,
        cursor_end: maxMessageId,
      })

      // Check if there are more messages
      const hasMore = messages.length >= config.batchSize

      return {
        success: true,
        messagesFetched: messageInputs.length,
        hasMore,
        newCursor: maxMessageId,
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      const floodWaitSeconds = extractFloodWaitSeconds(error)

      if (floodWaitSeconds) {
        handleFloodWait(floodWaitSeconds)
        return {
          success: false,
          messagesFetched: 0,
          rateLimited: true,
          waitSeconds: floodWaitSeconds,
        }
      }

      return {
        success: false,
        messagesFetched: 0,
        error: error.message,
      }
    }
  }

  /**
   * Process a BackwardHistory job using raw API
   * Fetches messages older than the backward cursor
   */
  async function processBackwardHistoryReal(
    job: SyncJobRow,
  ): Promise<RealJobResult> {
    const chatId = job.chat_id

    // Check rate limiting
    if (!canMakeApiCall()) {
      return {
        success: false,
        messagesFetched: 0,
        rateLimited: true,
        waitSeconds: getWaitTime(),
      }
    }

    // Get InputPeer
    const inputPeer = getInputPeer(chatId)
    if (!inputPeer) {
      return {
        success: false,
        messagesFetched: 0,
        error: `Could not build InputPeer for chat ${chatId}`,
      }
    }

    // Get current sync state
    const state = chatSyncState.get(chatId)

    // If history is already complete, nothing to do
    if (state?.history_complete) {
      return { success: true, messagesFetched: 0, historyComplete: true }
    }

    // Use backward cursor, or oldest cached message, or start from latest
    let backwardCursor = state?.backward_cursor
    if (backwardCursor === null || backwardCursor === undefined) {
      backwardCursor = messagesCache.getOldestMessageId(chatId) ?? 0
    }

    try {
      recordApiCall()

      // For backward history, use offsetId to start from a message and go backwards
      const { messages } = await fetchMessagesRaw(client, inputPeer, {
        offsetId: backwardCursor,
        limit: config.batchSize,
      })

      if (messages.length === 0) {
        // No more messages - history complete
        chatSyncState.markHistoryComplete(chatId)
        chatSyncState.updateLastSync(chatId, 'backward')
        return { success: true, messagesFetched: 0, historyComplete: true }
      }

      // Parse and store messages
      const messageInputs: MessageInput[] = []
      let minMessageId = backwardCursor || Number.MAX_SAFE_INTEGER

      for (const msg of messages) {
        const parsed = parseRawMessage(msg, chatId)
        if (parsed) {
          messageInputs.push(parsed)
          if (parsed.message_id < minMessageId) {
            minMessageId = parsed.message_id
          }
        }
      }

      if (messageInputs.length > 0) {
        messagesCache.upsertBatch(messageInputs)
      }

      // Update cursors
      chatSyncState.updateCursors(chatId, { backward_cursor: minMessageId })
      chatSyncState.incrementSyncedMessages(chatId, messageInputs.length)
      chatSyncState.updateLastSync(chatId, 'backward')

      // Update job progress
      jobsService.updateProgress(job.id, {
        messages_fetched: messageInputs.length,
        cursor_end: minMessageId,
      })

      // Check if history is complete
      const historyComplete =
        minMessageId === 1 || messages.length < config.batchSize

      if (historyComplete) {
        chatSyncState.markHistoryComplete(chatId)
      }

      return {
        success: true,
        messagesFetched: messageInputs.length,
        hasMore: !historyComplete,
        newCursor: minMessageId,
        historyComplete,
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      const floodWaitSeconds = extractFloodWaitSeconds(error)

      if (floodWaitSeconds) {
        handleFloodWait(floodWaitSeconds)
        return {
          success: false,
          messagesFetched: 0,
          rateLimited: true,
          waitSeconds: floodWaitSeconds,
        }
      }

      return {
        success: false,
        messagesFetched: 0,
        error: error.message,
      }
    }
  }

  /**
   * Process an InitialLoad job using raw API
   * Fetches the N most recent messages for a new chat
   */
  async function processInitialLoadReal(
    job: SyncJobRow,
  ): Promise<RealJobResult> {
    const chatId = job.chat_id

    // Check rate limiting
    if (!canMakeApiCall()) {
      return {
        success: false,
        messagesFetched: 0,
        rateLimited: true,
        waitSeconds: getWaitTime(),
      }
    }

    // Get InputPeer
    const inputPeer = getInputPeer(chatId)
    if (!inputPeer) {
      return {
        success: false,
        messagesFetched: 0,
        error: `Could not build InputPeer for chat ${chatId}`,
      }
    }

    try {
      recordApiCall()

      // Fetch most recent messages (no offset = start from newest)
      const { messages } = await fetchMessagesRaw(client, inputPeer, {
        limit: config.batchSize,
      })

      if (messages.length === 0) {
        // Empty chat
        chatSyncState.markHistoryComplete(chatId)
        return { success: true, messagesFetched: 0 }
      }

      // Parse and store messages
      const messageInputs: MessageInput[] = []
      let maxMessageId = 0
      let minMessageId = Number.MAX_SAFE_INTEGER

      for (const msg of messages) {
        const parsed = parseRawMessage(msg, chatId)
        if (parsed) {
          messageInputs.push(parsed)
          if (parsed.message_id > maxMessageId) {
            maxMessageId = parsed.message_id
          }
          if (parsed.message_id < minMessageId) {
            minMessageId = parsed.message_id
          }
        }
      }

      if (messageInputs.length > 0) {
        messagesCache.upsertBatch(messageInputs)
      }

      // Set both cursors
      chatSyncState.updateCursors(chatId, {
        forward_cursor: maxMessageId,
        backward_cursor: minMessageId,
      })
      chatSyncState.incrementSyncedMessages(chatId, messageInputs.length)
      chatSyncState.updateLastSync(chatId, 'forward')

      // If we got fewer messages than requested, history is complete
      const historyComplete = messages.length < config.batchSize
      if (historyComplete) {
        chatSyncState.markHistoryComplete(chatId)
      }

      // Update job progress
      jobsService.updateProgress(job.id, {
        messages_fetched: messageInputs.length,
        cursor_start: maxMessageId,
        cursor_end: minMessageId,
      })

      return {
        success: true,
        messagesFetched: messageInputs.length,
        newCursor: maxMessageId,
        historyComplete,
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      const floodWaitSeconds = extractFloodWaitSeconds(error)

      if (floodWaitSeconds) {
        handleFloodWait(floodWaitSeconds)
        return {
          success: false,
          messagesFetched: 0,
          rateLimited: true,
          waitSeconds: floodWaitSeconds,
        }
      }

      return {
        success: false,
        messagesFetched: 0,
        error: error.message,
      }
    }
  }

  /**
   * Process a single job with the real Telegram client
   */
  async function processJobReal(job: SyncJobRow): Promise<RealJobResult> {
    // Mark job as running
    jobsService.markRunning(job.id)

    try {
      let result: RealJobResult

      switch (job.job_type) {
        case SyncJobType.ForwardCatchup:
          result = await processForwardCatchupReal(job)
          break
        case SyncJobType.BackwardHistory:
          result = await processBackwardHistoryReal(job)
          break
        case SyncJobType.InitialLoad:
          result = await processInitialLoadReal(job)
          break
        case SyncJobType.FullSync:
          // FullSync starts as initial load then continues with backward history
          result = await processInitialLoadReal(job)
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
        if (result.hasMore) {
          // Job needs continuation - keep as pending or create follow-up
          // For now, mark completed and let scheduler requeue if needed
          jobsService.markCompleted(job.id)
        } else {
          jobsService.markCompleted(job.id)
        }
      } else if (result.rateLimited) {
        // Rate limited - mark as failed with indicator
        jobsService.markFailed(
          job.id,
          `Rate limited: wait ${result.waitSeconds}s`,
        )
      } else if (result.error) {
        jobsService.markFailed(job.id, result.error)
      }

      return result
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error'
      jobsService.markFailed(job.id, errorMessage)
      return {
        success: false,
        messagesFetched: 0,
        error: errorMessage,
      }
    }
  }

  /**
   * Run a single work cycle with the real client
   */
  async function runOnceReal(): Promise<RealJobResult | null> {
    // Check global rate limit
    if (!canMakeApiCall()) {
      return {
        success: false,
        messagesFetched: 0,
        rateLimited: true,
        waitSeconds: getWaitTime(),
      }
    }

    // Get next pending job
    const job = jobsService.getNextPending()
    if (!job) {
      return null // No jobs to process
    }

    return processJobReal(job)
  }

  return {
    processJobReal,
    processForwardCatchupReal,
    processBackwardHistoryReal,
    processInitialLoadReal,
    runOnceReal,
    canMakeApiCall,
    getWaitTime,
    // Also expose utility functions
    buildInputPeer: (chatId: number) => getInputPeer(chatId),
    parseRawMessage: (msg: unknown, chatId: number) =>
      parseRawMessage(msg, chatId),
  }
}

export type RealSyncWorker = ReturnType<typeof createRealSyncWorker>

/**
 * Create a sync worker runner that continuously processes jobs
 */
export function createSyncWorkerRunner(
  worker: RealSyncWorker,
  options: {
    pollIntervalMs?: number
    shouldStop?: () => boolean
    onRateLimited?: (waitSeconds: number) => void
    logger?: {
      debug(message: string): void
      info(message: string): void
      warn(message: string): void
      error(message: string): void
    }
  } = {},
) {
  const {
    pollIntervalMs = 1000,
    shouldStop = () => false,
    onRateLimited,
    logger = console,
  } = options

  let running = false

  return {
    /**
     * Start the worker loop
     */
    async start(): Promise<void> {
      if (running) return
      running = true

      logger.info('Sync worker started')

      while (running && !shouldStop()) {
        try {
          const result = await worker.runOnceReal()

          if (result === null) {
            // No jobs available, wait before polling again
            await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
            continue
          }

          if (result.rateLimited) {
            // Rate limited - notify and wait
            const waitMs = (result.waitSeconds ?? 30) * 1000
            logger.warn(`Rate limited, waiting ${result.waitSeconds}s`)
            onRateLimited?.(result.waitSeconds ?? 30)
            await new Promise((resolve) => setTimeout(resolve, waitMs))
            continue
          }

          if (result.success) {
            logger.debug(
              `Job completed: ${result.messagesFetched} messages fetched`,
            )
          } else if (result.error) {
            logger.error(`Job failed: ${result.error}`)
          }

          // Small delay between jobs
          await new Promise((resolve) => setTimeout(resolve, 100))
        } catch (err) {
          logger.error(`Worker error: ${err}`)
          // Wait before retrying
          await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
        }
      }

      logger.info('Sync worker stopped')
    },

    /**
     * Stop the worker loop
     */
    stop(): void {
      running = false
    },

    /**
     * Check if running
     */
    isRunning(): boolean {
      return running
    },
  }
}
