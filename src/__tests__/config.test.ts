/**
 * Configuration system tests
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  ConfigError,
  getConfigPath,
  getConfigValue,
  getResolvedCacheConfig,
  loadConfig,
  parseConfigValue,
  setConfigValue,
  syncActiveAccountFromConfig,
} from '../config'
import { createTestDatabase } from '../db'
import { getDefaultCacheConfig, parseDuration } from '../db/types'

let dataDir: string

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'telegram-cli-config-test-'))
})

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true })
})

describe('config', () => {
  it('returns empty config when file is missing', async () => {
    const result = await loadConfig({ dataDir })

    expect(result.exists).toBe(false)
    expect(result.config).toEqual({})
    expect(result.errors).toEqual([])
  })

  it('sets and gets config values', async () => {
    await setConfigValue('cache.staleness.peers', '2d', { dataDir })
    await setConfigValue('cache.backgroundRefresh', false, { dataDir })

    const peers = await getConfigValue('cache.staleness.peers', {
      dataDir,
      strict: true,
    })
    const backgroundRefresh = await getConfigValue('cache.backgroundRefresh', {
      dataDir,
      strict: true,
    })

    expect(peers).toBe('2d')
    expect(backgroundRefresh).toBe(false)
  })

  it('parses config values with validation', () => {
    expect(parseConfigValue('activeAccount', '2')).toBe(2)
    expect(parseConfigValue('cache.backgroundRefresh', 'true')).toBe(true)
    expect(parseConfigValue('cache.staleness.peers', ' 7D ')).toBe('7d')

    expect(() => parseConfigValue('activeAccount', '0')).toThrow(ConfigError)
    expect(() => parseConfigValue('cache.staleness.peers', 'nope')).toThrow(
      ConfigError,
    )
  })

  it('loads resolved cache config overrides', async () => {
    await setConfigValue('cache.staleness.peers', '3d', { dataDir })
    await setConfigValue('cache.maxCacheAge', '14d', { dataDir })

    const resolved = await getResolvedCacheConfig({ dataDir })
    const defaults = getDefaultCacheConfig()

    expect(resolved.staleness.peers).toBe(parseDuration('3d'))
    expect(resolved.maxCacheAge).toBe(parseDuration('14d'))
    expect(resolved.staleness.dialogs).toBe(defaults.staleness.dialogs)
    expect(resolved.backgroundRefresh).toBe(defaults.backgroundRefresh)
  })

  it('throws on invalid values in strict mode', async () => {
    const path = getConfigPath(dataDir)
    await Bun.write(
      path,
      JSON.stringify(
        {
          cache: {
            staleness: {
              peers: 'oops',
            },
          },
        },
        null,
        2,
      ),
    )

    await expect(loadConfig({ dataDir, strict: true })).rejects.toThrow(
      'Config file has invalid values',
    )
  })

  it('syncs active account from config', async () => {
    const { db, accountsDb } = createTestDatabase()
    const account1 = accountsDb.create({ phone: '+1111111111' })
    const account2 = accountsDb.create({ phone: '+2222222222' })

    expect(accountsDb.getActive()).toBeNull()

    await setConfigValue('activeAccount', account2.id, { dataDir })
    await syncActiveAccountFromConfig(accountsDb, { dataDir })

    const active = accountsDb.getActive()
    expect(active?.id).toBe(account2.id)
    expect(active?.id).not.toBe(account1.id)

    db.close()
  })
})
