# Build & Distribution Strategy

## Overview

This plan outlines how to build, package, and distribute the `tg` CLI as both a Bun-native package and compiled standalone binaries.

## Current State

The project is **mostly configured**:

| Aspect | Status | Notes |
|--------|--------|-------|
| `bin` field | ✅ Done | Points to `./src/index.ts` |
| Shebang | ✅ Done | `#!/usr/bin/env bun` in index.ts |
| `bun link` | ✅ Works | For local development |
| Compiled binary | ✅ Done | `bun run build` outputs `dist/tg` |
| Cross-platform builds | ✅ Done | `bun run build:all` |
| Release automation | ❌ Missing | No GitHub Actions for releases |
| Installation tests | ✅ Done | `bun run test:build` / `bun run test:install` |

## Distribution Options Analysis

### Option 1: Bun-Native Package (npm/bun registry)

**How it works**: Users install via `bun install -g telegram-cli` and Bun runs the TypeScript directly.

**Pros**:
- Simple setup (already mostly working)
- Small package size (~50KB source)
- Works with `bun link` for development
- Users get source code (debuggable)

**Cons**:
- Requires Bun runtime
- TypeScript transpilation on every run (negligible with Bun)
- Not suitable for non-Bun users

**Best for**: Bun users, developers, quick iteration

### Option 2: Compiled Standalone Binaries

**How it works**: `bun build --compile` creates self-contained executables with embedded Bun runtime.

**Pros**:
- No runtime dependency
- Single file distribution
- Faster cold start (no transpilation)
- Can distribute via GitHub Releases, Homebrew, etc.

**Cons**:
- Large file size (~50-100MB per platform)
- Cross-compilation needed for each target
- Build complexity
- Updates require re-downloading entire binary

**Best for**: End users, production deployments, non-Bun environments

### Option 3: Hybrid Approach (Recommended)

Provide **both** options:
1. npm package with `bin` pointing to TypeScript (for Bun users)
2. Compiled binaries via GitHub Releases (for everyone else)

This matches how modern CLIs like `bun` itself, `esbuild`, and `biome` distribute.

## Important Considerations

### Runtime Requirements

The compiled binary still requires these **environment variables at runtime**:
- `TELEGRAM_API_ID` - Telegram API ID (from https://my.telegram.org)
- `TELEGRAM_API_HASH` - Telegram API hash

These are NOT embedded in the binary (security risk). Users must provide them via `.env` file or environment.

### Native Modules

The project uses `bun:sqlite` which is a native Bun API. This is fully supported in compiled binaries - the SQLite implementation is bundled into the Bun runtime that gets embedded.

### Code Signing (Future)

For production distribution:
- **macOS**: Unsigned binaries trigger Gatekeeper warnings. Users must right-click → Open, or run `xattr -d com.apple.quarantine ./tg`
- **Windows**: Unsigned `.exe` may trigger SmartScreen warnings
- Code signing requires Apple Developer / Microsoft certificates (~$99-299/year)

For initial release, we'll document the workarounds. Code signing can be added later.

## Recommended Implementation

### Phase 1: Local Build Scripts (Done)

Scripts are already in `package.json`:

```json
{
  "scripts": {
    "build": "bun build ./src/index.ts --compile --outfile dist/tg",
    "build:minify": "bun build ./src/index.ts --compile --minify --sourcemap --outfile dist/tg",
    "build:all": "bun run scripts/build-all.ts",
    "link": "bun link",
    "test:install": "bun run scripts/test-install.ts",
    "test:build": "bun run scripts/test-build.ts"
  }
}
```

### Phase 2: Cross-Platform Build Script (Done)

Implemented in `scripts/build-all.ts`:

```typescript
import { $ } from 'bun'
import { mkdirSync, existsSync } from 'node:fs'
import pkg from '../package.json'

const targets = [
  { target: 'bun-darwin-arm64', output: 'tg-darwin-arm64' },
  { target: 'bun-darwin-x64', output: 'tg-darwin-x64' },
  { target: 'bun-linux-x64', output: 'tg-linux-x64' },
  { target: 'bun-linux-arm64', output: 'tg-linux-arm64' },
  { target: 'bun-windows-x64', output: 'tg-windows-x64.exe' },
] as const

// Ensure dist directory exists
if (!existsSync('dist')) {
  mkdirSync('dist')
}

console.log(`Building telegram-cli v${pkg.version} for all platforms...\n`)

const results: { target: string; success: boolean; error?: string }[] = []

for (const { target, output } of targets) {
  process.stdout.write(`  ${target}... `)
  try {
    await $`bun build ./src/index.ts --compile --minify --target=${target} --outfile dist/${output}`.quiet()
    console.log('✓')
    results.push({ target, success: true })
  } catch (err) {
    console.log('✗')
    results.push({ target, success: false, error: String(err) })
  }
}

// Summary
const succeeded = results.filter(r => r.success).length
const failed = results.filter(r => !r.success).length

console.log(`\nBuild complete: ${succeeded} succeeded, ${failed} failed`)

if (failed > 0) {
  console.log('\nFailed builds:')
  for (const r of results.filter(r => !r.success)) {
    console.log(`  - ${r.target}: ${r.error}`)
  }
  process.exit(1)
}
```

### Phase 3: Installation Test Script

Create `scripts/test-install.ts`:

```typescript
import { $ } from 'bun'

async function testInstall() {
  console.log('Testing bun link installation...')

  // Link package
  await $`bun link`

  // Verify command exists
  const result = await $`tg --help`.quiet()
  if (!result.stdout.includes('tg')) {
    throw new Error('tg command not working after link')
  }

  // Verify version
  const version = await $`tg --version`.text()
  console.log(`Installed version: ${version.trim()}`)

  // Test a simple command (--help for each subcommand)
  const commands = ['auth', 'accounts', 'contacts', 'api']
  for (const cmd of commands) {
    await $`tg ${cmd} --help`.quiet()
    console.log(`  ✓ tg ${cmd} --help`)
  }

  console.log('Installation test passed!')
}

await testInstall()
```

### Phase 4: GitHub Actions Release Workflow

Create `.github/workflows/release.yml`:

```yaml
name: Release

on:
  push:
    tags:
      - 'v*'

jobs:
  # Run CI checks first - don't release broken code
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest
      - run: bun install --frozen-lockfile
      - run: bun run lint
      - run: bun run typecheck
      - run: bun test

  build:
    needs: validate
    strategy:
      fail-fast: false  # Don't cancel other builds if one fails
      matrix:
        include:
          # Cross-compilation from ubuntu works for all Linux targets
          - os: ubuntu-latest
            target: bun-linux-x64
            artifact: tg-linux-x64
          - os: ubuntu-latest
            target: bun-linux-arm64
            artifact: tg-linux-arm64
          # macOS builds from macOS runner (cross-compile both archs)
          - os: macos-latest
            target: bun-darwin-x64
            artifact: tg-darwin-x64
          - os: macos-latest
            target: bun-darwin-arm64
            artifact: tg-darwin-arm64
          # Windows from Windows runner
          - os: windows-latest
            target: bun-windows-x64
            artifact: tg-windows-x64.exe

    runs-on: ${{ matrix.os }}

    steps:
      - uses: actions/checkout@v4

      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest

      - name: Install dependencies
        run: bun install --frozen-lockfile

      - name: Build binary
        run: bun build ./src/index.ts --compile --minify --target=${{ matrix.target }} --outfile ${{ matrix.artifact }}

      - name: Verify binary runs (Unix)
        if: runner.os != 'Windows'
        run: |
          chmod +x ${{ matrix.artifact }}
          ./${{ matrix.artifact }} --version

      - name: Verify binary runs (Windows)
        if: runner.os == 'Windows'
        run: ./${{ matrix.artifact }} --version

      - name: Upload artifact
        uses: actions/upload-artifact@v4
        with:
          name: ${{ matrix.artifact }}
          path: ${{ matrix.artifact }}
          retention-days: 1

  release:
    needs: build
    runs-on: ubuntu-latest
    permissions:
      contents: write

    steps:
      - uses: actions/checkout@v4

      - name: Download all artifacts
        uses: actions/download-artifact@v4
        with:
          path: dist
          merge-multiple: true

      - name: Create checksums
        run: |
          cd dist
          sha256sum * > checksums.txt
          cat checksums.txt

      - name: Create GitHub Release
        uses: softprops/action-gh-release@v2
        with:
          files: |
            dist/*
          generate_release_notes: true
          draft: false
          prerelease: ${{ contains(github.ref, '-alpha') || contains(github.ref, '-beta') || contains(github.ref, '-rc') }}
```

### Phase 5: npm Publishing (Optional)

For npm registry distribution, ensure `package.json` is ready:

```json
{
  "name": "@your-scope/telegram-cli",
  "version": "0.1.0",
  "bin": {
    "tg": "./src/index.ts"
  },
  "files": [
    "src/**/*.ts",
    "!src/__tests__/**"
  ],
  "publishConfig": {
    "access": "public"
  }
}
```

**Note**: The `files` field is an allowlist. Only listed patterns are included. `scripts/`, `docs/`, `.github/` are automatically excluded since they're not in the list.

Publish with: `bun publish`

## Build Targets Reference

Bun supports these compilation targets:

| Target | OS | Architecture | Notes |
|--------|----|--------------| ------|
| `bun-darwin-arm64` | macOS | Apple Silicon | Primary Mac target |
| `bun-darwin-x64` | macOS | Intel | Legacy Mac support |
| `bun-linux-x64` | Linux | x86_64 | Most common |
| `bun-linux-x64-baseline` | Linux | x86_64 | Pre-2013 CPUs |
| `bun-linux-x64-modern` | Linux | x86_64 | 2013+ CPUs (faster) |
| `bun-linux-arm64` | Linux | ARM64 | Raspberry Pi, AWS Graviton |
| `bun-linux-x64-musl` | Linux | x86_64 | Alpine Linux |
| `bun-linux-arm64-musl` | Linux | ARM64 | Alpine ARM |
| `bun-windows-x64` | Windows | x86_64 | Most common |
| `bun-windows-x64-baseline` | Windows | x86_64 | Pre-2013 CPUs |

**Recommended subset** for initial release:
- `bun-darwin-arm64` (modern Macs)
- `bun-darwin-x64` (older Macs)
- `bun-linux-x64` (most Linux)
- `bun-linux-arm64` (ARM servers/devices)
- `bun-windows-x64` (Windows)

## File Structure After Implementation

```
telegram-cli/
├── dist/                          # Build output (gitignored)
│   ├── tg-darwin-arm64
│   ├── tg-darwin-x64
│   ├── tg-linux-x64
│   ├── tg-linux-arm64
│   └── tg-windows-x64.exe
├── scripts/
│   ├── build-all.ts               # Cross-platform build script
│   ├── test-build.ts              # Verify build output works
│   └── test-install.ts            # Installation verification
├── .github/workflows/
│   ├── ci.yml                     # Existing CI (lint, test, typecheck)
│   └── release.yml                # New release workflow
├── .gitignore                     # Add dist/ entry
└── package.json                   # Updated with build scripts
```

## Testing Strategy

### Unit Test: Build Output

```typescript
// scripts/test-build.ts
import { $ } from 'bun'
import { existsSync, unlinkSync } from 'node:fs'
import pkg from '../package.json'

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
  throw new Error(`Version mismatch: expected ${pkg.version}, got ${result.trim()}`)
}

// Verify help works
await $`./${OUTPUT} --help`.quiet()

console.log(`Build test passed! Version: ${pkg.version}`)
```

### CI Integration

Add to existing CI workflow:

```yaml
# .github/workflows/ci.yml
jobs:
  # ... existing jobs ...

  build-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install --frozen-lockfile
      - run: bun build ./src/index.ts --compile --outfile dist/tg
      - run: ./dist/tg --version
      - run: ./dist/tg --help
```

## Implementation Checklist

- [ ] Add `dist/` to `.gitignore`
- [ ] Create `scripts/` directory
- [ ] Create `scripts/build-all.ts`
- [ ] Create `scripts/test-build.ts`
- [ ] Create `scripts/test-install.ts`
- [ ] Update `package.json` with build scripts
- [ ] Add build-test job to CI workflow
- [ ] Create `.github/workflows/release.yml`
- [ ] Test local build on current platform (`bun run build`)
- [ ] Test `bun link` workflow
- [ ] Tag first release (`v0.1.0`)
- [ ] Verify GitHub Release artifacts download and run

## Version Management

For releases, use semver tags:

```bash
# Bump version in package.json
bun version patch  # 0.1.0 -> 0.1.1
bun version minor  # 0.1.1 -> 0.2.0
bun version major  # 0.2.0 -> 1.0.0

# Create and push tag
git tag v$(jq -r .version package.json)
git push --tags
```

## Future Enhancements

1. **Homebrew formula** - For `brew install telegram-cli`
2. **AUR package** - For Arch Linux users
3. **Scoop manifest** - For Windows users
4. **Install script** - `curl -fsSL https://... | bash`
5. **Auto-update** - Check for new versions on startup
6. **Platform-specific npm packages** - Like esbuild/biome for npm users without Bun

## References

- [Bun Single-file Executables](https://bun.com/docs/bundler/executables)
- [Bun Cross-compilation](https://developer.mamezou-tech.com/en/blogs/2024/05/20/bun-cross-compile/)
- [Publishing Binaries on npm](https://sentry.engineering/blog/publishing-binaries-on-npm)
- [GitHub Actions Multi-platform Releases](https://itsfuad.medium.com/automating-multi-platform-releases-with-github-actions-f74de82c76e2)
