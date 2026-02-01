# Telegram CLI Roadmap

## Vision

A complete Telegram CLI client for developers and AI agents. Installable via `bun`, `npm`, `pnpm`, and eventually `homebrew`.

## Architecture

**Same binary, two modes:**
- `tg <command>` — CLI mode: execute and exit
- `tg daemon start` — Daemon mode: long-running background sync

→ [Full Architecture](docs/plans/architecture.md)

## v0.1.0 — Foundation

**Goal:** Working CLI with daemon architecture, contact sync, basic messaging.

### Phase 1: Code Quality
- [x] Set up Biome for linting
- [x] Set up pre-commit hooks (lint, typecheck, test)
- [x] Refactor current implementation
- [ ] Improve `--help` outputs
- [ ] Add `--verbose` / `--quiet` flags

### Phase 2: Daemon
- [x] Implement `tg daemon start/stop/status`
- [x] PID file management
- [ ] Multi-account connections (max 5)
- [x] Real-time update handling

→ [Daemon Plan](docs/plans/daemon.md)

### Phase 3: Sync & Caching ✅
- [x] Dual cursor sync (forward + backward)
- [x] Contact list caching (UsersCache)
- [x] Chat/dialog caching (ChatsCache)
- [x] Message sync with priorities
- [x] Stale-while-revalidate caching (implemented)
- [x] `--fresh` flag for cache bypass (implemented)
- [x] Lazy cache database initialization (getCacheDb())

→ [Sync Strategy](docs/plans/sync-strategy.md) | [Caching](docs/caching.md)

### Phase 4: Database ✅
- [x] Implement cache schema (users_cache, chats_cache, sync_state, rate_limits, api_activity)
- [x] Rate limit tracking (RateLimitsService with flood wait handling)
- [x] API activity logging
- [x] Generic cache service with staleness checking
- [x] Users cache service (UsersCache)
- [x] Chats cache service (ChatsCache)
- [x] Comprehensive tests (942 unit tests total)

→ [Database Schema](docs/plans/database-schema.md)

### Phase 5: Core Commands ✅
- [x] `tg contacts list/get/search` (with UsersCache)
- [x] `tg send @user "message"` (with cache-based peer resolution)
- [x] `tg chats list/get/search` (with ChatsCache)
- [x] `tg me` / `tg user @username`
- [ ] `tg status`

→ [CLI Commands](docs/plans/cli-commands.md)

### Phase 6: Multi-Account
- [x] Account add/remove/switch
- [x] Account identification (ID, @username, label)
- [ ] Per-account storage

→ [Multi-Account](docs/plans/multi-account.md)

### Phase 7: AI Integration
- [ ] `tg skill` command
- [ ] Claude Code skill file
- [ ] Self-installation command

→ [AI Integration](docs/plans/ai-integration.md)

### Phase 8: Testing & Docs
- [x] Unit testing setup (942 unit tests)
- [x] GitHub Actions CI (lint, typecheck, test, build-test)
- [x] E2E testing setup (80 E2E tests)
  - [x] CLI execution helper (`Bun.spawn`)
  - [x] Test isolation via `TELEGRAM_CLI_DATA_DIR`
  - [x] Help/format/accounts/exit-code tests
- [x] Build & distribution scripts
- **Total: 1022 tests (942 unit + 80 E2E), ~85% line coverage**
- [ ] Snapshot testing setup
- [ ] Mock HTTP layer
- [ ] Integration test suite with TELEGRAM_TEST_ACCOUNT env var
- [ ] Comprehensive README

→ [Testing Guide](docs/testing.md) | [Testing Plans](docs/plans/testing.md)

---

## 🔧 Known Issues & Technical Debt

> **Code Review Date:** 2026-02-02
>
> Comprehensive review of the sync engine, update handlers, daemon, and caching layers.
> Issues are prioritized P0 (critical) through P3 (enhancement).

### ✅ Recently Fixed (2026-02-02)

The following 16 issues have been resolved:

| Issue | Description | Fix |
|-------|-------------|-----|
| #1 | Delete events ignored for DMs/groups | Look up chat from message ID before marking deleted |
| #2 | Race condition in job acquisition | Atomic job claiming with single UPDATE...RETURNING |
| #3 | Running jobs never recovered after crash | Reset running jobs to pending on daemon startup |
| #4 | No error handling in update handlers | Added try-catch with proper error logging |
| #5 | raw_json never stored | Pass and serialize raw message object |
| #6 | Backward cursor = 0 infinite loop | Skip backward sync when no valid cursor exists |
| #7 | edit_date never stored | Added edit_date parameter to updateText() |
| #9 | Failed jobs never cleaned up | Added cleanupFailed() method |
| #10 | INSERT OR REPLACE loses created_at | Use ON CONFLICT DO UPDATE to preserve timestamp |
| #11 | No reconnection after health check failure | Exponential backoff reconnection |
| #17 | No shutdown timeout | 30-second timeout with force exit |
| #19 | interBatchDelayMs config never used | Implemented delay between pagination calls |
| #20 | High priority chats miss initial load | Include high priority in initial load |
| #25 | Forward from peerChat not handled | Added peerChat handling in message parser |
| #27 | Cannot reset cursors to NULL | Added resetSyncState() method |
| docs | CLAUDE.md missing files | Updated file structure section |

### P0: Critical Issues (Fix Before Production)

#### 1. ✅ FIXED - Delete Events Ignored for DMs and Groups
**Location:** `src/daemon/daemon.ts:215-225`

**Problem:** The `DeleteMessageUpdate` from mtcute only provides `channelId` which is `null` for non-channel chats. The current implementation skips ALL delete events where `channelId` is null.

```typescript
const chatId = update.channelId
if (chatId === null) {
  // Skip private/group chat deletions for now
  return
}
```

**Impact:** Deleted messages in private chats and basic groups are NEVER marked as deleted in the cache. Users see stale/deleted messages indefinitely.

**Fix:** Either:
1. Track message ownership by chat type and handle deletions differently
2. Implement periodic reconciliation to detect deleted messages
3. Use a different mtcute event that provides chat context

---

#### 2. ✅ FIXED - Race Condition in Job Acquisition
**Location:** `src/db/sync-jobs.ts` + `src/daemon/scheduler.ts`

**Problem:** The job claiming sequence is not atomic:
```typescript
const job = scheduler.getNextJob()  // SELECT
if (job) {
  scheduler.startJob(job.id)        // UPDATE
}
```

Two concurrent workers can both retrieve the same job before either marks it as running.

**Impact:** Duplicate job execution, wasted API calls, potential data corruption from concurrent syncs.

**Fix:** Implement atomic job claiming:
```sql
UPDATE sync_jobs
SET status = 'running', started_at = $now
WHERE id = (
  SELECT id FROM sync_jobs
  WHERE status = 'pending'
  ORDER BY priority ASC, created_at ASC
  LIMIT 1
) AND status = 'pending'
RETURNING *
```

---

#### 3. ✅ FIXED - Running Jobs Never Recovered After Crash
**Location:** `src/daemon/scheduler.ts`

**Problem:** If the daemon crashes while a job has `status = 'running'`:
- Job stays in `running` state forever
- `getNextPending()` only returns `pending` jobs
- No mechanism to detect or reset stale running jobs

**Impact:** Jobs can be permanently stuck, causing chats to never sync.

**Fix:** On daemon startup, reset all `running` jobs back to `pending`:
```sql
UPDATE sync_jobs
SET status = 'pending', error = 'Daemon crashed during execution'
WHERE status = 'running'
```

---

#### 4. ✅ FIXED - No Error Handling in Update Handlers
**Location:** `src/daemon/handlers.ts`

**Problem:** All handler methods have zero try-catch blocks:
```typescript
async handleNewMessage(ctx, data): Promise<void> {
  ensureSyncState(data.chatId)
  const input = toMessageInput(data)
  messagesCache.upsert(input)  // Can throw!
  updateForwardCursor(data.chatId, data.messageId)
  // ...
}
```

**Impact:** Any database error (disk full, constraint violation, corruption) will crash the daemon with an unhandled exception.

**Fix:** Wrap all database operations in try-catch with proper error logging.

---

#### 5. ✅ FIXED - `raw_json` Never Stored
**Location:** `src/daemon/handlers.ts:108`

**Problem:** The `toMessageInput()` function hardcodes empty JSON:
```typescript
raw_json: '{}', // TODO: Store actual raw JSON when available
```

**Impact:** Violates architecture principle "Always store raw_json for future-proofing". Cannot recover full message data, cannot add new fields later without re-syncing.

**Fix:** Pass raw message object through `NewMessageData` interface and serialize it.

---

#### 6. ✅ FIXED - Backward Cursor = 0 Causes Infinite Loop
**Location:** `src/daemon/sync-worker.ts:969-980`

**Problem:** When `backward_cursor` falls back to 0:
```typescript
if (backwardCursor === null || backwardCursor === undefined) {
  backwardCursor = messagesCache.getOldestMessageId(chatId) ?? 0
}
// ...
fetchMessagesRaw(client, inputPeer, { offsetId: backwardCursor })
```

In Telegram's API, `offsetId: 0` means "start from the latest message", not "start from the beginning". This causes backward history sync to restart from newest messages instead of continuing backward.

**Impact:** Infinite backward sync loop, duplicate messages, wasted API calls.

**Fix:** If no backward cursor exists and no cached messages exist, skip backward sync or use initial load instead.

---

### P1: High Severity Issues

#### 7. ✅ FIXED - `edit_date` Never Stored on Message Edits
**Location:** `src/db/messages-cache.ts` (`updateText` method)

**Problem:** The `updateText()` method sets `is_edited = 1` but ignores the `edit_date`:
```sql
UPDATE messages_cache
SET text = $text, is_edited = 1, updated_at = $now
WHERE chat_id = $chat_id AND message_id = $message_id
```

**Impact:** Cannot determine WHEN a message was edited, only that it was edited.

**Fix:** Add `edit_date` parameter to `updateText()` and include in UPDATE.

---

#### 8. Job Deduplication Only Checks Pending Status
**Location:** `src/db/sync-jobs.ts:76-80`

**Problem:**
```typescript
hasPendingJobForChat(chatId: number, jobType: SyncJobType): boolean {
  // Only checks status = 'pending', ignores 'running'
}
```

**Impact:** Can create duplicate jobs while one is already running, causing parallel syncs for the same chat.

**Fix:** Check both `pending` AND `running` statuses, or rename to `hasActiveJobForChat()`.

---

#### 9. ✅ FIXED - Failed Jobs Never Cleaned Up
**Location:** `src/db/sync-jobs.ts` (`cleanupCompleted`)

**Problem:** Only `completed` jobs are cleaned up:
```sql
DELETE FROM sync_jobs WHERE status = $status AND completed_at < $before
-- $status is always 'completed'
```

**Impact:** Failed jobs accumulate forever, polluting the database.

**Fix:** Either clean up old failed jobs, or implement a retry mechanism with max attempts.

---

#### 10. ✅ FIXED - `INSERT OR REPLACE` Loses `created_at` Timestamp
**Location:** `src/db/messages-cache.ts` (`upsert` method)

**Problem:** SQLite's `INSERT OR REPLACE` deletes the existing row and inserts a new one. If `created_at` isn't explicitly provided, it gets the default (current timestamp).

**Impact:** Original message creation timestamp is lost on any update.

**Fix:** Use `INSERT ... ON CONFLICT DO UPDATE SET ...` instead, which preserves unspecified columns.

---

#### 11. ✅ FIXED - No Reconnection After Health Check Failure
**Location:** `src/daemon/daemon.ts:554-569`

**Problem:** When health check fails:
```typescript
} catch (err) {
  accountState.status = 'error'
  accountState.lastError = String(err)
  // No reconnection attempt
}
```

**Impact:** Account stays in `error` state forever until daemon restart.

**Fix:** Implement reconnection with exponential backoff.

---

#### 12. Hardcoded Chat Type 'private'
**Location:** `src/daemon/handlers.ts` (`ensureSyncState`)

**Problem:**
```typescript
function ensureSyncState(chatId: number, chatType: SyncChatType = 'private'): void
```

When a new message arrives for an unknown chat, it defaults to `private`. This affects sync priority calculation.

**Impact:** Channels and groups get wrong sync priority (treated as DMs).

**Fix:** Pass chat type through `NewMessageData` or infer from chat ID (negative = group/channel).

---

#### 13. `forwardFromId` Never Populated
**Location:** `src/daemon/daemon.ts:172-182`

**Problem:** The `NewMessageData` has a `forwardFromId` field, but daemon never extracts it:
```typescript
const data: NewMessageData = {
  // forwardFromId is missing - should come from msg.forward
}
```

**Impact:** Forwarded message attribution is lost.

**Fix:** Extract from `msg.forward?.sender?.id` or similar.

---

### P2: Medium Severity Issues

#### 14. CLI Commands Bypass Rate Limiting Database
**Location:** `src/commands/contacts.ts`, `send.ts`, `user.ts`, `chats.ts`, `api.ts`

**Problem:** CLI commands make direct `client.call()` without:
- Checking `rateLimits.isBlocked()`
- Recording calls with `rateLimits.recordCall()`

**Impact:** CLI and daemon don't coordinate rate limits. CLI can trigger FLOOD_WAIT that affects daemon sync.

**Mitigation:** CLI uses mtcute's built-in `floodWaiter` middleware, but no cross-process coordination.

---

#### 15. `lastJobProcessTime` Set Before Execution
**Location:** `src/daemon/daemon.ts:480`

**Problem:**
```typescript
lastJobProcessTime = now  // Set BEFORE execution
const result = await executor.execute(job)  // Takes time
```

**Impact:** Inter-job delay is calculated from job START, not job END. If a job takes 5 seconds and delay is 3 seconds, next job starts immediately.

**Fix:** Set `lastJobProcessTime = Date.now()` AFTER successful execution.

---

#### 16. Health Check Uses Expensive `getMe()` API Call
**Location:** `src/daemon/daemon.ts:558`

**Problem:** Calls `client.getMe()` every 10 seconds for EACH connected account.

**Impact:** Contributes to rate limiting, especially with 5 accounts.

**Fix:** Use lighter health check (connection state) or increase interval to 60+ seconds.

---

#### 17. ✅ FIXED - No Shutdown Timeout
**Location:** `src/daemon/daemon.ts` (cleanup function)

**Problem:** `disconnectAllAccounts()` has no timeout. If an account hangs, daemon never exits.

**Impact:** Daemon can hang indefinitely during shutdown.

**Fix:** Add timeout (e.g., 30 seconds) with force exit.

---

#### 18. State Transitions Not Validated
**Location:** `src/db/sync-jobs.ts` (`markRunning`, `markCompleted`, `markFailed`)

**Problem:** No validation that transitions are valid:
- Can mark `completed` job as `running`
- Can mark `pending` job as `completed` (skipping running)
- No error if job doesn't exist

**Fix:** Add `WHERE status = $expected_status` and check `result.changes === 1`.

---

#### 19. ✅ FIXED - `interBatchDelayMs` Config Never Used
**Location:** `src/daemon/job-executor.ts:48` + `src/daemon/daemon.ts`

**Problem:** Config exists but is never applied. Each job processes one batch, so inter-batch delay should apply between pagination calls.

**Impact:** No delay between batches, potentially higher rate limit risk.

**Fix:** Either implement or remove the config option.

---

#### 20. ✅ FIXED - High Priority Chats Miss Initial Load
**Location:** `src/daemon/scheduler.ts:139-144`

**Problem:**
```typescript
const mediumChats = chatSyncState.getChatsByPriority(SyncPriority.Medium)
// Only medium priority gets initial load, high priority is skipped
```

**Impact:** High priority chats (DMs, small groups) with no messages don't get initial load jobs.

**Fix:** Include `SyncPriority.High` chats in initial load.

---

#### 21. Services Created Every Loop Iteration
**Location:** `src/daemon/daemon.ts:573-575`

**Problem:**
```typescript
while (!state.shutdownRequested) {
  const cacheDb = getCacheDb()  // Every iteration
  const statusService = createDaemonStatusService(cacheDb)  // Every iteration
}
```

**Impact:** Unnecessary object creation, GC pressure in long-running daemon.

**Fix:** Create services once at startup, reuse in loop.

---

### P3: Low Severity / Enhancements

#### 22. Error Stack Traces Lost
**Location:** `src/daemon/daemon.ts:185, 206, 234`

**Problem:** `logger.error(\`Error: ${err}\`)` only logs message, not stack trace.

**Fix:** Use `err.stack` or proper error serialization.

---

#### 23. No Retry Mechanism for Failed Jobs
**Location:** `src/daemon/scheduler.ts`

**Problem:** Once a job fails, it stays failed forever.

**Enhancement:** Add retry with exponential backoff and max attempts.

---

#### 24. `messageType` Oversimplified
**Location:** `src/daemon/daemon.ts:180-181`

**Problem:** `messageType: msg.media ? 'media' : 'text'` loses specificity.

**Enhancement:** Detect specific types (photo, video, document, sticker, etc.).

---

#### 25. ✅ FIXED - Forward from `peerChat` Not Handled
**Location:** `src/daemon/sync-worker.ts:662-673`

**Problem:** `parseRawMessage` handles `peerUser` and `peerChannel` for forward attribution but not `peerChat`.

**Impact:** Forwarded messages from basic groups have null `forward_from_id`.

---

#### 26. No Service Message Filtering
**Location:** `src/daemon/daemon.ts:170-192`

**Problem:** Service messages (user joined, left, title changed) processed as regular messages.

**Enhancement:** Check `msg.isService` and handle appropriately.

---

#### 27. ✅ FIXED - Cannot Reset Cursors to NULL
**Location:** `src/db/chat-sync-state.ts` (`upsert` uses COALESCE)

**Problem:** `COALESCE(excluded.forward_cursor, chat_sync_state.forward_cursor)` means you cannot explicitly set a cursor back to NULL.

**Enhancement:** Add a `resetSyncState()` method for re-syncing.

---

### 📋 Missing Feature: Contact Sync

The daemon has **NO contact synchronization**:

| Feature | Message Sync | Contact Sync |
|---------|-------------|--------------|
| Real-time updates | ✅ Yes | ❌ No |
| Initial sync on start | ✅ Yes | ❌ No |
| Background jobs | ✅ Yes | ❌ No |
| Event handlers | ✅ Yes | ❌ No |

**Missing components:**
1. `handleContactUpdate` handler for add/remove/change events
2. `SyncJobType.ContactsSync` job type
3. `queueContactsSync()` in scheduler
4. Initial `contacts.getContacts` call on daemon start

**Impact:** Contacts only cached when CLI `--fresh` is used. New/removed contacts not detected.

---

### 📊 Test Coverage Gaps

**88 missing test scenarios identified:**

| Category | Count | Examples |
|----------|-------|----------|
| Untested Edge Cases | 32 | Empty arrays, null cursors, duplicate IDs |
| Missing Error Scenarios | 10 | Database failures, partial batch errors |
| Missing Integration Tests | 12 | Full sync cycle, scheduler + worker |
| Untested Code Paths | 18 | `createRealSyncWorker`, `buildInputPeer`, `parseRawMessage` |
| Missing Boundary Tests | 16 | Message ID=0, negative chat IDs, MAX_SAFE_INTEGER |

**Critical untested code:**
- `createRealSyncWorker()` - zero tests
- `createSyncWorkerRunner()` - zero tests
- `buildInputPeer()` - zero tests
- `parseRawMessage()` - zero tests
- `extractFloodWaitSeconds()` - zero tests

---

### 📚 Documentation Updates Needed

| File | Issue | Status |
|------|-------|--------|
| `CLAUDE.md` | Missing 9 daemon/db files from file structure | ✅ Fixed |
| `progress.md` | Test count discrepancy | ✅ Fixed (now 1022 tests) |
| `docs/plans/sync-strategy.md` | Implementation phase checkboxes outdated |

**Missing from CLAUDE.md file structure:**
- `src/daemon/types.ts`
- `src/daemon/job-executor.ts`
- `src/daemon/scheduler.ts`
- `src/daemon/sync-worker.ts`
- `src/db/sync-schema.ts`
- `src/db/chat-sync-state.ts`
- `src/db/sync-jobs.ts`
- `src/db/messages-cache.ts`
- `src/db/daemon-status.ts`

---

## v0.2.0 — Enhanced Sync

- [ ] Large group message sync
- [ ] Full-text search (FTS5)
- [ ] Export commands (JSON, CSV)
- [ ] Deleted message detection
- [ ] Scheduled sync tasks

---

## v0.3.0 — Media & Files

- [ ] Send/receive files
- [ ] Media download commands
- [ ] Attachment management
- [ ] Media sync to local storage

---

## Future Ideas

- [ ] Launchd/systemd service installation
- [ ] Homebrew formula
- [ ] Message edit history
- [ ] Reaction tracking
- [ ] Interactive TUI mode

---

## Key Decisions

| Decision | Choice |
|----------|--------|
| Daemon startup | Manual `tg daemon start`, foreground |
| Daemon scope | Single daemon, all accounts (max 5) |
| CLI without daemon | Works standalone with caching |
| Database | Separate per account, parallel to mtcute |
| Message staleness | Eternal |
| Peer staleness | 1 week default |
| On-demand fetch | Stale-while-revalidate + `--fresh` |
| Account ID | Numeric, @username, or custom label |
| Config format | JSON |

→ [Configuration](docs/plans/configuration.md) | [Rate Limiting](docs/plans/rate-limiting.md)

---

## Sync Priorities

1. **P0:** Real-time messages (daemon running)
2. **P1:** DMs + groups <20 members (full sync)
3. **P2:** Other chats (last 10 messages, then gradual)
4. **P3:** Large groups >100 / channels (on request only)

→ [Sync Strategy](docs/plans/sync-strategy.md)

---

## Documentation Index

### Implemented (docs/)

| Document | Description |
|----------|-------------|
| [testing.md](docs/testing.md) | Testing guide (unit + E2E) |
| [api-design.md](docs/api-design.md) | API philosophy, output modes, exit codes |
| [architecture.md](docs/architecture.md) | System overview |
| [auth.md](docs/auth.md) | Authentication (phone, QR code) |
| [database-schema.md](docs/database-schema.md) | Tables, indexes, schema |
| [caching.md](docs/caching.md) | Stale-while-revalidate, `--fresh` flag |

### Planned (docs/plans/)

| Document | Description |
|----------|-------------|
| [architecture.md](docs/plans/architecture.md) | Full system design, data flow |
| [daemon.md](docs/plans/daemon.md) | Background process implementation |
| [sync-strategy.md](docs/plans/sync-strategy.md) | Dual cursors, priorities, resumability |
| [multi-account.md](docs/plans/multi-account.md) | Account management, identification |
| [cli-commands.md](docs/plans/cli-commands.md) | All commands, flags, output formats |
| [rate-limiting.md](docs/plans/rate-limiting.md) | FLOOD_WAIT, backoff, `tg status` |
| [ai-integration.md](docs/plans/ai-integration.md) | Skills, self-install, Claude Code |
| [configuration.md](docs/plans/configuration.md) | config.json, env vars, defaults |
| [testing.md](docs/plans/testing.md) | Integration tests (planned) |
