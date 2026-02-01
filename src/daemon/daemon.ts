/**
 * Main daemon implementation
 * Manages Telegram connections, real-time updates, and background sync
 */

import { join } from 'node:path'
import { type DeleteMessageUpdate, TelegramClient } from '@mtcute/bun'
import {
  type AccountsDbInterface,
  accountsDb as defaultAccountsDb,
  getCacheDb,
  getDataDir,
} from '../db'
import { createChatSyncStateService } from '../db/chat-sync-state'
import { createChatsCache } from '../db/chats-cache'
import { createDaemonStatusService } from '../db/daemon-status'
import { createMessagesCache } from '../db/messages-cache'
import { createRateLimitsService } from '../db/rate-limits'
import { createSyncJobsService } from '../db/sync-jobs'
import { initSyncSchema, SyncJobType } from '../db/sync-schema'
import { getDefaultConfig, validateConfig } from '../services/telegram'
import {
  createUpdateHandlers,
  type NewMessageData,
  type UpdateContext,
} from './handlers'
import { DEFAULT_JOB_EXECUTOR_CONFIG } from './job-executor'
import { createPidFile } from './pid-file'
import { createSyncScheduler, type SyncScheduler } from './scheduler'
import { createRealSyncWorker, type RealSyncWorker } from './sync-worker'
import {
  type AccountConnectionState,
  type AccountEventHandlers,
  type DaemonConfig,
  DaemonExitCode,
  type DaemonState,
  type DaemonStatus,
  type DaemonVerbosity,
  DEFAULT_RECONNECT_CONFIG,
  DEFAULT_SHUTDOWN_TIMEOUT_MS,
  type ReconnectConfig,
} from './types'

/**
 * Logger interface for daemon
 */
interface DaemonLogger {
  info(message: string): void
  debug(message: string): void
  warn(message: string): void
  error(message: string): void
}

/**
 * Create a logger based on verbosity level
 */
function createLogger(verbosity: DaemonVerbosity): DaemonLogger {
  const shouldLog = {
    info: verbosity !== 'quiet',
    debug: verbosity === 'verbose',
    warn: true,
    error: true,
  }

  const timestamp = () => new Date().toISOString()

  return {
    info(message: string) {
      if (shouldLog.info) console.log(`[${timestamp()}] [INFO] ${message}`)
    },
    debug(message: string) {
      if (shouldLog.debug) console.log(`[${timestamp()}] [DEBUG] ${message}`)
    },
    warn(message: string) {
      if (shouldLog.warn) console.warn(`[${timestamp()}] [WARN] ${message}`)
    },
    error(message: string) {
      if (shouldLog.error) console.error(`[${timestamp()}] [ERROR] ${message}`)
    },
  }
}

/**
 * Daemon interface
 */
export interface Daemon {
  /** Start the daemon */
  start(): Promise<DaemonExitCode>
  /** Request graceful shutdown */
  stop(): void
  /** Get current status */
  getStatus(): DaemonStatus
  /** Check if daemon is running */
  isRunning(): boolean
}

/**
 * Create daemon instance
 */
/**
 * Calculate the delay for the next reconnection attempt using exponential backoff
 */
export function calculateReconnectDelay(
  attemptNumber: number,
  config: ReconnectConfig = DEFAULT_RECONNECT_CONFIG,
): number {
  const delay =
    config.initialDelayMs * config.backoffMultiplier ** (attemptNumber - 1)
  return Math.min(delay, config.maxDelayMs)
}

export function createDaemon(
  config: Partial<DaemonConfig> = {},
  accountsDb: AccountsDbInterface = defaultAccountsDb,
): Daemon {
  const dataDir = config.dataDir ?? getDataDir()
  const pidPath = config.pidPath ?? join(dataDir, 'daemon.pid')
  const verbosity = config.verbosity ?? 'normal'
  const reconnectConfig = config.reconnectConfig ?? DEFAULT_RECONNECT_CONFIG
  const shutdownTimeoutMs =
    config.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS

  const logger = createLogger(verbosity)
  const pidFile = createPidFile(pidPath)

  const state: DaemonState = {
    running: false,
    accounts: new Map(),
    shutdownRequested: false,
  }

  // Scheduler and sync worker state
  let scheduler: SyncScheduler | null = null
  const syncWorkers: Map<number, RealSyncWorker> = new Map()
  let lastJobProcessTime = 0
  let totalMessagesSynced = 0

  // Signal handlers
  let signalHandlersSetup = false

  function setupSignalHandlers() {
    if (signalHandlersSetup) return
    signalHandlersSetup = true

    const handleShutdown = (signal: string) => {
      logger.info(`Received ${signal}, initiating graceful shutdown...`)
      state.shutdownRequested = true
    }

    process.on('SIGTERM', () => handleShutdown('SIGTERM'))
    process.on('SIGINT', () => handleShutdown('SIGINT'))
  }

  /**
   * Set up event handlers for an account
   * Wires mtcute events to our update handlers
   */
  function setupEventHandlers(accountState: AccountConnectionState): void {
    const { client, accountId } = accountState
    if (!client) {
      logger.warn(`Cannot setup handlers: no client for account ${accountId}`)
      return
    }

    // Get the cache database and create services
    const cacheDb = getCacheDb()
    const messagesCache = createMessagesCache(cacheDb)
    const chatSyncState = createChatSyncStateService(cacheDb)

    // Create update handlers
    const updateHandlers = createUpdateHandlers({
      db: cacheDb,
      messagesCache,
      chatSyncState,
    })

    // Create the context for this account
    const createContext = (): UpdateContext => ({
      accountId,
      receivedAt: Date.now(),
    })

    // Create event handler functions that we can register and later remove
    const eventHandlers: AccountEventHandlers = {
      onNewMessage: (msg) => {
        const ctx = createContext()
        const data: NewMessageData = {
          chatId: msg.chat.id,
          messageId: msg.id,
          fromId: msg.sender?.id,
          text: msg.text,
          date: msg.date.getTime() / 1000, // Convert to Unix timestamp
          isOutgoing: msg.isOutgoing,
          replyToId: msg.replyToMessage?.id ?? undefined,
          messageType: msg.media ? 'media' : 'text',
          hasMedia: !!msg.media,
        }

        updateHandlers.handleNewMessage(ctx, data).catch((err) => {
          logger.error(`Error handling new message: ${err}`)
        })

        accountState.lastActivity = Date.now()
        logger.debug(
          `[Account ${accountId}] New message in chat ${data.chatId}`,
        )
      },

      onEditMessage: (msg) => {
        const ctx = createContext()
        updateHandlers
          .handleEditMessage(ctx, {
            chatId: msg.chat.id,
            messageId: msg.id,
            newText: msg.text,
            editDate: msg.editDate?.getTime()
              ? msg.editDate.getTime() / 1000
              : Date.now() / 1000,
          })
          .catch((err) => {
            logger.error(`Error handling message edit: ${err}`)
          })

        accountState.lastActivity = Date.now()
        logger.debug(
          `[Account ${accountId}] Message edited in chat ${msg.chat.id}`,
        )
      },

      onDeleteMessage: (update: DeleteMessageUpdate) => {
        // channelId is null for non-channel chats (private, groups)
        // For now, we only handle channel deletions that have a channelId
        const chatId = update.channelId
        if (chatId === null) {
          // Skip private/group chat deletions for now (no chat ID available in this event)
          logger.debug(
            `[Account ${accountId}] Skipping delete event without channel ID`,
          )
          return
        }

        const ctx = createContext()
        updateHandlers
          .handleDeleteMessages(ctx, {
            chatId,
            messageIds: update.messageIds,
          })
          .catch((err) => {
            logger.error(`Error handling message deletion: ${err}`)
          })

        accountState.lastActivity = Date.now()
        logger.debug(
          `[Account ${accountId}] Messages deleted in chat ${chatId}`,
        )
      },
    }

    // Register handlers with mtcute
    client.onNewMessage.add(eventHandlers.onNewMessage)
    client.onEditMessage.add(eventHandlers.onEditMessage)
    client.onDeleteMessage.add(eventHandlers.onDeleteMessage)

    // Store references for cleanup
    accountState.updateHandlers = updateHandlers
    accountState.eventHandlers = eventHandlers

    logger.debug(`[Account ${accountId}] Event handlers registered`)
  }

  /**
   * Remove event handlers for an account
   */
  function removeEventHandlers(accountState: AccountConnectionState): void {
    const { client, eventHandlers, accountId } = accountState

    if (!client || !eventHandlers) {
      return
    }

    // Remove handlers from mtcute events
    client.onNewMessage.remove(eventHandlers.onNewMessage)
    client.onEditMessage.remove(eventHandlers.onEditMessage)
    client.onDeleteMessage.remove(eventHandlers.onDeleteMessage)

    // Clear references
    accountState.eventHandlers = undefined
    accountState.updateHandlers = undefined

    logger.debug(`[Account ${accountId}] Event handlers removed`)
  }

  /**
   * Connect a single account
   */
  async function connectAccount(
    accountId: number,
    phone: string,
    name: string | null,
  ): Promise<boolean> {
    const accountState: AccountConnectionState = {
      accountId,
      phone,
      name,
      status: 'connecting',
    }
    state.accounts.set(accountId, accountState)

    try {
      const telegramConfig = getDefaultConfig()
      const validation = validateConfig(telegramConfig)
      if (!validation.valid) {
        throw new Error(validation.error)
      }

      const sessionPath = join(dataDir, `session_${accountId}.db`)
      logger.debug(`Connecting account ${phone} (session: ${sessionPath})`)

      const client = new TelegramClient({
        apiId: telegramConfig.apiId,
        apiHash: telegramConfig.apiHash,
        storage: sessionPath,
        logLevel: verbosity === 'verbose' ? 5 : 2,
      })

      // Try to connect and check authorization
      await client.start({
        phone: async () => {
          throw new Error('Interactive login not supported in daemon mode')
        },
        code: async () => {
          throw new Error('Interactive login not supported in daemon mode')
        },
        password: async () => {
          throw new Error('Interactive login not supported in daemon mode')
        },
      })

      // Verify we're authorized
      const me = await client.getMe()
      logger.info(
        `Connected account ${phone} (${me.firstName ?? ''} ${me.lastName ?? ''})`.trim(),
      )

      // Update user_id and check for duplicates
      const existingByUserId = accountsDb.getByUserId(me.id)
      if (existingByUserId && existingByUserId.id !== accountId) {
        // Duplicate found! This account has the same Telegram user as another one.
        // Keep the account with the real phone number (not user:xxx format)
        const currentAccount = accountsDb.getById(accountId)
        const currentHasRealPhone =
          currentAccount && !currentAccount.phone.startsWith('user:')
        const existingHasRealPhone = !existingByUserId.phone.startsWith('user:')

        if (currentHasRealPhone && !existingHasRealPhone) {
          // Current account has real phone, delete the old one
          logger.info(
            `Merging duplicate account: keeping #${accountId} (${phone}), removing #${existingByUserId.id} (${existingByUserId.phone})`,
          )
          accountsDb.delete(existingByUserId.id)
          accountsDb.update(accountId, { user_id: me.id })
        } else {
          // Existing account has real phone (or both have same type), keep existing
          logger.info(
            `Merging duplicate account: keeping #${existingByUserId.id} (${existingByUserId.phone}), removing #${accountId} (${phone})`,
          )
          accountsDb.setActive(existingByUserId.id)
          accountsDb.delete(accountId)
          // Update accountState to reflect the merged account
          accountState.accountId = existingByUserId.id
          accountState.phone = existingByUserId.phone
          accountState.name =
            existingByUserId.name ??
            `${me.firstName ?? ''}${me.lastName ? ` ${me.lastName}` : ''}`
        }
      } else if (!existingByUserId) {
        // No duplicate, just update user_id if not set
        const currentAccount = accountsDb.getById(accountId)
        if (currentAccount && currentAccount.user_id === null) {
          accountsDb.update(accountId, { user_id: me.id })
          logger.debug(`Updated user_id for account #${accountId}: ${me.id}`)
        }
      }

      accountState.client = client
      accountState.status = 'connected'
      accountState.lastActivity = Date.now()

      // Set up event handlers for real-time updates
      setupEventHandlers(accountState)

      // Start receiving updates from Telegram
      logger.debug(`[Account ${accountId}] Starting updates...`)
      await client.startUpdatesLoop()
      logger.info(`[Account ${accountId}] Real-time updates active`)

      return true
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err)
      logger.error(`Failed to connect account ${phone}: ${errorMessage}`)

      accountState.status = 'error'
      accountState.lastError = errorMessage

      return false
    }
  }

  /**
   * Schedule a reconnection attempt for an account
   */
  function scheduleReconnect(accountState: AccountConnectionState): void {
    const attempts = (accountState.reconnectAttempts ?? 0) + 1
    accountState.reconnectAttempts = attempts

    if (attempts > reconnectConfig.maxAttempts) {
      logger.error(
        `Account ${accountState.phone} exceeded max reconnection attempts (${reconnectConfig.maxAttempts}). Giving up.`,
      )
      return
    }

    const delay = calculateReconnectDelay(attempts, reconnectConfig)
    accountState.nextReconnectAt = Date.now() + delay

    logger.info(
      `Scheduling reconnection for ${accountState.phone} in ${Math.round(delay / 1000)}s (attempt ${attempts}/${reconnectConfig.maxAttempts})`,
    )
  }

  /**
   * Attempt to reconnect an account
   */
  async function attemptReconnect(
    accountState: AccountConnectionState,
  ): Promise<boolean> {
    logger.info(
      `Attempting reconnection for ${accountState.phone} (attempt ${accountState.reconnectAttempts}/${reconnectConfig.maxAttempts})`,
    )

    accountState.status = 'reconnecting'
    accountState.nextReconnectAt = undefined

    // Clean up old client if it exists
    if (accountState.client) {
      accountState.client = undefined
    }

    try {
      const telegramConfig = getDefaultConfig()
      const validation = validateConfig(telegramConfig)
      if (!validation.valid) {
        throw new Error(validation.error)
      }

      const sessionPath = join(dataDir, `session_${accountState.accountId}.db`)
      logger.debug(
        `Reconnecting account ${accountState.phone} (session: ${sessionPath})`,
      )

      const client = new TelegramClient({
        apiId: telegramConfig.apiId,
        apiHash: telegramConfig.apiHash,
        storage: sessionPath,
        logLevel: verbosity === 'verbose' ? 5 : 2,
      })

      await client.start({
        phone: async () => {
          throw new Error('Interactive login not supported in daemon mode')
        },
        code: async () => {
          throw new Error('Interactive login not supported in daemon mode')
        },
        password: async () => {
          throw new Error('Interactive login not supported in daemon mode')
        },
      })

      // Verify we're authorized
      const me = await client.getMe()
      logger.info(
        `Reconnected account ${accountState.phone} (${me.firstName ?? ''} ${me.lastName ?? ''})`.trim(),
      )

      accountState.client = client
      accountState.status = 'connected'
      accountState.lastActivity = Date.now()
      accountState.reconnectAttempts = 0 // Reset on successful connection
      accountState.lastError = undefined

      return true
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err)
      logger.error(
        `Reconnection failed for ${accountState.phone}: ${errorMessage}`,
      )

      accountState.status = 'error'
      accountState.lastError = errorMessage

      // Schedule next reconnection attempt
      scheduleReconnect(accountState)

      return false
    }
  }

  /**
   * Disconnect all accounts
   */
  async function disconnectAllAccounts(): Promise<void> {
    logger.debug('Disconnecting all accounts...')

    for (const [_, accountState] of state.accounts) {
      // Remove event handlers first
      if (accountState.eventHandlers) {
        try {
          removeEventHandlers(accountState)
        } catch (err) {
          logger.warn(
            `Error removing event handlers for ${accountState.phone}: ${err}`,
          )
        }
      }

      if (accountState.client) {
        try {
          // TelegramClient doesn't have a close method in mtcute
          // The client will be garbage collected when we remove the reference
          logger.debug(`Disconnected account ${accountState.phone}`)
        } catch (err) {
          logger.warn(
            `Error disconnecting account ${accountState.phone}: ${err}`,
          )
        }
      }
      accountState.status = 'disconnected'
      accountState.client = undefined
    }
  }

  /**
   * Initialize scheduler and job executors for connected accounts
   */
  async function initializeScheduler(): Promise<void> {
    const cacheDb = getCacheDb()
    const messagesCache = createMessagesCache(cacheDb)
    const chatSyncState = createChatSyncStateService(cacheDb)
    const jobsService = createSyncJobsService(cacheDb)
    const rateLimits = createRateLimitsService(cacheDb)
    const chatsCache = createChatsCache(cacheDb)

    // Create the scheduler
    scheduler = createSyncScheduler({
      db: cacheDb,
      jobsService,
      chatSyncState,
      messagesCache,
    })

    // Create a sync worker for each connected account
    for (const [accountId, accountState] of state.accounts) {
      if (accountState.status === 'connected' && accountState.client) {
        const worker = createRealSyncWorker({
          client: accountState.client,
          messagesCache,
          chatSyncState,
          jobsService,
          rateLimits,
          chatsCache,
        })

        syncWorkers.set(accountId, worker)
        logger.debug(`Created sync worker for account ${accountId}`)
      }
    }

    // Initialize the scheduler with startup jobs
    logger.info('Initializing sync scheduler...')
    await scheduler.initializeForStartup()

    const status = scheduler.getStatus()
    logger.info(`Scheduler initialized with ${status.pendingJobs} pending jobs`)
  }

  /**
   * Process pending sync jobs
   * Called periodically from the main loop
   */
  async function processJobs(): Promise<void> {
    if (!scheduler) return

    const now = Date.now()
    const timeSinceLastJob = now - lastJobProcessTime

    // Respect inter-job delay
    if (
      lastJobProcessTime > 0 &&
      timeSinceLastJob < DEFAULT_JOB_EXECUTOR_CONFIG.interJobDelayMs
    ) {
      return
    }

    // Get the next pending job
    const job = scheduler.getNextJob()
    if (!job) {
      return
    }

    // Find an available sync worker that can make API calls
    let worker: RealSyncWorker | undefined
    let workerAccountId: number | undefined

    for (const [accountId, w] of syncWorkers) {
      const accountState = state.accounts.get(accountId)
      if (
        accountState?.status === 'connected' &&
        accountState.client &&
        w.canMakeApiCall()
      ) {
        worker = w
        workerAccountId = accountId
        break
      }
    }

    if (!worker || workerAccountId === undefined) {
      logger.debug('No available sync worker for pending job')
      return
    }

    lastJobProcessTime = now

    logger.debug(
      `Processing job ${job.id}: ${job.job_type} for chat ${job.chat_id}`,
    )

    try {
      // Execute the job - sync worker handles marking running/completed/failed
      const result = await worker.processJobReal(job)

      if (result.success) {
        totalMessagesSynced += result.messagesFetched

        logger.debug(
          `Job ${job.id} completed: ${result.messagesFetched} messages fetched`,
        )

        // If the job needs to continue (pagination), queue a follow-up
        if (result.hasMore) {
          if (job.job_type === SyncJobType.BackwardHistory) {
            scheduler.queueBackwardHistory(job.chat_id)
          } else if (job.job_type === SyncJobType.ForwardCatchup) {
            scheduler.queueForwardCatchup(job.chat_id)
          }
        }
      } else if (result.rateLimited) {
        logger.debug(`Job ${job.id} rate limited: wait ${result.waitSeconds}s`)
      } else {
        logger.warn(`Job ${job.id} failed: ${result.error}`)
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err)
      logger.error(`Job ${job.id} error: ${errorMessage}`)
    }
  }

  /**
   * Clean up scheduler resources
   */
  function cleanupScheduler(): void {
    if (scheduler) {
      // Clean up old completed jobs (older than 24 hours)
      const cleaned = scheduler.cleanup(24 * 60 * 60 * 1000)
      if (cleaned > 0) {
        logger.debug(`Cleaned up ${cleaned} old completed jobs`)
      }
    }

    syncWorkers.clear()
    scheduler = null
  }

  /**
   * Main daemon loop
   */
  async function mainLoop(): Promise<void> {
    logger.debug('Starting main event loop...')

    // Counters for periodic tasks
    let loopIteration = 0
    const healthCheckInterval = 10 // Every 10 iterations (10 seconds)
    const cleanupInterval = 300 // Every 300 iterations (5 minutes)

    while (!state.shutdownRequested) {
      loopIteration++
      const now = Date.now()

      // Process pending sync jobs (every iteration, respects inter-job delay)
      try {
        await processJobs()
      } catch (err) {
        logger.warn(`Error processing jobs: ${err}`)
      }

      // Check connection health periodically
      if (loopIteration % healthCheckInterval === 0) {
        for (const [_, accountState] of state.accounts) {
          if (accountState.status === 'connected' && accountState.client) {
            try {
              // Ping to check connection (lightweight operation)
              await accountState.client.getMe()
              accountState.lastActivity = Date.now()
            } catch (err) {
              logger.warn(
                `Connection health check failed for ${accountState.phone}: ${err}`,
              )
              accountState.status = 'error'
              accountState.lastError = String(err)

              // Schedule reconnection attempt
              scheduleReconnect(accountState)
            }
          }

          // Attempt reconnection for accounts in error state when it's time
          if (
            accountState.status === 'error' &&
            accountState.nextReconnectAt &&
            now >= accountState.nextReconnectAt
          ) {
            // Don't block the loop - reconnect asynchronously
            attemptReconnect(accountState).catch((err) => {
              logger.error(`Unexpected error during reconnection: ${err}`)
            })
          }
        }
      }

      // Update daemon status in database
      try {
        const cacheDb = getCacheDb()
        const statusService = createDaemonStatusService(cacheDb)

        const connectedCount = Array.from(state.accounts.values()).filter(
          (a) => a.status === 'connected',
        ).length

        statusService.setConnectedAccounts(connectedCount, state.accounts.size)
        statusService.setMessagesSynced(totalMessagesSynced)
        statusService.updateLastUpdate()

        // Store scheduler status
        if (scheduler) {
          const schedulerStatus = scheduler.getStatus()
          statusService.set('pending_jobs', String(schedulerStatus.pendingJobs))
          statusService.set('running_jobs', String(schedulerStatus.runningJobs))
        }
      } catch (err) {
        logger.warn(`Failed to update daemon status: ${err}`)
      }

      // Periodic cleanup of old completed jobs
      if (loopIteration % cleanupInterval === 0 && scheduler) {
        try {
          const cleaned = scheduler.cleanup(24 * 60 * 60 * 1000)
          if (cleaned > 0) {
            logger.debug(`Cleaned up ${cleaned} old completed jobs`)
          }
        } catch (err) {
          logger.warn(`Failed to cleanup old jobs: ${err}`)
        }
      }

      // Short sleep between iterations (1 second for responsive job processing)
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }

    logger.debug('Main loop exiting...')
  }

  return {
    async start(): Promise<DaemonExitCode> {
      logger.info('Starting Telegram CLI daemon...')

      // Check if already running
      if (pidFile.isRunning()) {
        const pid = pidFile.read()
        logger.error(`Daemon already running with PID ${pid}`)
        return DaemonExitCode.AlreadyRunning
      }

      // Validate Telegram credentials
      const telegramConfig = getDefaultConfig()
      const validation = validateConfig(telegramConfig)
      if (!validation.valid) {
        logger.error(`Configuration error: ${validation.error}`)
        return DaemonExitCode.Error
      }

      // Load accounts
      const accounts = accountsDb.getAll()
      if (accounts.length === 0) {
        logger.error('No accounts configured. Use "tg auth" to add an account.')
        return DaemonExitCode.NoAccounts
      }

      // Acquire PID file
      try {
        pidFile.acquire()
        logger.debug(`PID file acquired: ${pidPath}`)
      } catch (err) {
        logger.error(`Failed to acquire PID file: ${err}`)
        return DaemonExitCode.Error
      }

      // Setup signal handlers
      setupSignalHandlers()

      // Initialize database
      try {
        const cacheDb = getCacheDb()
        initSyncSchema(cacheDb)

        const statusService = createDaemonStatusService(cacheDb)
        statusService.setDaemonRunning(process.pid)
      } catch (err) {
        logger.error(`Failed to initialize database: ${err}`)
        pidFile.release()
        return DaemonExitCode.Error
      }

      state.running = true
      state.startedAt = Date.now()

      // Connect all accounts concurrently
      logger.info(`Connecting ${accounts.length} account(s)...`)

      const connectionResults = await Promise.all(
        accounts.map((account) =>
          connectAccount(account.id, account.phone, account.name ?? null),
        ),
      )

      const connectedCount = connectionResults.filter(Boolean).length
      logger.info(`${connectedCount}/${accounts.length} account(s) connected`)

      if (connectedCount === 0) {
        logger.error('All accounts failed to connect')
        await cleanup()
        return DaemonExitCode.AllAccountsFailed
      }

      // Initialize scheduler and job executors after accounts are connected
      try {
        await initializeScheduler()
      } catch (err) {
        logger.error(`Failed to initialize scheduler: ${err}`)
        // Continue anyway - real-time updates still work without scheduler
      }

      // Run main loop
      try {
        await mainLoop()
      } catch (err) {
        logger.error(`Main loop error: ${err}`)
      }

      // Cleanup with timeout
      await cleanup()

      logger.info('Daemon stopped')
      return DaemonExitCode.Success

      async function cleanup() {
        const cleanupWork = async () => {
          // Clean up scheduler first
          cleanupScheduler()

          await disconnectAllAccounts()

          try {
            const cacheDb = getCacheDb()
            const statusService = createDaemonStatusService(cacheDb)
            statusService.setDaemonStopped()
          } catch (err) {
            logger.warn(`Failed to update daemon status on shutdown: ${err}`)
          }

          pidFile.release()
          state.running = false
        }

        const timeoutPromise = new Promise<never>((_, reject) => {
          setTimeout(() => {
            reject(new Error('Shutdown timeout exceeded'))
          }, shutdownTimeoutMs)
        })

        try {
          await Promise.race([cleanupWork(), timeoutPromise])
        } catch (err) {
          if (
            err instanceof Error &&
            err.message === 'Shutdown timeout exceeded'
          ) {
            logger.warn(
              `Shutdown timeout (${shutdownTimeoutMs}ms) exceeded - forcing exit`,
            )
            pidFile.release()
            process.exit(1)
          }
          throw err
        }
      }
    },

    stop(): void {
      state.shutdownRequested = true
    },

    getStatus(): DaemonStatus {
      const connectedAccounts = Array.from(state.accounts.values()).filter(
        (a) => a.status === 'connected',
      ).length

      return {
        running: state.running,
        pid: state.running ? process.pid : null,
        uptimeMs: state.startedAt ? Date.now() - state.startedAt : null,
        connectedAccounts,
        totalAccounts: state.accounts.size,
        accounts: Array.from(state.accounts.values()).map((a) => ({
          id: a.accountId,
          phone: a.phone,
          name: a.name,
          status: a.status,
          lastError: a.lastError,
        })),
        messagesSynced: totalMessagesSynced,
        lastUpdate: state.running ? Date.now() : null,
      }
    },

    isRunning(): boolean {
      return state.running
    },
  }
}
