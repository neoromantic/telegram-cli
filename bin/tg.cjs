#!/usr/bin/env node
/*
 * CLI shim for @goodit/telegram-sync-cli.
 * - Uses compiled binary if present (dist/tg)
 * - Otherwise falls back to running from source with Bun
 */
const { spawnSync } = require('node:child_process')
const { existsSync } = require('node:fs')
const { join } = require('node:path')

const packageRoot = join(__dirname, '..')
const binaryName = process.platform === 'win32' ? 'tg.exe' : 'tg'
const binaryPath = join(packageRoot, 'dist', binaryName)
const args = process.argv.slice(2)

function run(cmd, cmdArgs) {
  const result = spawnSync(cmd, cmdArgs, { stdio: 'inherit' })
  if (result.error) {
    if (result.error.code === 'ENOENT') {
      console.error(`Command not found: ${cmd}`)
    } else {
      console.error(result.error.message ?? result.error)
    }
    process.exit(1)
  }
  process.exit(result.status ?? 0)
}

if (existsSync(binaryPath)) {
  run(binaryPath, args)
}

const bunCmd = process.platform === 'win32' ? 'bun.exe' : 'bun'

// Attempt to build the binary on first run if missing.
const buildResult = spawnSync(
  bunCmd,
  ['run', join(packageRoot, 'scripts', 'postinstall.ts')],
  { stdio: 'inherit' },
)

if (!buildResult.error && buildResult.status === 0 && existsSync(binaryPath)) {
  run(binaryPath, args)
}

// Fall back to running from source (requires Bun).
run(bunCmd, ['run', join(packageRoot, 'src', 'index.ts'), ...args])
