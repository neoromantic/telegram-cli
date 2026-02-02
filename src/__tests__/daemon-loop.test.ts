/**
 * Tests for daemon main loop control flow (no module mocks)
 */
import { describe, expect, it, mock } from 'bun:test'
import type { DaemonContext } from '../daemon/daemon-context'
import { createDaemonRuntime } from '../daemon/daemon-context'
import { mainLoop } from '../daemon/daemon-loop'
import { createMessagesCache } from '../db/messages-cache'
import { createChatSyncStateService } from '../db/chat-sync-state'
import { getCacheDb } from '../db'

function createLogger() {
  return {
    info: mock(() => {}),
    debug: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
  }
}

function createContext(): DaemonContext {
  return {
    dataDir: '/tmp/tgcli',
    pidPath: '/tmp/tgcli/daemon.pid',
    verbosity: 'quiet',
    reconnectConfig: {
      initialDelayMs: 1000,
      maxDelayMs: 4000,
      maxAttempts: 2,
      backoffMultiplier: 2,
    },
    shutdownTimeoutMs: 1_000_000,
    logger: createLogger(),
    pidFile: {
      acquire: () => {},
      release: () => {},
      read: () => null,
      isRunning: () => false,
      sendSignal: () => false,
      getPath: () => '/tmp/tgcli/daemon.pid',
    },
    state: {
      running: false,
      accounts: new Map(),
      shutdownRequested: false,
    },
    accountsDb: {
      getAll: () => [],
      getById: () => null,
      getByPhone: () => null,
      getByUserId: () => null,
      getActive: () => null,
      create: () => {
        throw new Error('not used')
      },
      update: () => null,
      updateSession: () => {},
      setActive: () => {},
      delete: () => false,
      count: () => 0,
    },
    runtime: createDaemonRuntime(),
  }
}

async function runWithImmediateTimeouts(run: () => Promise<void>) {
  const originalSetTimeout = globalThis.setTimeout
  globalThis.setTimeout = ((callback: (...args: unknown[]) => void) => {
    callback()
    return 0 as unknown as NodeJS.Timeout
  }) as typeof setTimeout

  try {
    await run()
  } finally {
    globalThis.setTimeout = originalSetTimeout
  }
}

describe('mainLoop', () => {
  it('logs status update failures without crashing', async () => {
    const ctx = createContext()

    ctx.runtime.statusService = {
      setConnectedAccounts: () => {},
      setMessagesSynced: () => {
        ctx.state.shutdownRequested = true
      },
      updateLastUpdate: () => {
        throw new Error('status fail')
      },
      set: () => {},
      setDaemonRunning: () => {},
      setDaemonStopped: () => {},
    } as any

    await runWithImmediateTimeouts(() => mainLoop(ctx))

    expect(ctx.logger.warn).toHaveBeenCalled()
  })

  it('runs health checks and schedules reconnects when idle', async () => {
    const ctx = createContext()

    let loopCount = 0
    ctx.runtime.statusService = {
      setConnectedAccounts: () => {},
      setMessagesSynced: () => {},
      updateLastUpdate: () => {
        loopCount += 1
        if (loopCount >= 60) {
          ctx.state.shutdownRequested = true
        }
      },
      set: () => {},
      setDaemonRunning: () => {},
      setDaemonStopped: () => {},
    } as any

    ctx.state.accounts.set(1, {
      accountId: 1,
      phone: '+10000000001',
      name: null,
      status: 'connected',
      client: {
        getMe: () => {
          throw new Error('offline')
        },
      },
      lastActivity: 0,
    } as any)

    const originalNow = Date.now
    Date.now = () => 120000

    try {
      await runWithImmediateTimeouts(() => mainLoop(ctx))
    } finally {
      Date.now = originalNow
    }

    expect(ctx.state.accounts.get(1)?.status).toBe('error')
    expect(ctx.state.accounts.get(1)?.nextReconnectAt).toBeDefined()
  })

  it('cleans up old jobs on cleanup interval', async () => {
    const ctx = createContext()
    const cacheDb = getCacheDb()

    ctx.runtime.scheduler = {
      cleanup: () => 2,
      getStatus: () => ({ pendingJobs: 0, runningJobs: 0 }),
      getNextJob: () => null,
    } as any

    ctx.runtime.statusService = {
      setConnectedAccounts: () => {},
      setMessagesSynced: () => {},
      updateLastUpdate: () => {},
      set: () => {},
      setDaemonRunning: () => {},
      setDaemonStopped: () => {},
    } as any

    const statusService = ctx.runtime.statusService!
    let loopCount = 0
    statusService.updateLastUpdate = () => {
      loopCount += 1
      if (loopCount >= 300) {
        ctx.state.shutdownRequested = true
      }
    }

    const messagesCache = createMessagesCache(cacheDb)
    const chatSyncState = createChatSyncStateService(cacheDb)
    messagesCache.countByChatId(0)
    chatSyncState.get(0)

    await runWithImmediateTimeouts(() => mainLoop(ctx))

    expect(ctx.logger.debug).toHaveBeenCalled()
  })
})
