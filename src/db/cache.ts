/**
 * Generic cache service for managing cached entities
 * Works with any cache table (users_cache, chats_cache, etc.)
 */
import type { Database, Statement } from 'bun:sqlite'

import type { CacheConfig, CachedEntity } from './types'
import { getDefaultCacheConfig, isCacheStale } from './types'

/**
 * Cache statistics for a table
 */
export interface CacheStats {
  /** Total number of entries */
  total: number
  /** Number of stale entries */
  stale: number
  /** Oldest fetched_at timestamp (null if no entries) */
  oldest: number | null
}

/**
 * Generic cache service for managing cached entities
 * Provides CRUD operations with staleness tracking
 */
export class CacheService {
  private statementCache: Map<string, Statement> = new Map()

  constructor(
    private db: Database,
    private config: CacheConfig = getDefaultCacheConfig(),
  ) {}

  /**
   * Get a prepared statement, creating and caching it if needed
   */
  private getStatement(key: string, sql: string): Statement {
    let stmt = this.statementCache.get(key)
    if (!stmt) {
      stmt = this.db.prepare(sql)
      this.statementCache.set(key, stmt)
    }
    return stmt
  }

  /**
   * Get entity from cache by primary key
   * Returns null if not found
   */
  get<T extends CachedEntity>(
    table: string,
    keyColumn: string,
    key: string,
  ): T | null {
    const stmtKey = `get:${table}:${keyColumn}`
    const sql = `SELECT * FROM ${table} WHERE ${keyColumn} = $key`
    const stmt = this.getStatement(stmtKey, sql)

    const row = stmt.get({ $key: key }) as T | null
    return row ?? null
  }

  /**
   * Insert or update entity in cache
   * Automatically sets created_at (on insert) and updated_at (always)
   * The key parameter ensures the correct primary key value is used
   */
  set<T extends CachedEntity>(
    table: string,
    keyColumn: string,
    key: string,
    data: Omit<T, 'created_at' | 'updated_at'>,
  ): void {
    const now = Date.now()

    // Merge the key into data to ensure it's set correctly
    const dataWithKey = { ...data, [keyColumn]: key }

    // Get column names from data, excluding timestamps we'll handle
    const dataKeys = Object.keys(dataWithKey)
    const columns = [...dataKeys, 'created_at', 'updated_at']

    // Build column list and parameter placeholders
    const columnList = columns.join(', ')
    const paramList = columns.map((col) => `$${col}`).join(', ')

    // Build ON CONFLICT update clause (update all columns except created_at and the key)
    const updateCols = dataKeys.filter((col) => col !== keyColumn)
    updateCols.push('updated_at')
    const updateClause = updateCols
      .map((col) => `${col} = excluded.${col}`)
      .join(', ')

    const sql = `
      INSERT INTO ${table} (${columnList})
      VALUES (${paramList})
      ON CONFLICT(${keyColumn}) DO UPDATE SET ${updateClause}
    `

    const stmtKey = `set:${table}:${keyColumn}:${columnList}`
    const stmt = this.getStatement(stmtKey, sql)

    // Build parameters object
    const params: Record<string, unknown> = {}
    for (const col of dataKeys) {
      params[`$${col}`] = (dataWithKey as Record<string, unknown>)[col]
    }
    params.$created_at = now
    params.$updated_at = now

    stmt.run(params)
  }

  /**
   * Delete entity from cache
   * Returns true if entity was deleted, false if not found
   */
  delete(table: string, keyColumn: string, key: string): boolean {
    const stmtKey = `delete:${table}:${keyColumn}`
    const sql = `DELETE FROM ${table} WHERE ${keyColumn} = $key`
    const stmt = this.getStatement(stmtKey, sql)

    const result = stmt.run({ $key: key })
    return result.changes > 0
  }

  /**
   * Get all stale entries from a table
   * An entry is stale if (now - fetched_at) > ttlMs
   */
  getStaleEntries<T extends CachedEntity>(table: string, ttlMs: number): T[] {
    const threshold = Date.now() - ttlMs
    const stmtKey = `stale:${table}`
    const sql = `SELECT * FROM ${table} WHERE fetched_at < $threshold ORDER BY fetched_at ASC`
    const stmt = this.getStatement(stmtKey, sql)

    return stmt.all({ $threshold: threshold }) as T[]
  }

  /**
   * Prune entries older than maxAge based on fetched_at
   * Returns the number of entries deleted
   */
  pruneOldEntries(table: string, maxAgeMs: number): number {
    const threshold = Date.now() - maxAgeMs
    const stmtKey = `prune:${table}`
    const sql = `DELETE FROM ${table} WHERE fetched_at < $threshold`
    const stmt = this.getStatement(stmtKey, sql)

    const result = stmt.run({ $threshold: threshold })
    return result.changes
  }

  /**
   * Get cache statistics for a table
   */
  getStats(table: string, ttlMs?: number): CacheStats {
    // Use default peer TTL if not specified
    const staleTtl = ttlMs ?? this.config.staleness.peers
    const staleThreshold = Date.now() - staleTtl

    // Get total count
    const countStmtKey = `stats:count:${table}`
    const countSql = `SELECT COUNT(*) as count FROM ${table}`
    const countStmt = this.getStatement(countStmtKey, countSql)
    const countResult = countStmt.get() as { count: number } | null
    const total = countResult?.count ?? 0

    // Get stale count
    const staleStmtKey = `stats:stale:${table}`
    const staleSql = `SELECT COUNT(*) as count FROM ${table} WHERE fetched_at < $threshold`
    const staleStmt = this.getStatement(staleStmtKey, staleSql)
    const staleResult = staleStmt.get({ $threshold: staleThreshold }) as {
      count: number
    } | null
    const stale = staleResult?.count ?? 0

    // Get oldest entry
    const oldestStmtKey = `stats:oldest:${table}`
    const oldestSql = `SELECT MIN(fetched_at) as oldest FROM ${table}`
    const oldestStmt = this.getStatement(oldestStmtKey, oldestSql)
    const oldestResult = oldestStmt.get() as { oldest: number | null } | null
    const oldest = oldestResult?.oldest ?? null

    return { total, stale, oldest }
  }

  /**
   * Check if a cached entry is stale
   */
  isStale(fetchedAt: number | null, ttlMs?: number): boolean {
    const ttl = ttlMs ?? this.config.staleness.peers
    return isCacheStale(fetchedAt, ttl)
  }

  /**
   * Get multiple entities by their keys
   */
  getMany<T extends CachedEntity>(
    table: string,
    keyColumn: string,
    keys: string[],
  ): T[] {
    if (keys.length === 0) return []

    // For small sets, use IN clause
    const placeholders = keys.map((_, i) => `$key${i}`).join(', ')
    const sql = `SELECT * FROM ${table} WHERE ${keyColumn} IN (${placeholders})`

    // Can't cache this statement as placeholders vary
    const stmt = this.db.prepare(sql)

    const params: Record<string, string> = {}
    keys.forEach((key, i) => {
      params[`$key${i}`] = key
    })

    return stmt.all(params) as T[]
  }

  /**
   * Get all entries from a table with optional limit and offset
   */
  getAll<T extends CachedEntity>(
    table: string,
    options: { limit?: number; offset?: number; orderBy?: string } = {},
  ): T[] {
    const { limit, offset, orderBy = 'fetched_at DESC' } = options

    let sql = `SELECT * FROM ${table} ORDER BY ${orderBy}`
    if (limit !== undefined) {
      sql += ` LIMIT ${limit}`
    }
    if (offset !== undefined) {
      sql += ` OFFSET ${offset}`
    }

    const stmtKey = `all:${table}:${orderBy}:${limit}:${offset}`
    const stmt = this.getStatement(stmtKey, sql)

    return stmt.all() as T[]
  }

  /**
   * Clear all entries from a table
   * Returns the number of entries deleted
   */
  clear(table: string): number {
    const stmtKey = `clear:${table}`
    const sql = `DELETE FROM ${table}`
    const stmt = this.getStatement(stmtKey, sql)

    const result = stmt.run()
    return result.changes
  }

  /**
   * Get the cache configuration
   */
  getConfig(): CacheConfig {
    return this.config
  }

  /**
   * Update the cache configuration
   */
  setConfig(config: CacheConfig): void {
    this.config = config
  }
}

/**
 * Create a new CacheService instance
 */
export function createCacheService(
  db: Database,
  config?: CacheConfig,
): CacheService {
  return new CacheService(db, config)
}
