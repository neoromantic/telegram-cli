import { defineCommand } from 'citty'

import { getCacheDb } from '../../db'
import { getTableNames } from '../../db/schema-annotations'
import { ErrorCodes } from '../../types'
import { stringify as stringifyCsv } from '../../utils/csv'
import { error, success } from '../../utils/output'
import { applyQueryLimit, isReadOnlyQuery } from './helpers'
import { printSchemaCommand } from './print-schema'

type QueryArgs = {
  query?: string
  format?: string
  limit?: string
  _?: string[]
}

function parseQueryArgs(args: QueryArgs) {
  const positionalArgs = args._ ?? []
  const query = args.query ?? positionalArgs[0]
  const format = args.format ?? 'json'
  const limitStr = args.limit ?? '1000'
  const limit = Number.parseInt(limitStr, 10)

  return { query, format, limit, limitStr }
}

function validateQueryArgs(
  query: string | undefined,
  format: string,
  limit: number,
  limitStr: string,
): void {
  if (!query) {
    error(
      ErrorCodes.INVALID_ARGS,
      'No query provided. Usage: tg sql -q "<query>" or tg sql print-schema',
    )
  }

  if (format !== 'json' && format !== 'csv') {
    error(
      ErrorCodes.INVALID_ARGS,
      `Invalid format: ${format}. Use 'json' or 'csv'.`,
    )
  }

  if (Number.isNaN(limit) || limit < 0) {
    error(
      ErrorCodes.INVALID_ARGS,
      `Invalid limit: ${limitStr}. Use a non-negative integer.`,
    )
  }

  if (!isReadOnlyQuery(query)) {
    error(
      ErrorCodes.SQL_WRITE_NOT_ALLOWED,
      'Write operations are not allowed. Only SELECT queries are permitted.',
      { query },
    )
  }
}

function formatSqlError(message: string, query: string): never {
  if (message.includes('no such table')) {
    const match = message.match(/no such table: (\w+)/)
    const tableName = match?.[1] ?? 'unknown'
    const available = getTableNames().join(', ')
    error(
      ErrorCodes.SQL_TABLE_NOT_FOUND,
      `Table '${tableName}' not found. Available tables: ${available}`,
      { query },
    )
  }

  if (message.includes('syntax error') || message.includes('near "')) {
    error(ErrorCodes.SQL_SYNTAX_ERROR, message, { query })
  }

  error(ErrorCodes.GENERAL_ERROR, `Query failed: ${message}`, { query })
}

export const sqlQueryCommand = defineCommand({
  meta: {
    name: 'sql',
    description: 'Execute read-only SQL queries on the cache database',
  },
  args: {
    query: {
      type: 'string',
      alias: 'q',
      description: 'SQL query to execute (required unless using a subcommand)',
    },
    format: {
      type: 'enum',
      alias: 'f',
      description: 'Output format: json or csv',
      options: ['json', 'csv'],
      default: 'json',
    },
    limit: {
      type: 'string',
      alias: 'l',
      description: 'Maximum rows to return (default: 1000, 0 = unlimited)',
      default: '1000',
    },
  },
  subCommands: {
    'print-schema': printSchemaCommand,
  },
  async run({ args, rawArgs }) {
    // Skip parent command execution if a subcommand was invoked
    const subCommands = ['print-schema']
    if (rawArgs?.some((arg) => subCommands.includes(arg))) {
      return
    }

    const { query, format, limit, limitStr } = parseQueryArgs(args as QueryArgs)
    validateQueryArgs(query, format, limit, limitStr)

    try {
      const db = getCacheDb()
      const finalQuery = applyQueryLimit(query!, limit)
      const rows = db.query(finalQuery).all() as Record<string, unknown>[]
      const columns = rows.length > 0 ? Object.keys(rows[0]!) : []

      if (format === 'csv') {
        const csv = stringifyCsv(rows, columns)
        console.log(csv)
        return
      }

      success({
        columns,
        rows,
        rowCount: rows.length,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      formatSqlError(message, query!)
    }
  },
})
