/**
 * Tests for sync worker runner
 */
import { afterEach, describe, expect, it, mock } from 'bun:test'
import type { RealSyncWorker } from '../daemon/sync-worker-real'
import { createSyncWorkerRunner } from '../daemon/sync-worker-runner'

function createImmediateTimeout() {
  const delays: number[] = []
  const originalSetTimeout = globalThis.setTimeout

  globalThis.setTimeout = ((
    callback: (...args: unknown[]) => void,
    ms?: number,
    ...args: unknown[]
  ) => {
    delays.push(ms ?? 0)
    callback(...args)
    return 0 as unknown as ReturnType<typeof setTimeout>
  }) as typeof setTimeout

  return {
    delays,
    restore() {
      globalThis.setTimeout = originalSetTimeout
    },
  }
}

describe('sync-worker runner', () => {
  let restoreTimers: (() => void) | null = null

  afterEach(() => {
    restoreTimers?.()
    restoreTimers = null
  })

  it('waits poll interval when no jobs are available', async () => {
    const timer = createImmediateTimeout()
    restoreTimers = timer.restore

    let calls = 0
    const worker: RealSyncWorker = {
      runOnceReal: mock(async () => {
        calls += 1
        return null
      }),
    } as unknown as RealSyncWorker

    const logger = {
      debug: mock(() => {}),
      info: mock(() => {}),
      warn: mock(() => {}),
      error: mock(() => {}),
    }

    const runner = createSyncWorkerRunner(worker, {
      pollIntervalMs: 250,
      shouldStop: () => calls > 0,
      logger,
    })

    await runner.start()

    expect(timer.delays).toContain(250)
  })

  it('handles rate limited results and notifies listener', async () => {
    const timer = createImmediateTimeout()
    restoreTimers = timer.restore

    let calls = 0
    const worker: RealSyncWorker = {
      runOnceReal: mock(async () => {
        calls += 1
        return {
          success: false,
          messagesFetched: 0,
          rateLimited: true,
          waitSeconds: 2,
        }
      }),
    } as unknown as RealSyncWorker

    const logger = {
      debug: mock(() => {}),
      info: mock(() => {}),
      warn: mock(() => {}),
      error: mock(() => {}),
    }

    const onRateLimited = mock(() => {})

    const runner = createSyncWorkerRunner(worker, {
      pollIntervalMs: 100,
      shouldStop: () => calls > 0,
      onRateLimited,
      logger,
    })

    await runner.start()

    expect(logger.warn).toHaveBeenCalled()
    expect(onRateLimited).toHaveBeenCalledWith(2)
    expect(timer.delays).toContain(2000)
  })

  it('uses default wait time when rate limited without waitSeconds', async () => {
    const timer = createImmediateTimeout()
    restoreTimers = timer.restore

    let calls = 0
    const worker: RealSyncWorker = {
      runOnceReal: mock(async () => {
        calls += 1
        return {
          success: false,
          messagesFetched: 0,
          rateLimited: true,
        }
      }),
    } as unknown as RealSyncWorker

    const logger = {
      debug: mock(() => {}),
      info: mock(() => {}),
      warn: mock(() => {}),
      error: mock(() => {}),
    }

    const onRateLimited = mock(() => {})

    const runner = createSyncWorkerRunner(worker, {
      pollIntervalMs: 100,
      shouldStop: () => calls > 0,
      onRateLimited,
      logger,
    })

    await runner.start()

    expect(onRateLimited).toHaveBeenCalledWith(30)
    expect(timer.delays).toContain(30000)
  })

  it('logs successful job completion and uses short delay', async () => {
    const timer = createImmediateTimeout()
    restoreTimers = timer.restore

    let calls = 0
    const worker: RealSyncWorker = {
      runOnceReal: mock(async () => {
        calls += 1
        return {
          success: true,
          messagesFetched: 5,
        }
      }),
    } as unknown as RealSyncWorker

    const logger = {
      debug: mock(() => {}),
      info: mock(() => {}),
      warn: mock(() => {}),
      error: mock(() => {}),
    }

    const runner = createSyncWorkerRunner(worker, {
      pollIntervalMs: 999,
      shouldStop: () => calls > 0,
      logger,
    })

    await runner.start()

    expect(logger.debug).toHaveBeenCalled()
    expect(timer.delays).toContain(100)
  })

  it('logs job failures when result contains error', async () => {
    const timer = createImmediateTimeout()
    restoreTimers = timer.restore

    let calls = 0
    const worker: RealSyncWorker = {
      runOnceReal: mock(async () => {
        calls += 1
        return {
          success: false,
          messagesFetched: 0,
          error: 'job failed',
        }
      }),
    } as unknown as RealSyncWorker

    const logger = {
      debug: mock(() => {}),
      info: mock(() => {}),
      warn: mock(() => {}),
      error: mock(() => {}),
    }

    const runner = createSyncWorkerRunner(worker, {
      pollIntervalMs: 250,
      shouldStop: () => calls > 0,
      logger,
    })

    await runner.start()

    expect(logger.error).toHaveBeenCalled()
    expect(timer.delays).toContain(100)
  })

  it('stop halts the loop and updates running state', async () => {
    const timer = createImmediateTimeout()
    restoreTimers = timer.restore

    let runner: ReturnType<typeof createSyncWorkerRunner>
    const worker: RealSyncWorker = {
      runOnceReal: mock(async () => {
        runner.stop()
        return { success: true, messagesFetched: 1 }
      }),
    } as unknown as RealSyncWorker

    runner = createSyncWorkerRunner(worker, {
      pollIntervalMs: 50,
      shouldStop: () => false,
      logger: {
        debug: mock(() => {}),
        info: mock(() => {}),
        warn: mock(() => {}),
        error: mock(() => {}),
      },
    })

    await runner.start()

    expect(runner.isRunning()).toBe(false)
  })

  it('logs worker errors and waits before retrying', async () => {
    const timer = createImmediateTimeout()
    restoreTimers = timer.restore

    let calls = 0
    const worker: RealSyncWorker = {
      runOnceReal: mock(async () => {
        calls += 1
        throw new Error('boom')
      }),
    } as unknown as RealSyncWorker

    const logger = {
      debug: mock(() => {}),
      info: mock(() => {}),
      warn: mock(() => {}),
      error: mock(() => {}),
    }

    const runner = createSyncWorkerRunner(worker, {
      pollIntervalMs: 300,
      shouldStop: () => calls > 0,
      logger,
    })

    await runner.start()

    expect(logger.error).toHaveBeenCalled()
    expect(timer.delays).toContain(300)
  })
})
