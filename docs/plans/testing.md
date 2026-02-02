# Testing Strategy - Planned Features

> **Note**: For implemented testing features (unit tests, E2E tests), see [docs/testing.md](../testing.md).

This document covers **planned** testing features not yet implemented.
Snapshot testing is now implemented; see [docs/testing.md](../testing.md) for usage.

## Integration Tests (Planned)

Integration tests will run against a real Telegram account for end-to-end validation.

### Environment Variable

Set `TELEGRAM_TEST_ACCOUNT` to enable integration tests:

```bash
# .env or environment
TELEGRAM_TEST_ACCOUNT=+1234567890
TELEGRAM_API_ID=your_api_id
TELEGRAM_API_HASH=your_api_hash
```

### Running Integration Tests

```bash
# Run integration tests
bun test:integration
```

### Integration Test Scope

When `TELEGRAM_TEST_ACCOUNT` is set, the following tests would run:

| Test Suite | Description |
|------------|-------------|
| Auth | Verify login/logout with real credentials |
| Contacts | Fetch and verify real contact list |
| Chats | List real dialogs and chat info |
| Messages | Send test message to self/saved messages |
| Status | Verify connection and auth status |

### Guidelines

1. **Run sparingly**: Integration tests hit real APIs and may trigger rate limits
2. **Use test account**: Never use a production account
3. **Don't commit credentials**: Keep API keys and phone numbers in `.env`
4. **Clean up**: Tests should clean up any created resources
5. **Idempotent**: Tests should be safe to run multiple times

### Integration Test Template

```typescript
import { describe, expect, it } from 'bun:test'

const TEST_ACCOUNT = process.env.TELEGRAM_TEST_ACCOUNT

describe.skipIf(!TEST_ACCOUNT)('Integration: Feature', () => {
  it('should work with real API', async () => {
    const result = await realApiCall()
    expect(result).toBeDefined()
  })
})
```

## Snapshot Testing (Implemented)

Snapshot tests now cover CLI/output formatting using Bun's snapshot assertions.
See [docs/testing.md](../testing.md) for helpers and update workflow.

## Mock HTTP Layer (Planned)

Replay recorded API responses for deterministic testing without network access.

## CI/CD - Integration Tests

Integration tests are **not** run in CI to avoid:
- Exposing credentials
- Rate limiting
- Flaky tests from network issues

They should be run manually before releases.
