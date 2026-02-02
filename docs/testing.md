# Testing Guide

This document covers the implemented testing infrastructure for telegram-cli.

## Overview

| Type | Location | Purpose |
|------|----------|---------|
| Unit Tests | `src/__tests__/*.test.ts` | Fast, isolated component tests |
| E2E Tests | `src/__e2e__/*.e2e.test.ts` | CLI execution + exit code behavior |

> For current test counts and coverage, see `progress.md`.

## Running Tests

```bash
# Unit tests only
bun run test

# E2E tests only
bun run test:e2e

# All tests (unit + E2E)
bun run test:all

# With coverage report
bun run test:coverage

# Watch mode
bun test --watch

# Specific test file
bun test src/__tests__/auth.test.ts
```

## Unit Tests

Unit tests run without network access using mocked dependencies.

### Test Patterns

**In-memory database**: Each test gets an isolated SQLite instance.

```typescript
import { createTestDatabase } from '../db'

const { accountsDb, db } = createTestDatabase()
```

**Dependency injection**: Services use interfaces for testability.

```typescript
const deps: AuthDependencies = {
  accountsDb: createTestDatabase().accountsDb,
  createClient: mock(() => mockClient),
}
```

### Core Unit Test Files

- `auth.test.ts` — authentication flows (phone, QR, logout)
- `db.test.ts` — database operations
- `output.test.ts` — JSON/pretty/quiet output formatting
- `telegram.test.ts` — Telegram service layer
- `sync-jobs.test.ts` — sync job lifecycle
- `update-handlers.test.ts` — daemon update handlers

### Snapshot Tests

Snapshot tests lock down formatted output to catch regressions.

- Helpers live in `src/__tests__/helpers/snapshots.ts`
- Snapshots use Bun's `toMatchSnapshot` / `toMatchInlineSnapshot`
- Update snapshots with `bun test -u`

```typescript
import { snapshotLines } from './helpers/snapshots'

setOutputFormat('json')
success({ message: 'Snapshot test', count: 2 })
expect(snapshotLines(logs)).toMatchInlineSnapshot(`
"{
  "success": true,
  "data": {
    "message": "Snapshot test",
    "count": 2
  }
}"
`)
```

## E2E Tests

E2E tests execute the CLI binary via `Bun.spawn` to verify actual command behavior.

### Test Isolation

Tests use `TELEGRAM_CLI_DATA_DIR` to create isolated environments:

- Unique temp directory per test
- Fresh SQLite database
- No interference with production data (`~/.telegram-cli/`)
- Automatic cleanup after each test

### E2E Files

- `help.e2e.test.ts` — `--help`, subcommand help, invalid commands
- `exit-codes.e2e.test.ts` — exit codes for common failure modes
- `format.e2e.test.ts` — `--format` json/pretty/quiet behavior
- `accounts.e2e.test.ts` — `list`, `switch`, `remove`, `info`
- `user.e2e.test.ts` — `me`, `user` lookups
- `commands.e2e.test.ts` — command coverage smoke tests
- `daemon.e2e.test.ts` — daemon start/stop/status

### E2E Helpers

**CLI execution** (`src/__e2e__/helpers/cli.ts`):

```typescript
// Run CLI and capture output
const result = await runCli(['accounts', 'list'])
// result.stdout, result.stderr, result.exitCode, result.json
```

**Test environment** (`src/__e2e__/helpers/setup.ts`):

```typescript
const env = createTestEnvironment('my-test')
env.initDatabase()
env.seedAccounts([{ phone: '+1234567890', is_active: true }])

await runCli(['accounts', 'list'], env.getCliOptions())

env.cleanup()
```

## CI/CD

GitHub Actions runs tests on every push and PR:

```yaml
# .github/workflows/ci.yml
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: oven-sh/setup-bun@v2
      - run: bun install
      - run: bun test  # Runs unit + E2E
```

## Troubleshooting

### Tests Hanging

Ensure all Telegram clients are closed:

```typescript
// In tests, mock the close method
close: mock(() => Promise.resolve())
```

### Database Locked

Each test should create its own database:

```typescript
beforeEach(() => {
  const { accountsDb } = createTestDatabase()
})
```
