/**
 * Tests for daemon scheduler logic (no module mocks)
 */
import { describe, expect, it, mock } from 'bun:test'
import type { DaemonContext } from '../daemon/daemon-context'
import { createDaemonRuntime } from '../daemon/daemon-context'
import {
  cleanupScheduler,
  initializeScheduler,
  processJobs,
} from '../daemon/daemon-scheduler'
import { SyncJobType, SyncPriority } from '../db/sync-schema'
import { getCacheDb } from '../db'
import { createTestDatabase } from '../db/index.ts'
import { initCacheSchema } from '../db/schema'
import { initSyncSchema } from '../db/sync-schema'

function createLogger() {
  return {
    info: mock(() => {}),
    debug: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
  }
}

function createContext(): DaemonContext {
  const { accountsDb } = createTestDatabase()
  return {
    dataDir: '/tmp/tgcli',
    pidPath: '/tmp/tgcli/daemon.pid',
    verbosity: 'normal',
    reconnectConfig: {
      initialDelayMs: 1000,
      maxDelayMs: 4000,
      maxAttempts: 3,
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
      running: true,
      accounts: new Map(),
      shutdownRequested: false,
    },
    accountsDb,
    runtime: createDaemonRuntime(),
  }
}

describe('initializeScheduler', () => {
  it('creates scheduler and workers for connected accounts', async () => {
    const ctx = createContext()
    const cacheDb = getCacheDb()
    initCacheSchema(cacheDb)
    initSyncSchema(cacheDb)

    ctx.state.accounts.set(1, {
      accountId: 1,
      phone: '+10000000001',
      name: null,
      status: 'connected',
      client: { call: async () => ({}) },
    } as any)

    await initializeScheduler(ctx)

    expect(ctx.runtime.scheduler).not.toBeNull()
    expect(ctx.runtime.syncWorkers.size).toBe(1)
  })
})

describe('processJobs', () => {
  it('queues follow-up jobs on success with hasMore', async () => {
    const ctx = createContext()

    const job = {
      id: 1,
      chat_id: 10,
      job_type: SyncJobType.BackwardHistory,
      priority: SyncPriority.High,
    } as any

    const scheduler = {
      getNextJob: () => job,
      queueBackwardHistory: mock(() => {}),
      queueForwardCatchup: mock(() => {}),
      cleanup: () => 0,
      getStatus: () => ({ pendingJobs: 0, runningJobs: 0 }),
    }

    const worker = {
      canMakeApiCall: () => true,
      processJobReal: mock(async () => ({
        success: true,
        messagesFetched: 4,
        hasMore: true,
      })),
    }

    ctx.runtime.scheduler = scheduler as any
    ctx.runtime.syncWorkers.set(1, worker as any)
    ctx.state.accounts.set(1, {
      accountId: 1,
      phone: '+10000000001',
      name: null,
      status: 'connected',
      client: {},
    } as any)

    await processJobs(ctx)

    expect(worker.processJobReal).toHaveBeenCalledWith(job)
    expect(scheduler.queueBackwardHistory).toHaveBeenCalledWith(10)
    expect(ctx.runtime.totalMessagesSynced).toBe(4)
  })

  it('records last job time when rate limited', async () => {
    const ctx = createContext()

    const job = {
      id: 2,
      chat_id: 44,
      job_type: SyncJobType.ForwardCatchup,
      priority: SyncPriority.High,
    } as any

    const scheduler = {
      getNextJob: () => job,
      queueBackwardHistory: mock(() => {}),
      queueForwardCatchup: mock(() => {}),
      cleanup: () => 0,
      getStatus: () => ({ pendingJobs: 0, runningJobs: 0 }),
    }

    const worker = {
      canMakeApiCall: () => true,
      processJobReal: mock(async () => ({
        success: false,
        messagesFetched: 0,
        rateLimited: true,
        waitSeconds: 3,
      })),
    }

    ctx.runtime.scheduler = scheduler as any
    ctx.runtime.syncWorkers.set(1, worker as any)
    ctx.state.accounts.set(1, {
      accountId: 1,
      phone: '+10000000001',
      name: null,
      status: 'connected',
      client: {},
    } as any)

    await processJobs(ctx)

    expect(ctx.runtime.lastJobProcessTime).toBeGreaterThan(0)
    expect(scheduler.queueForwardCatchup).not.toHaveBeenCalled()
  })

  it('skips processing when inter-job delay not elapsed', async () => {
    const ctx = createContext()
    const now = Date.now()
    const originalNow = Date.now

    Date.now = () => now
    ctx.runtime.lastJobProcessTime = now
    ctx.runtime.scheduler = {
      getNextJob: mock(() => null),
      cleanup: () => 0,
      getStatus: () => ({ pendingJobs: 0, runningJobs: 0 }),
    } as any

    const scheduler = ctx.runtime.scheduler!
    try {
      await processJobs(ctx)
    } finally {
      Date.now = originalNow
    }

    expect(scheduler.getNextJob).not.toHaveBeenCalled()
  })
})

describe('cleanupScheduler', () => {
  it('clears scheduler and workers after cleanup', () => {
    const ctx = createContext()

    const scheduler = {
      cleanup: mock(() => 2),
    }

    ctx.runtime.scheduler = scheduler as any
    ctx.runtime.syncWorkers.set(1, { canMakeApiCall: () => true } as any)

    cleanupScheduler(ctx)

    expect(scheduler.cleanup).toHaveBeenCalled()
    expect(ctx.runtime.syncWorkers.size).toBe(0)
    expect(ctx.runtime.scheduler).toBeNull()
  })
})
