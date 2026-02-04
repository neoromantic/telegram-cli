# Build & Distribution

> **Status:** Implemented

## Overview

telegram-sync-cli ships as source (Bun-run TypeScript). The npm package does
not include `dist/tg`; the binary is built locally via `postinstall`.

## Build Commands

```bash
# Build native binary for current platform
bun run build

# Minified build with sourcemaps
bun run build:minify

# Cross-compile for all supported platforms
bun run build:all
```

Output:
- Current platform binary: `dist/tg` (built locally)
- Cross-build outputs: `dist/tg-<platform>` from `scripts/build-all.ts`

## Install / Test Commands

```bash
# Test that the compiled binary runs
bun run test:build

# Test global installation via bun link
bun run test:install
```

## Global Installation (Local)

```bash
# From local source
bun link

# From npm/bun registry
# (builds `dist/tg` locally during postinstall)
bun install -g @goodit/telegram-sync-cli
```

## Supported Platforms

- `bun-darwin-arm64`
- `bun-darwin-x64`
- `bun-linux-x64`
- `bun-linux-arm64`
- `bun-windows-x64`

## Notes

- The compiled binary includes the Bun runtime and SQLite; size is ~60MB.
- The npm tarball excludes the binary; it is built locally on install.
- `TELEGRAM_API_ID` and `TELEGRAM_API_HASH` must be provided at runtime.
