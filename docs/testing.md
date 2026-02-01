# Testing Guide

This document covers the implemented testing infrastructure for telegram-cli.

## Overview

| Type | Location | Count | Purpose |
|------|----------|-------|---------|
| Unit Tests | `src/__tests__/*.test.ts` | 139 | Fast, isolated component tests |
| E2E Tests | `src/__e2e__/*.e2e.test.ts` | 34 | CLI binary execution tests |
| **Total** | | **173** | ~87% line coverage |

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

**In-Memory Database**: Each test gets isolated SQLite instance.

```typescript
import { createTestDatabase } from '../db'

const { accountsDb, db } = createTestDatabase()
// Fresh database for each test
```

**Dependency Injection**: Services use interfaces for testability.

```typescript
const deps: AuthDependencies = {
  accountsDb: createTestDatabase().accountsDb,
  createClient: mock(() => mockClient),
}
```

### Test Files

| File | Coverage |
|------|----------|
| `auth.test.ts` | Authentication flows (phone, QR, logout) |
| `db.test.ts` | Database operations (CRUD, queries) |
| `output.test.ts` | Output formatting (JSON, pretty, quiet) |
| `telegram.test.ts` | Telegram service layer |
| `types.test.ts` | Type definitions and validation |

## E2E Tests

E2E tests execute the CLI binary via `Bun.spawn` to verify actual command behavior.

### Test Isolation

Tests use `TELEGRAM_CLI_DATA_DIR` environment variable to create isolated environments:

- Unique temp directory per test in `/tmp/telegram-cli-e2e-tests/`
- Fresh SQLite database
- No interference with production data (`~/.telegram-cli/`)
- Automatic cleanup after each test

### Test Files

| File | Tests |
|------|-------|
| `help.e2e.test.ts` | `--help`, `--version`, subcommand help, invalid commands |
| `exit-codes.e2e.test.ts` | Exit codes 0-6 for various error scenarios |
| `format.e2e.test.ts` | `--format json/pretty/quiet` output behavior |
| `accounts.e2e.test.ts` | `list`, `switch`, `remove`, `info` commands |

### E2E Helpers

**CLI Execution** (`src/__e2e__/helpers/cli.ts`):

```typescript
// Run CLI and capture output
const result = await runCli(['accounts', 'list'])
// result.stdout, result.stderr, result.exitCode, result.json

// Expect success (exit code 0)
await runCliSuccess(['accounts', 'list'], options)

// Expect failure with specific exit code
await runCliFailure(['accounts', 'switch', '--id', '999'], 6, options)
```

**Test Environment** (`src/__e2e__/helpers/setup.ts`):

```typescript
const env = createTestEnvironment('my-test')
env.initDatabase()
env.seedAccounts([{ phone: '+1234567890', is_active: true }])

// Run CLI with isolated data directory
await runCli(['accounts', 'list'], env.getCliOptions())

// Clean up temp directory
env.cleanup()
```

### Writing E2E Tests

```typescript
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { runCliSuccess, runCliFailure } from './helpers/cli'
import { createTestEnvironment, type TestEnvironment } from './helpers/setup'

describe('E2E: My Feature', () => {
  let env: TestEnvironment

  beforeEach(() => {
    env = createTestEnvironment('my-feature')
    env.initDatabase()
    env.seedAccounts([{ phone: '+1111111111', is_active: true }])
  })

  afterEach(() => {
    env.cleanup()
  })

  it('should succeed with valid input', async () => {
    const result = await runCliSuccess(['my-command'], env.getCliOptions())
    expect(result.json?.success).toBe(true)
  })

  it('should fail with invalid input', async () => {
    const result = await runCliFailure(['my-command', '--bad'], 3, env.getCliOptions())
    expect(result.json?.error?.code).toBe('INVALID_ARGS')
  })
})
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

### Mock Not Called

Set up mocks before calling the function under test:

```typescript
deps.service = mock(() => result)  // Set mock FIRST
await functionUnderTest(deps)       // Then call
expect(deps.service).toHaveBeenCalled()
```
