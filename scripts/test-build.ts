import { existsSync, unlinkSync } from 'node:fs'
import { $ } from 'bun'

const pkg = await Bun.file('package.json').json()
const OUTPUT = 'dist/tg-test'

// Clean up previous test build
if (existsSync(OUTPUT)) {
  unlinkSync(OUTPUT)
}

// Build current platform
console.log('Building for current platform...')
await $`bun build ./src/index.ts --compile --outfile ${OUTPUT}`

// Verify output exists
if (!existsSync(OUTPUT)) {
  throw new Error('Build output not found')
}

// Verify it runs
console.log('Verifying binary...')
const result = await $`./${OUTPUT} --version`.text()
if (!result.includes(pkg.version)) {
  throw new Error(
    `Version mismatch: expected ${pkg.version}, got ${result.trim()}`,
  )
}

// Verify help works
await $`./${OUTPUT} --help`.quiet()

console.log(`Build test passed! Version: ${pkg.version}`)

// Clean up test binary
unlinkSync(OUTPUT)
