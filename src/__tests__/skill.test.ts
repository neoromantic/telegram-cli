/**
 * Skill command helper tests
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let skillModule: typeof import('../commands/skill')
let dataDir: string

const originalEnv = {
  apiId: process.env.TELEGRAM_API_ID,
  apiHash: process.env.TELEGRAM_API_HASH,
  dataDir: process.env.TELEGRAM_CLI_DATA_DIR,
}

beforeAll(async () => {
  dataDir = join(
    tmpdir(),
    `telegram-cli-skill-test-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2)}`,
  )

  process.env.TELEGRAM_CLI_DATA_DIR = dataDir
  process.env.TELEGRAM_API_ID = '12345'
  process.env.TELEGRAM_API_HASH = 'test-hash'

  mkdirSync(dataDir, { recursive: true })

  skillModule = await import('../commands/skill')
})

afterAll(() => {
  if (originalEnv.apiId === undefined) {
    delete process.env.TELEGRAM_API_ID
  } else {
    process.env.TELEGRAM_API_ID = originalEnv.apiId
  }

  if (originalEnv.apiHash === undefined) {
    delete process.env.TELEGRAM_API_HASH
  } else {
    process.env.TELEGRAM_API_HASH = originalEnv.apiHash
  }

  if (originalEnv.dataDir === undefined) {
    delete process.env.TELEGRAM_CLI_DATA_DIR
  } else {
    process.env.TELEGRAM_CLI_DATA_DIR = originalEnv.dataDir
  }

  rmSync(dataDir, { recursive: true, force: true })
})

describe('Skill Command Helpers', () => {
  it('builds a stable manifest', () => {
    const manifest = skillModule.buildSkillManifest()

    expect(manifest).toMatchObject({
      name: 'telegram-cli',
      description: 'Agent-friendly Telegram CLI',
      install_command: 'bun install -g telegram-cli',
      entrypoint: 'tg',
      version: '0.1.0',
      output: 'json',
    })
  })

  it('validates environment and data directory', async () => {
    const result = await skillModule.validateSkillEnvironment()

    expect(result.valid).toBe(true)
    expect(result.env.telegram_api_id.valid).toBe(true)
    expect(result.env.telegram_api_hash.valid).toBe(true)
    expect(result.data_dir.path).toBe(dataDir)
    expect(result.data_dir.writable).toBe(true)
    expect(result.issues).toHaveLength(0)
  })

  it('reports missing environment variables', async () => {
    const prevApiId = process.env.TELEGRAM_API_ID
    const prevApiHash = process.env.TELEGRAM_API_HASH

    try {
      delete process.env.TELEGRAM_API_ID
      delete process.env.TELEGRAM_API_HASH

      const result = await skillModule.validateSkillEnvironment()

      expect(result.valid).toBe(false)
      expect(result.env.telegram_api_id.valid).toBe(false)
      expect(result.env.telegram_api_hash.valid).toBe(false)
      expect(result.issues).toContain('TELEGRAM_API_ID is missing or invalid')
      expect(result.issues).toContain('TELEGRAM_API_HASH is missing or invalid')
    } finally {
      if (prevApiId === undefined) {
        delete process.env.TELEGRAM_API_ID
      } else {
        process.env.TELEGRAM_API_ID = prevApiId
      }

      if (prevApiHash === undefined) {
        delete process.env.TELEGRAM_API_HASH
      } else {
        process.env.TELEGRAM_API_HASH = prevApiHash
      }
    }
  })

  it('reports non-directory data dir paths', async () => {
    const filePath = join(dataDir, 'not-a-dir.txt')
    await Bun.write(filePath, 'test', { createPath: true })

    const status = await skillModule.checkDataDirAccess(filePath)

    expect(status.exists).toBe(true)
    expect(status.is_directory).toBe(false)
    expect(status.writable).toBe(false)
    expect(status.error).toBe('Path exists but is not a directory')

    await Bun.file(filePath)
      .delete()
      .catch(() => {})
  })

  it('installs the manifest and reports overwrites', async () => {
    const targetPath = join(dataDir, 'skill-test.json')

    try {
      const first = await skillModule.installSkillManifest(targetPath)

      expect(first.path).toBe(targetPath)
      expect(first.overwritten).toBe(false)
      expect(first.bytes).toBeGreaterThan(0)
      expect(first.manifest.name).toBe('telegram-cli')

      const second = await skillModule.installSkillManifest(targetPath)

      expect(second.overwritten).toBe(true)

      const manifestText = await Bun.file(targetPath).text()
      const manifest = JSON.parse(manifestText)

      expect(manifest.name).toBe('telegram-cli')
      expect(manifest.entrypoint).toBe('tg')
    } finally {
      await Bun.file(targetPath)
        .delete()
        .catch(() => {})
    }
  })
})
