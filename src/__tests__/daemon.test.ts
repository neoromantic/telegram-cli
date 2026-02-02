/**
 * Tests for daemon lifecycle (no module mocks)
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createDaemon } from '../daemon/daemon'
import { DaemonExitCode } from '../daemon/types'
import type { AccountsDbInterface } from '../db'
import type { Account } from '../types'

function createAccountsDb(
  accounts: Array<{ id: number; phone: string }>,
): AccountsDbInterface {
  const normalized: Account[] = accounts.map((account) => ({
    id: account.id,
    phone: account.phone,
    user_id: null,
    name: null,
    username: null,
    label: null,
    session_data: '',
    is_active: 0,
    created_at: '',
    updated_at: '',
  }))

  return {
    getAll: () => normalized,
    getById: (id: number) => normalized.find((acc) => acc.id === id) ?? null,
    getByPhone: (phone: string) =>
      normalized.find((acc) => acc.phone === phone) ?? null,
    getByUserId: () => null,
    getByUsername: () => null,
    getAllByLabel: () => [],
    getActive: () => null,
    create: () => {
      throw new Error('not used')
    },
    update: () => null,
    updateSession: () => {},
    setActive: () => {},
    delete: () => false,
    count: () => accounts.length,
  }
}

const tempDir = join(process.cwd(), '.tmp', 'daemon-tests')
const pidPath = join(tempDir, `daemon-${process.pid}.pid`)

afterEach(() => {
  rmSync(pidPath, { force: true })
})

describe('daemon start', () => {
  it('returns AlreadyRunning when PID file points to current process', async () => {
    mkdirSync(tempDir, { recursive: true })
    writeFileSync(pidPath, String(process.pid))

    const daemon = createDaemon(
      { pidPath, shutdownTimeoutMs: 1_000_000 },
      createAccountsDb([{ id: 1, phone: '+1' }]),
    )

    const exitCode = await daemon.start()

    expect(exitCode).toBe(DaemonExitCode.AlreadyRunning)
  })

  it('returns NoAccounts when no accounts configured', async () => {
    const daemon = createDaemon(
      { pidPath, shutdownTimeoutMs: 1_000_000 },
      createAccountsDb([]),
    )

    const exitCode = await daemon.start()

    expect(exitCode).toBe(DaemonExitCode.NoAccounts)
  })
})

describe('daemon status', () => {
  it('returns baseline status when not running', () => {
    const daemon = createDaemon({}, createAccountsDb([]))

    const status = daemon.getStatus()

    expect(status.running).toBe(false)
    expect(status.totalAccounts).toBe(0)
    expect(status.connectedAccounts).toBe(0)
  })

  it('stop requests shutdown', () => {
    const daemon = createDaemon({}, createAccountsDb([]))

    daemon.stop()

    const status = daemon.getStatus()
    expect(status.running).toBe(false)
  })
})
