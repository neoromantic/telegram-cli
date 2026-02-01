/**
 * E2E tests for exit codes
 *
 * Verifies that the CLI returns correct exit codes for various scenarios.
 * Exit code mapping:
 * - 0: Success
 * - 2: AUTH_REQUIRED
 * - 3: INVALID_ARGS
 * - 4: NETWORK_ERROR
 * - 5: TELEGRAM_ERROR
 * - 6: ACCOUNT_NOT_FOUND
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { runCliFailure, runCliSuccess } from './helpers/cli'
import { createTestEnvironment, type TestEnvironment } from './helpers/setup'

describe('E2E: Exit Codes', () => {
  let env: TestEnvironment

  beforeEach(() => {
    env = createTestEnvironment('exit-codes')
    env.initDatabase()
  })

  afterEach(() => {
    env.cleanup()
  })

  describe('exit code 0 (success)', () => {
    it('should return 0 for successful accounts list', async () => {
      const result = await runCliSuccess(
        ['accounts', 'list'],
        env.getCliOptions(),
      )

      expect(result.exitCode).toBe(0)
      expect(result.json).toBeDefined()
      expect((result.json as { success: boolean }).success).toBe(true)
    })

    it('should return 0 for help commands', async () => {
      const result = await runCliSuccess(['--help'])

      expect(result.exitCode).toBe(0)
    })

    it('should return 0 for version', async () => {
      const result = await runCliSuccess(['--version'])

      expect(result.exitCode).toBe(0)
    })
  })

  describe('exit code 6 (ACCOUNT_NOT_FOUND)', () => {
    it('should return 6 when switching to non-existent account', async () => {
      const result = await runCliFailure(
        ['accounts', 'switch', '--id', '9999'],
        6,
        env.getCliOptions(),
      )

      expect(result.exitCode).toBe(6)
      expect(result.json).toBeDefined()

      const response = result.json as {
        success: boolean
        error: { code: string }
      }
      expect(response.success).toBe(false)
      expect(response.error.code).toBe('ACCOUNT_NOT_FOUND')
    })

    it('should return 6 when removing non-existent account', async () => {
      const result = await runCliFailure(
        ['accounts', 'remove', '--id', '9999'],
        6,
        env.getCliOptions(),
      )

      expect(result.exitCode).toBe(6)
    })

    it('should return 6 when getting info for non-existent account', async () => {
      const result = await runCliFailure(
        ['accounts', 'info', '--id', '9999'],
        6,
        env.getCliOptions(),
      )

      expect(result.exitCode).toBe(6)
    })

    it('should return 6 when getting info with no active account', async () => {
      // Database is empty, no active account
      const result = await runCliFailure(
        ['accounts', 'info'],
        6,
        env.getCliOptions(),
      )

      expect(result.exitCode).toBe(6)
    })
  })

  describe('exit code with seeded data', () => {
    beforeEach(() => {
      env.seedAccounts([
        { phone: '+1111111111', name: 'Account 1', is_active: true },
        { phone: '+2222222222', name: 'Account 2', is_active: false },
      ])
    })

    it('should return 0 when switching to existing account', async () => {
      const result = await runCliSuccess(
        ['accounts', 'switch', '--id', '1'],
        env.getCliOptions(),
      )

      expect(result.exitCode).toBe(0)
    })

    it('should return 0 when getting info for active account', async () => {
      const result = await runCliSuccess(
        ['accounts', 'info'],
        env.getCliOptions(),
      )

      expect(result.exitCode).toBe(0)
      expect(
        (result.json as { data: { account: { id: number } } }).data.account.id,
      ).toBe(1)
    })
  })
})
