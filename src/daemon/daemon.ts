/**
 * Main daemon implementation
 * Manages Telegram connections, real-time updates, and background sync
 */

import { join } from 'node:path'
import { TelegramClient } from '@mtcute/bun'
import {
  type AccountsDbInterface,
  accountsDb as defaultAccountsDb,
  getCacheDb,
  getDataDir,
} from '../db'
import { createDaemonStatusService } from '../db/daemon-status'
import { initSyncSchema } from '../db/sync-schema'
import { getDefaultConfig, validateConfig } from '../services/telegram'
import { createPidFile } from './pid-file'
import {
  type AccountConnectionState,
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

      accountState.client = client
      accountState.status = 'connected'
      accountState.lastActivity = Date.now()

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
   * Main daemon loop
   */
  async function mainLoop(): Promise<void> {
    logger.debug('Starting main event loop...')

    // Simple keep-alive loop - in a real implementation, this would
    // process update events from connected clients
    while (!state.shutdownRequested) {
      const now = Date.now()

      // Check connection health and handle reconnections
      for (const [_, accountState] of state.accounts) {
        // Check health of connected accounts
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

      // Update daemon status in database
      try {
        const cacheDb = getCacheDb()
        const statusService = createDaemonStatusService(cacheDb)

        const connectedCount = Array.from(state.accounts.values()).filter(
          (a) => a.status === 'connected',
        ).length

        statusService.setConnectedAccounts(connectedCount, state.accounts.size)
        statusService.updateLastUpdate()
      } catch (err) {
        logger.warn(`Failed to update daemon status: ${err}`)
      }

      // Sleep for a bit before next iteration
      await new Promise((resolve) => setTimeout(resolve, 5000))
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
        messagesSynced: 0, // TODO: Track this
        lastUpdate: state.running ? Date.now() : null,
      }
    },

    isRunning(): boolean {
      return state.running
    },
  }
}
