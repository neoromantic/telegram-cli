/**
 * Unit tests for daemon account helpers (no getCacheDb dependency)
 */
import { describe, expect, it, mock } from 'bun:test'
import {
  closeClientSafe,
  removeEventHandlers,
  scheduleReconnect,
  setupSignalHandlers,
} from '../daemon/daemon-accounts'
import {
  createDaemonRuntime,
  type DaemonContext,
} from '../daemon/daemon-context'
import type { AccountConnectionState } from '../daemon/types'

class MockEvent<T extends (...args: any[]) => void> {
  handlers: T[] = []
  add = (handler: T) => {
    this.handlers.push(handler)
  }
  remove = (handler: T) => {
    this.handlers = this.handlers.filter((entry) => entry !== handler)
  }
}

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
    pidPath: '/tmp/tgcli.pid',
    verbosity: 'normal',
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
      getPath: () => '/tmp/tgcli.pid',
    },
    state: {
      running: true,
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

describe('removeEventHandlers', () => {
  it('clears handlers and unregisters events', () => {
    const ctx = createContext()
    const client = {
      onNewMessage: new MockEvent<(msg: any) => void>(),
      onEditMessage: new MockEvent<(msg: any) => void>(),
      onDeleteMessage: new MockEvent<(update: any) => void>(),
    }

    const accountState: AccountConnectionState = {
      accountId: 1,
      phone: '+10000000000',
      name: null,
      status: 'connected',
      client: client as any,
      eventHandlers: {
        onNewMessage: () => {},
        onEditMessage: () => {},
        onDeleteMessage: () => {},
      },
    }

    removeEventHandlers(ctx, accountState)

    expect(accountState.eventHandlers).toBeUndefined()
    expect(accountState.updateHandlers).toBeUndefined()
  })
})

describe('reconnect scheduling', () => {
  it('schedules next reconnect when under max attempts', () => {
    const ctx = createContext()
    const accountState: AccountConnectionState = {
      accountId: 2,
      phone: '+12223334444',
      name: null,
      status: 'error',
      reconnectAttempts: 0,
    }

    scheduleReconnect(ctx, accountState)

    expect(accountState.reconnectAttempts).toBe(1)
    expect(accountState.nextReconnectAt).toBeDefined()
  })

  it('does not schedule reconnect after max attempts', () => {
    const ctx = createContext()
    const accountState: AccountConnectionState = {
      accountId: 3,
      phone: '+19990000000',
      name: null,
      status: 'error',
      reconnectAttempts: 2,
    }

    scheduleReconnect(ctx, accountState)

    expect(accountState.nextReconnectAt).toBeUndefined()
  })
})

describe('signal/cleanup helpers', () => {
  it('setupSignalHandlers marks runtime and installs handlers once', () => {
    const ctx = createContext()
    const calls: string[] = []
    const originalOn = process.on

    process.on = ((signal: string, handler: (...args: any[]) => void) => {
      calls.push(signal)
      return originalOn.call(process, signal, handler)
    }) as typeof process.on

    try {
      setupSignalHandlers(ctx)
      setupSignalHandlers(ctx)
    } finally {
      process.on = originalOn
    }

    expect(ctx.runtime.signalHandlersSetup).toBe(true)
    expect(calls.filter((signal) => signal === 'SIGTERM').length).toBe(1)
  })

  it('closeClientSafe ignores missing close and logs errors', async () => {
    const ctx = createContext()
    const clientWithoutClose = {} as any

    await closeClientSafe(ctx, clientWithoutClose, 'noop')

    const errorClient = {
      close: () => {
        throw new Error('boom')
      },
    } as any

    await closeClientSafe(ctx, errorClient, 'error')
    expect(ctx.logger.warn).toHaveBeenCalled()
  })
})
