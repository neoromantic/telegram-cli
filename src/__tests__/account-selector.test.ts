/**
 * Account selector tests
 */
import { describe, expect, it } from 'bun:test'

import { createTestDatabase } from '../db'
import { ErrorCodes } from '../types'
import { resolveAccountSelector } from '../utils/account-selector'

process.env.BUN_ENV = 'test'

describe('resolveAccountSelector', () => {
  it('returns undefined when selector is not provided', () => {
    const result = resolveAccountSelector(
      undefined,
      createTestDatabase().accountsDb,
    )
    expect(result).toBeUndefined()
  })

  it('resolves numeric account IDs', () => {
    const { accountsDb } = createTestDatabase()
    const account = accountsDb.create({ phone: '+1111111111' })

    const result = resolveAccountSelector(String(account.id), accountsDb)
    expect(result).toBe(account.id)
  })

  it('resolves @username selectors', () => {
    const { accountsDb } = createTestDatabase()
    const account = accountsDb.create({
      phone: '+1111111111',
      username: 'TestUser',
    })

    const result = resolveAccountSelector('@testuser', accountsDb)
    expect(result).toBe(account.id)
  })

  it('resolves label selectors', () => {
    const { accountsDb } = createTestDatabase()
    const account = accountsDb.create({
      phone: '+1111111111',
      label: 'Work',
    })

    const result = resolveAccountSelector('Work', accountsDb)
    expect(result).toBe(account.id)
  })

  it('throws when label matches multiple accounts', () => {
    const { accountsDb } = createTestDatabase()
    accountsDb.create({ phone: '+1111111111', label: 'Work' })
    accountsDb.create({ phone: '+2222222222', label: 'Work' })

    expect(() => resolveAccountSelector('Work', accountsDb)).toThrow(
      'Multiple accounts match label',
    )
  })

  it('throws when selector does not match any account', () => {
    const { accountsDb } = createTestDatabase()

    try {
      resolveAccountSelector('Missing', accountsDb)
      throw new Error('Expected error')
    } catch (err) {
      const typed = err as Error & { code?: string }
      expect(typed.code).toBe(ErrorCodes.ACCOUNT_NOT_FOUND)
    }
  })
})
