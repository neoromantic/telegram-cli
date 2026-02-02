/**
 * SQL command integration tests
 */
import type { Database } from 'bun:sqlite'
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
} from 'bun:test'

import { createTestCacheDatabase } from '../db/schema'
import { createUsersCache } from '../db/users-cache'
import { ErrorCodes, type ErrorCode } from '../types'
import { resetOutputWriter, setOutputWriter } from '../utils/output'

let testCacheDb: Database

mock.module('../db', () => ({
  getCacheDb: () => testCacheDb,
}))

const outputLogs: string[] = []
const outputWriter = {
  log: (message: string) => outputLogs.push(message),
  error: (message: string) => outputLogs.push(message),
}

async function expectCommandError(
  run: Promise<unknown>,
  code: ErrorCode,
): Promise<void> {
  try {
    await run
  } catch (err) {
    expect((err as { code?: ErrorCode }).code).toBe(code)
    return
  }
  throw new Error('Expected command to throw')
}

describe('SQL Commands', () => {
  beforeEach(() => {
    const { db } = createTestCacheDatabase()
    testCacheDb = db
    outputLogs.length = 0
    setOutputWriter(outputWriter)

    const usersCache = createUsersCache(testCacheDb)
    usersCache.upsert({
      user_id: '1',
      username: 'alice',
      first_name: 'Alice',
      last_name: 'Doe',
      phone: null,
      access_hash: null,
      is_contact: 1,
      is_bot: 0,
      is_premium: 0,
      fetched_at: Date.now(),
      raw_json: JSON.stringify({ id: 1, username: 'alice' }),
    })
  })

  afterEach(() => {
    resetOutputWriter()
    testCacheDb.close()
  })

  describe('sqlQueryCommand', () => {
    it('returns JSON output for valid query', async () => {
      const { sqlQueryCommand } = await import('../commands/sql/query')
      const run = sqlQueryCommand.run as (input: { args: any }) => Promise<void>

      await run({
        args: {
          query: 'SELECT user_id, username FROM users_cache',
          format: 'json',
          limit: '1000',
          _: [],
        },
      })

      expect(outputLogs.length).toBeGreaterThan(0)
      const parsed = JSON.parse(outputLogs[0]!)
      expect(parsed.success).toBe(true)
      expect(parsed.data.rowCount).toBe(1)
      expect(parsed.data.columns).toEqual(['user_id', 'username'])
    })

    it('prints CSV output when format=csv', async () => {
      const { sqlQueryCommand } = await import('../commands/sql/query')
      const run = sqlQueryCommand.run as (input: { args: any }) => Promise<void>
      const logSpy = spyOn(console, 'log').mockImplementation(() => {})

      await run({
        args: {
          query: 'SELECT user_id FROM users_cache',
          format: 'csv',
          limit: '1000',
          _: [],
        },
      })

      expect(logSpy).toHaveBeenCalled()
      const firstCall = logSpy.mock.calls[0]?.[0] as string
      expect(firstCall).toContain('user_id')

      logSpy.mockRestore()
    })

    it('rejects missing query', async () => {
      const { sqlQueryCommand } = await import('../commands/sql/query')
      const run = sqlQueryCommand.run as (input: { args: any }) => Promise<void>
      await expectCommandError(
        run({ args: { _: [] } }),
        ErrorCodes.INVALID_ARGS,
      )
    })

    it('rejects invalid format', async () => {
      const { sqlQueryCommand } = await import('../commands/sql/query')
      const run = sqlQueryCommand.run as (input: { args: any }) => Promise<void>
      await expectCommandError(
        run({
          args: { query: 'SELECT 1', format: 'xml', limit: '10', _: [] },
        }),
        ErrorCodes.INVALID_ARGS,
      )
    })

    it('rejects invalid limit', async () => {
      const { sqlQueryCommand } = await import('../commands/sql/query')
      const run = sqlQueryCommand.run as (input: { args: any }) => Promise<void>
      await expectCommandError(
        run({
          args: { query: 'SELECT 1', format: 'json', limit: '-1', _: [] },
        }),
        ErrorCodes.INVALID_ARGS,
      )
    })

    it('rejects write queries', async () => {
      const { sqlQueryCommand } = await import('../commands/sql/query')
      const run = sqlQueryCommand.run as (input: { args: any }) => Promise<void>
      await expectCommandError(
        run({
          args: { query: 'DELETE FROM users_cache', format: 'json', _: [] },
        }),
        ErrorCodes.SQL_WRITE_NOT_ALLOWED,
      )
    })

    it('reports syntax errors', async () => {
      const { sqlQueryCommand } = await import('../commands/sql/query')
      const run = sqlQueryCommand.run as (input: { args: any }) => Promise<void>
      await expectCommandError(
        run({
          args: {
            query: 'SELECT * FORM users_cache',
            format: 'json',
            _: [],
          },
        }),
        ErrorCodes.SQL_SYNTAX_ERROR,
      )
    })

    it('reports missing tables', async () => {
      const { sqlQueryCommand } = await import('../commands/sql/query')
      const run = sqlQueryCommand.run as (input: { args: any }) => Promise<void>
      await expectCommandError(
        run({
          args: {
            query: 'SELECT * FROM missing_table',
            format: 'json',
            _: [],
          },
        }),
        ErrorCodes.SQL_TABLE_NOT_FOUND,
      )
    })
  })

  describe('printSchemaCommand', () => {
    it('prints JSON schema for a table', async () => {
      const { printSchemaCommand } = await import(
        '../commands/sql/print-schema'
      )
      const run = printSchemaCommand.run as (input: { args: any }) => Promise<void>

      await run({
        args: { table: 'users_cache', format: 'json', _: [] },
      })

      const parsed = JSON.parse(outputLogs[0]!)
      expect(parsed.success).toBe(true)
      expect(parsed.data.table).toBe('users_cache')
      expect(parsed.data.columns.length).toBeGreaterThan(0)
    })

    it('prints text schema for a table', async () => {
      const { printSchemaCommand } = await import(
        '../commands/sql/print-schema'
      )
      const run = printSchemaCommand.run as (input: { args: any }) => Promise<void>
      const logSpy = spyOn(console, 'log').mockImplementation(() => {})

      await run({
        args: { table: 'users_cache', format: 'text', _: [] },
      })

      expect(logSpy).toHaveBeenCalled()
      const firstCall = logSpy.mock.calls[0]?.[0] as string
      expect(firstCall).toContain('users_cache')

      logSpy.mockRestore()
    })

    it('rejects invalid format', async () => {
      const { printSchemaCommand } = await import(
        '../commands/sql/print-schema'
      )
      const run = printSchemaCommand.run as (input: { args: any }) => Promise<void>
      await expectCommandError(
        run({
          args: { table: 'users_cache', format: 'yaml', _: [] },
        }),
        ErrorCodes.INVALID_ARGS,
      )
    })

    it('rejects unknown table', async () => {
      const { printSchemaCommand } = await import(
        '../commands/sql/print-schema'
      )
      const run = printSchemaCommand.run as (input: { args: any }) => Promise<void>
      await expectCommandError(
        run({
          args: { table: 'unknown_table', format: 'json', _: [] },
        }),
        ErrorCodes.SQL_TABLE_NOT_FOUND,
      )
    })
  })
})
