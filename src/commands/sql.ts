/**
 * SQL command for direct database access
 * Read-only queries against the cache database
 */
import { defineCommand } from 'citty'

import { getCacheDb } from '../db'
import {
  getColumnNames,
  getTableAnnotation,
  getTableNames,
  SCHEMA_REGISTRY,
  type TableAnnotation,
} from '../db/schema-annotations'
import { ErrorCodes } from '../types'
import { stringify as stringifyCsv } from '../utils/csv'
import { error, success } from '../utils/output'

/** Keywords that indicate a write operation */
const WRITE_KEYWORDS = [
  'INSERT',
  'UPDATE',
  'DELETE',
  'REPLACE',
  'DROP',
  'ALTER',
  'CREATE',
  'TRUNCATE',
  'ATTACH',
  'DETACH',
  'VACUUM',
  'REINDEX',
]

/**
 * Check if a query is read-only (SELECT only)
 */
export function isReadOnlyQuery(query: string): boolean {
  // Normalize: trim, collapse whitespace, uppercase for comparison
  const normalized = query.trim().replace(/\s+/g, ' ').toUpperCase()

  // Must start with SELECT, WITH, or PRAGMA (for schema inspection)
  const startsWithAllowed =
    normalized.startsWith('SELECT ') ||
    normalized.startsWith('WITH ') ||
    normalized.startsWith('PRAGMA ')

  if (!startsWithAllowed) {
    return false
  }

  // Check for any write keywords that might be embedded (e.g., in CTEs with side effects)
  for (const keyword of WRITE_KEYWORDS) {
    // Match keyword at word boundary to avoid false positives
    const regex = new RegExp(`\\b${keyword}\\b`, 'i')
    if (regex.test(normalized)) {
      return false
    }
  }

  return true
}

/**
 * Format schema for text output
 */
function formatSchemaAsText(
  tableName: string,
  annotation: TableAnnotation,
): string {
  const lines: string[] = []

  lines.push(`Table: ${tableName}`)
  lines.push(`Description: ${annotation.description}`)

  if (annotation.ttl) {
    lines.push(`TTL: ${annotation.ttl}`)
  }

  const pk = Array.isArray(annotation.primaryKey)
    ? annotation.primaryKey.join(', ')
    : annotation.primaryKey
  lines.push(`Primary Key: ${pk}`)

  lines.push('')
  lines.push('Columns:')

  for (const [colName, col] of Object.entries(annotation.columns)) {
    const flags: string[] = []
    if (
      Array.isArray(annotation.primaryKey)
        ? annotation.primaryKey.includes(colName)
        : annotation.primaryKey === colName
    ) {
      flags.push('PK')
    }
    if (col.nullable === false) {
      flags.push('NN')
    }
    if (col.defaultValue !== undefined) {
      flags.push(`=${col.defaultValue}`)
    }

    const flagStr = flags.length > 0 ? `  [${flags.join(', ')}]` : ''
    lines.push(`  ${colName}${flagStr}`)
    lines.push(`    ${col.description}`)

    if (col.enumValues) {
      lines.push(`    Values: ${col.enumValues.join(', ')}`)
    }
    if (col.semanticType) {
      lines.push(`    Type: ${col.semanticType}`)
    }
  }

  if (annotation.indexes && Object.keys(annotation.indexes).length > 0) {
    lines.push('')
    lines.push('Indexes:')
    for (const [indexName, desc] of Object.entries(annotation.indexes)) {
      lines.push(`  ${indexName}: ${desc}`)
    }
  }

  return lines.join('\n')
}

/**
 * Print schema subcommand
 */
export const printSchemaCommand = defineCommand({
  meta: {
    name: 'print-schema',
    description: 'Display database schema with annotations',
  },
  args: {
    table: {
      type: 'string',
      alias: 't',
      description: 'Show schema for specific table only',
    },
    format: {
      type: 'string',
      alias: 'f',
      description: 'Output format: json, text (default: json)',
      default: 'json',
    },
  },
  async run({ args }) {
    const format = args.format ?? 'json'
    const tableName = args.table

    // Validate format
    if (format !== 'json' && format !== 'text') {
      error(
        ErrorCodes.INVALID_ARGS,
        `Invalid format: ${format}. Use 'json' or 'text'.`,
      )
    }

    // Single table
    if (tableName) {
      const annotation = getTableAnnotation(tableName)

      if (!annotation) {
        const available = getTableNames().join(', ')
        error(
          ErrorCodes.SQL_TABLE_NOT_FOUND,
          `Table '${tableName}' not found. Available tables: ${available}`,
        )
      }

      if (format === 'text') {
        console.log(formatSchemaAsText(tableName, annotation))
        return
      }

      // Get actual column info from database
      const db = getCacheDb()
      const tableInfo = db
        .query(`PRAGMA table_info(${tableName})`)
        .all() as Array<{
        name: string
        type: string
        notnull: number
        pk: number
        dflt_value: unknown
      }>

      // Merge runtime info with annotations
      const columns = tableInfo.map((col) => {
        const colAnnotation = annotation.columns[col.name]
        return {
          name: col.name,
          type: col.type,
          nullable: col.notnull === 0,
          primaryKey: col.pk > 0,
          defaultValue: col.dflt_value,
          description: colAnnotation?.description ?? '',
          semanticType: colAnnotation?.semanticType,
          enumValues: colAnnotation?.enumValues,
        }
      })

      // Get index info
      const indexList = db
        .query(`PRAGMA index_list(${tableName})`)
        .all() as Array<{
        name: string
        unique: number
      }>

      const indexes = indexList.map((idx) => {
        const indexInfo = db
          .query(`PRAGMA index_info(${idx.name})`)
          .all() as Array<{
          name: string
        }>
        return {
          name: idx.name,
          columns: indexInfo.map((i) => i.name),
          description: annotation.indexes?.[idx.name],
        }
      })

      success({
        table: tableName,
        description: annotation.description,
        ttl: annotation.ttl,
        primaryKey: annotation.primaryKey,
        columns,
        indexes,
      })
      return
    }

    // All tables
    if (format === 'text') {
      const tableNames = getTableNames()
      for (const name of tableNames) {
        const annotation = getTableAnnotation(name)
        if (annotation) {
          console.log(formatSchemaAsText(name, annotation))
          console.log(`\n${'='.repeat(80)}\n`)
        }
      }
      return
    }

    // JSON format - full schema
    success({
      version: SCHEMA_REGISTRY.version,
      tables: Object.keys(SCHEMA_REGISTRY.tables).map((name) => {
        const table = SCHEMA_REGISTRY.tables[name]!
        return {
          name,
          description: table.description,
          ttl: table.ttl,
          primaryKey: table.primaryKey,
          columnCount: getColumnNames(name).length,
        }
      }),
    })
  },
})

/**
 * Execute SQL query command
 */
export const sqlQueryCommand = defineCommand({
  meta: {
    name: 'sql',
    description: 'Execute read-only SQL queries on the cache database',
  },
  args: {
    query: {
      type: 'string',
      alias: 'q',
      description: 'SQL query to execute',
    },
    format: {
      type: 'string',
      alias: 'f',
      description: 'Output format: json, csv (default: json)',
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
  async run({ args }) {
    // Support both --query/-q and positional arg (from args._)
    const positionalArgs = (args._ as string[] | undefined) ?? []
    const query = (args.query as string | undefined) ?? positionalArgs[0]
    const format = args.format ?? 'json'
    const limitStr = args.limit ?? '1000'
    const limit = Number.parseInt(limitStr, 10)

    // If no query provided, show help hint
    if (!query) {
      error(
        ErrorCodes.INVALID_ARGS,
        'No query provided. Usage: tg sql -q "<query>" or tg sql print-schema',
      )
    }

    // Validate format
    if (format !== 'json' && format !== 'csv') {
      error(
        ErrorCodes.INVALID_ARGS,
        `Invalid format: ${format}. Use 'json' or 'csv'.`,
      )
    }

    // Validate read-only
    if (!isReadOnlyQuery(query)) {
      error(
        ErrorCodes.SQL_WRITE_NOT_ALLOWED,
        'Write operations are not allowed. Only SELECT queries are permitted.',
        { query },
      )
    }

    try {
      const db = getCacheDb()

      // Apply LIMIT if not already present and limit > 0
      let finalQuery = query
      if (limit > 0 && !query.toUpperCase().includes(' LIMIT ')) {
        finalQuery = `${query} LIMIT ${limit}`
      }

      // Execute query
      const rows = db.query(finalQuery).all() as Record<string, unknown>[]

      // Determine columns from first row or empty array
      const columns = rows.length > 0 ? Object.keys(rows[0]!) : []

      // CSV output
      if (format === 'csv') {
        const csv = stringifyCsv(rows, columns)
        console.log(csv)
        return
      }

      // JSON output
      success({
        columns,
        rows,
        rowCount: rows.length,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)

      // Parse SQLite errors
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

      // Generic error
      error(ErrorCodes.GENERAL_ERROR, `Query failed: ${message}`, { query })
    }
  },
})

export { sqlQueryCommand as sqlCommand }
