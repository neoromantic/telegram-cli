/**
 * Tests for daemon context defaults
 */
import { describe, expect, it } from 'bun:test'
import { createDaemonRuntime } from '../daemon/daemon-context'

describe('daemon-context', () => {
  it('creates runtime with sane defaults', () => {
    const runtime = createDaemonRuntime()

    expect(runtime.scheduler).toBeNull()
    expect(runtime.syncWorkers.size).toBe(0)
    expect(runtime.lastJobProcessTime).toBe(0)
    expect(runtime.totalMessagesSynced).toBe(0)
    expect(runtime.signalHandlersSetup).toBe(false)
    expect(runtime.statusService).toBeNull()
  })
})
