import { $ } from 'bun'

const pkg = await Bun.file('package.json').json()

async function testInstall() {
  console.log('Testing bun link installation...\n')

  // Link package
  await $`bun link`.quiet()

  // Verify command exists and runs
  const helpResult = await $`tg --help`.quiet()
  if (!helpResult.stdout.toString().includes('tg')) {
    throw new Error('tg command not working after link')
  }
  console.log('  ✓ tg --help')

  // Verify version
  const version = await $`tg --version`.text()
  if (!version.includes(pkg.version)) {
    throw new Error(
      `Version mismatch: expected ${pkg.version}, got ${version.trim()}`,
    )
  }
  console.log(`  ✓ tg --version (${version.trim()})`)

  // Test subcommands
  const commands = ['auth', 'accounts', 'contacts', 'api']
  for (const cmd of commands) {
    await $`tg ${cmd} --help`.quiet()
    console.log(`  ✓ tg ${cmd} --help`)
  }

  console.log('\nInstallation test passed!')
}

await testInstall()
