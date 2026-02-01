/**
 * Test environment setup for E2E tests
 *
 * Creates isolated temporary directories with fresh databases
 * to ensure tests don't affect production data.
 */

import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const E2E_TEST_BASE = join(tmpdir(), 'telegram-cli-e2e-tests')

export interface TestEnvironment {
  /** Path to the isolated data directory */
  dataDir: string

  /** Initialize database with schema */
  initDatabase(): Database

  /** Seed accounts into the database */
  seedAccounts(
    accounts: Array<{
      phone: string
      name?: string
      is_active?: boolean
      session_data?: string
    }>,
  ): void

  /** Clean up the test environment */
  cleanup(): void

  /** Get CLI options with isolated data dir */
  getCliOptions(): { env: Record<string, string> }
}

/**
 * Initialize database schema (matches src/db/index.ts)
 */
function initSchema(db: Database): void {
  db.run('PRAGMA journal_mode = WAL')

  db.run(`
    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT UNIQUE NOT NULL,
      name TEXT,
      session_data TEXT NOT NULL DEFAULT '',
      is_active INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `)

  db.run('CREATE INDEX IF NOT EXISTS idx_accounts_phone ON accounts(phone)')
  db.run(
    'CREATE INDEX IF NOT EXISTS idx_accounts_active ON accounts(is_active)',
  )
}

/**
 * Create an isolated test environment
 *
 * @param testName - Unique name for this test (used in directory path)
 */
export function createTestEnvironment(testName: string): TestEnvironment {
  // Create unique directory for this test
  const timestamp = Date.now()
  const randomSuffix = Math.random().toString(36).substring(2, 8)
  const dataDir = join(
    E2E_TEST_BASE,
    `${testName}-${timestamp}-${randomSuffix}`,
  )

  // Ensure directory exists
  mkdirSync(dataDir, { recursive: true })

  let db: Database | null = null

  return {
    dataDir,

    initDatabase(): Database {
      const dbPath = join(dataDir, 'data.db')
      db = new Database(dbPath)
      initSchema(db)
      return db
    },

    seedAccounts(accounts): void {
      if (!db) {
        this.initDatabase()
      }

      const stmt = db!.prepare(`
        INSERT INTO accounts (phone, name, session_data, is_active)
        VALUES ($phone, $name, $session_data, $is_active)
      `)

      for (const account of accounts) {
        stmt.run({
          $phone: account.phone,
          $name: account.name ?? null,
          $session_data: account.session_data ?? '',
          $is_active: account.is_active ? 1 : 0,
        })
      }
    },

    cleanup(): void {
      // Close database if open
      if (db) {
        db.close()
        db = null
      }

      // Remove the test directory
      if (existsSync(dataDir)) {
        rmSync(dataDir, { recursive: true, force: true })
      }
    },

    getCliOptions(): { env: Record<string, string> } {
      return {
        env: {
          TELEGRAM_CLI_DATA_DIR: dataDir,
        },
      }
    },
  }
}

/**
 * Clean up all E2E test directories
 * Useful for manual cleanup if tests fail
 */
export function cleanupAllTestEnvironments(): void {
  if (existsSync(E2E_TEST_BASE)) {
    rmSync(E2E_TEST_BASE, { recursive: true, force: true })
  }
}
