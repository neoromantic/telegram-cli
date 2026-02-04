#!/usr/bin/env bun
import { chmodSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { $ } from 'bun'

// Get the package root (where this script lives)
const scriptDir = dirname(Bun.main)
const packageRoot = join(scriptDir, '..')

// Ensure dist directory exists
const distDir = join(packageRoot, 'dist')
if (!existsSync(distDir)) {
  mkdirSync(distDir, { recursive: true })
}

const outfile = join(distDir, 'tg')
const entrypoint = join(packageRoot, 'src', 'index.ts')

console.log('Building telegram-sync-cli binary...')

try {
  await $`bun build ${entrypoint} --compile --minify --outfile ${outfile}`.quiet()

  // Ensure executable permissions on Unix
  if (process.platform !== 'win32') {
    chmodSync(outfile, 0o755)
  }

  console.log('✓ telegram-sync-cli installed successfully')
} catch (err) {
  console.error('Failed to build telegram-sync-cli:', err)
  process.exit(1)
}
