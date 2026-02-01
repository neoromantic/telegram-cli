# Rate Limiting Plan

This document outlines the comprehensive rate limiting strategy for telegram-cli to ensure reliable API usage while respecting Telegram's limits.

## Overview

Telegram enforces strict rate limits on API calls. Exceeding these limits results in `FLOOD_WAIT` errors that temporarily block requests. Our strategy involves:

1. **Proactive rate tracking** - Monitor API calls before limits are hit
2. **Reactive handling** - Parse and respect FLOOD_WAIT errors when they occur
3. **Queue-based operations** - Throttle bulk operations during sync
4. **Shared coordination** - Daemon and CLI coordinate via shared database

---

## Database Schema

### `rate_limits` Table

Tracks API call counts per method within time windows.

```sql
CREATE TABLE rate_limits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    method TEXT NOT NULL,           -- e.g., 'messages.getHistory', 'contacts.getContacts'
    window_start INTEGER NOT NULL,  -- Unix timestamp of window start
    call_count INTEGER DEFAULT 0,   -- Number of calls in this window
    last_call_at INTEGER,           -- Last call timestamp
    UNIQUE(method, window_start)
);

CREATE INDEX idx_rate_limits_method ON rate_limits(method);
CREATE INDEX idx_rate_limits_window ON rate_limits(window_start);
```

### `api_activity` Table

Logs all API activity for debugging and analysis.

```sql
CREATE TABLE api_activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp INTEGER NOT NULL,     -- Unix timestamp
    method TEXT NOT NULL,           -- API method called
    success INTEGER NOT NULL,       -- 1 = success, 0 = failure
    error_code TEXT,                -- Error code if failed (e.g., 'FLOOD_WAIT_420')
    flood_wait_seconds INTEGER,     -- FLOOD_WAIT duration if applicable
    request_duration_ms INTEGER,    -- How long the request took
    context TEXT                    -- Optional: sync job ID, command, etc.
);

CREATE INDEX idx_api_activity_timestamp ON api_activity(timestamp);
CREATE INDEX idx_api_activity_method ON api_activity(method);
CREATE INDEX idx_api_activity_error ON api_activity(error_code);
```

### `flood_wait_state` Table

Tracks active FLOOD_WAIT restrictions.

```sql
CREATE TABLE flood_wait_state (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    method TEXT NOT NULL UNIQUE,    -- Method that triggered FLOOD_WAIT
    blocked_until INTEGER NOT NULL, -- Unix timestamp when block expires
    wait_seconds INTEGER NOT NULL,  -- Original wait duration
    created_at INTEGER NOT NULL     -- When the block was recorded
);

CREATE INDEX idx_flood_wait_blocked ON flood_wait_state(blocked_until);
```

---

## FLOOD_WAIT Error Handling

### Error Parsing

FLOOD_WAIT errors follow the pattern `FLOOD_WAIT_X` where X is seconds to wait.

```rust
/// Parse FLOOD_WAIT error and extract wait duration
fn parse_flood_wait_error(error: &str) -> Option<u64> {
    // Pattern: "FLOOD_WAIT_420" or "A]wait of 420 seconds is required"
    if let Some(captures) = FLOOD_WAIT_REGEX.captures(error) {
        captures.get(1)?.as_str().parse().ok()
    } else {
        None
    }
}

// Regex patterns to match:
// - FLOOD_WAIT_(\d+)
// - [Ww]ait of (\d+) seconds
lazy_static! {
    static ref FLOOD_WAIT_REGEX: Regex =
        Regex::new(r"FLOOD_WAIT_(\d+)|[Ww]ait of (\d+) seconds").unwrap();
}
```

### Recording FLOOD_WAIT State

When a FLOOD_WAIT error is received:

```rust
async fn handle_flood_wait(
    db: &Database,
    method: &str,
    wait_seconds: u64,
) -> Result<()> {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)?
        .as_secs();

    let blocked_until = now + wait_seconds;

    // Record in flood_wait_state
    sqlx::query!(
        r#"
        INSERT INTO flood_wait_state (method, blocked_until, wait_seconds, created_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(method) DO UPDATE SET
            blocked_until = excluded.blocked_until,
            wait_seconds = excluded.wait_seconds,
            created_at = excluded.created_at
        "#,
        method,
        blocked_until,
        wait_seconds,
        now
    )
    .execute(db)
    .await?;

    // Log to api_activity
    log_api_activity(db, method, false, Some(format!("FLOOD_WAIT_{}", wait_seconds)), Some(wait_seconds)).await?;

    Ok(())
}
```

### Pre-Request Check

Before making any API call, check for active blocks:

```rust
async fn check_flood_wait_clear(db: &Database, method: &str) -> Result<bool> {
    let now = current_timestamp();

    // Check if method is blocked
    let block = sqlx::query!(
        "SELECT blocked_until FROM flood_wait_state WHERE method = ?",
        method
    )
    .fetch_optional(db)
    .await?;

    match block {
        Some(row) if row.blocked_until > now => {
            // Still blocked
            Ok(false)
        }
        Some(_) => {
            // Block expired, clean up
            sqlx::query!("DELETE FROM flood_wait_state WHERE method = ?", method)
                .execute(db)
                .await?;
            Ok(true)
        }
        None => Ok(true), // No block
    }
}
```

---

## Backoff Strategies

### Exponential Backoff with Jitter

For transient errors and retry logic:

```rust
pub struct BackoffConfig {
    pub initial_delay_ms: u64,      // Starting delay (e.g., 100ms)
    pub max_delay_ms: u64,          // Maximum delay cap (e.g., 60000ms)
    pub multiplier: f64,            // Exponential multiplier (e.g., 2.0)
    pub jitter_factor: f64,         // Random jitter 0.0-1.0 (e.g., 0.1)
    pub max_retries: u32,           // Maximum retry attempts
}

impl Default for BackoffConfig {
    fn default() -> Self {
        Self {
            initial_delay_ms: 100,
            max_delay_ms: 60_000,
            multiplier: 2.0,
            jitter_factor: 0.1,
            max_retries: 5,
        }
    }
}

pub fn calculate_backoff(config: &BackoffConfig, attempt: u32) -> Duration {
    let base_delay = config.initial_delay_ms as f64
        * config.multiplier.powi(attempt as i32);

    let capped_delay = base_delay.min(config.max_delay_ms as f64);

    // Add jitter: random value between -jitter_factor and +jitter_factor
    let jitter_range = capped_delay * config.jitter_factor;
    let jitter = rand::thread_rng().gen_range(-jitter_range..=jitter_range);

    let final_delay = (capped_delay + jitter).max(0.0) as u64;

    Duration::from_millis(final_delay)
}
```

### FLOOD_WAIT-Specific Backoff

When FLOOD_WAIT is received, use the exact wait time plus small buffer:

```rust
async fn wait_for_flood_clear(wait_seconds: u64) {
    // Add 1-2 second buffer to be safe
    let buffer = rand::thread_rng().gen_range(1..=2);
    let total_wait = wait_seconds + buffer;

    tracing::warn!(
        "FLOOD_WAIT received, waiting {} seconds ({}s + {}s buffer)",
        total_wait, wait_seconds, buffer
    );

    tokio::time::sleep(Duration::from_secs(total_wait)).await;
}
```

### Retry Wrapper

```rust
pub async fn with_retry<F, T, E>(
    config: &BackoffConfig,
    operation: F,
) -> Result<T, E>
where
    F: Fn() -> Future<Output = Result<T, E>>,
    E: AsFloodWait,
{
    let mut attempt = 0;

    loop {
        match operation().await {
            Ok(result) => return Ok(result),
            Err(e) if e.is_flood_wait() => {
                let wait_secs = e.flood_wait_seconds().unwrap_or(60);
                wait_for_flood_clear(wait_secs).await;
                // Don't count FLOOD_WAIT against retry limit
            }
            Err(e) if e.is_retryable() && attempt < config.max_retries => {
                let delay = calculate_backoff(config, attempt);
                tracing::debug!("Retry attempt {} after {:?}", attempt + 1, delay);
                tokio::time::sleep(delay).await;
                attempt += 1;
            }
            Err(e) => return Err(e),
        }
    }
}
```

---

## Per-Method Rate Tracking

### Telegram's Known Limits (Approximate)

| Method Category | Soft Limit | Notes |
|----------------|------------|-------|
| `messages.getHistory` | ~30/min | Per-dialog, stricter for non-contacts |
| `messages.search` | ~20/min | Global search is more restricted |
| `contacts.getContacts` | ~5/min | Infrequent operation |
| `messages.sendMessage` | ~30/min | Higher for premium users |
| `channels.getParticipants` | ~20/min | Stricter for large channels |

### Rate Tracking Implementation

```rust
const RATE_WINDOW_SECONDS: i64 = 60; // 1-minute windows

pub async fn record_api_call(db: &Database, method: &str) -> Result<()> {
    let now = current_timestamp();
    let window_start = (now / RATE_WINDOW_SECONDS) * RATE_WINDOW_SECONDS;

    sqlx::query!(
        r#"
        INSERT INTO rate_limits (method, window_start, call_count, last_call_at)
        VALUES (?, ?, 1, ?)
        ON CONFLICT(method, window_start) DO UPDATE SET
            call_count = call_count + 1,
            last_call_at = ?
        "#,
        method,
        window_start,
        now,
        now
    )
    .execute(db)
    .await?;

    Ok(())
}

pub async fn get_recent_call_count(
    db: &Database,
    method: Option<&str>,
    minutes: i64,
) -> Result<i64> {
    let cutoff = current_timestamp() - (minutes * 60);

    let count = match method {
        Some(m) => {
            sqlx::query_scalar!(
                "SELECT COALESCE(SUM(call_count), 0) FROM rate_limits WHERE method = ? AND window_start >= ?",
                m, cutoff
            )
            .fetch_one(db)
            .await?
        }
        None => {
            sqlx::query_scalar!(
                "SELECT COALESCE(SUM(call_count), 0) FROM rate_limits WHERE window_start >= ?",
                cutoff
            )
            .fetch_one(db)
            .await?
        }
    };

    Ok(count.unwrap_or(0))
}
```

---

## Queue System for Bulk Operations

### Sync Operation Delays

During sync operations, enforce delays to prevent hitting rate limits:

| Delay Type | Duration | Description |
|-----------|----------|-------------|
| Inter-batch | 1 second | Delay between batches of messages within same dialog |
| Inter-job | 3 seconds | Delay between different sync jobs (dialogs) |
| Error recovery | Exponential | After transient errors |
| FLOOD_WAIT | As specified | Plus 1-2 second buffer |

### Sync Queue Implementation

```rust
pub struct SyncQueue {
    jobs: VecDeque<SyncJob>,
    inter_batch_delay: Duration,
    inter_job_delay: Duration,
    last_job_completed: Option<Instant>,
}

impl SyncQueue {
    pub fn new() -> Self {
        Self {
            jobs: VecDeque::new(),
            inter_batch_delay: Duration::from_secs(1),
            inter_job_delay: Duration::from_secs(3),
            last_job_completed: None,
        }
    }

    pub async fn process_next(&mut self, db: &Database) -> Result<()> {
        // Wait for inter-job delay if needed
        if let Some(last_completed) = self.last_job_completed {
            let elapsed = last_completed.elapsed();
            if elapsed < self.inter_job_delay {
                tokio::time::sleep(self.inter_job_delay - elapsed).await;
            }
        }

        if let Some(job) = self.jobs.pop_front() {
            self.process_job(job, db).await?;
            self.last_job_completed = Some(Instant::now());
        }

        Ok(())
    }

    async fn process_job(&self, job: SyncJob, db: &Database) -> Result<()> {
        let mut offset = 0;

        loop {
            // Check for FLOOD_WAIT before each batch
            if !check_flood_wait_clear(db, "messages.getHistory").await? {
                // Wait and retry
                let wait = get_flood_wait_remaining(db, "messages.getHistory").await?;
                wait_for_flood_clear(wait).await;
            }

            // Fetch batch
            let messages = fetch_message_batch(&job, offset).await?;

            if messages.is_empty() {
                break;
            }

            // Store batch
            store_messages(db, &messages).await?;

            offset += messages.len();

            // Inter-batch delay
            tokio::time::sleep(self.inter_batch_delay).await;
        }

        Ok(())
    }
}
```

---

## Daemon and CLI Coordination

The daemon and CLI coordinate rate limiting through the shared SQLite database.

### Architecture

```
┌─────────────────┐     ┌──────────────────────┐     ┌─────────────────┐
│   CLI (tg)      │────▶│  SQLite Database     │◀────│    Daemon       │
│                 │     │                      │     │                 │
│ - Reads status  │     │ - rate_limits        │     │ - Writes calls  │
│ - Shows blocks  │     │ - api_activity       │     │ - Records waits │
│ - Can pause     │     │ - flood_wait_state   │     │ - Runs sync     │
│   sync          │     │ - sync_state         │     │                 │
└─────────────────┘     └──────────────────────┘     └─────────────────┘
```

### Coordination Protocol

1. **Daemon writes, CLI reads**: The daemon records all API activity. The CLI queries this for status display.

2. **FLOOD_WAIT visibility**: When daemon encounters FLOOD_WAIT, it records to `flood_wait_state`. CLI can display active blocks.

3. **Sync pause/resume**: CLI can set a flag in database to pause sync. Daemon checks this flag between jobs.

```rust
// In daemon: check for pause flag
async fn should_continue_sync(db: &Database) -> bool {
    let paused = sqlx::query_scalar!(
        "SELECT value FROM settings WHERE key = 'sync_paused'"
    )
    .fetch_optional(db)
    .await
    .ok()
    .flatten();

    paused.map(|v| v != "1").unwrap_or(true)
}

// In CLI: pause sync
async fn pause_sync(db: &Database) -> Result<()> {
    sqlx::query!(
        "INSERT OR REPLACE INTO settings (key, value) VALUES ('sync_paused', '1')"
    )
    .execute(db)
    .await?;
    Ok(())
}
```

---

## `tg status` Command

### Implementation

```rust
pub async fn status_command(db: &Database) -> Result<()> {
    let account = get_current_account(db).await?;
    let daemon_status = check_daemon_status().await;
    let recent_calls = get_recent_call_count(db, None, 5).await?;
    let active_waits = get_active_flood_waits(db).await?;
    let sync_progress = get_sync_progress(db).await?;

    // Format and print status
    print_status(account, daemon_status, recent_calls, active_waits, sync_progress);

    Ok(())
}

async fn get_active_flood_waits(db: &Database) -> Result<Vec<FloodWaitInfo>> {
    let now = current_timestamp();

    sqlx::query_as!(
        FloodWaitInfo,
        r#"
        SELECT method, blocked_until, wait_seconds, created_at
        FROM flood_wait_state
        WHERE blocked_until > ?
        ORDER BY blocked_until ASC
        "#,
        now
    )
    .fetch_all(db)
    .await
}

async fn get_sync_progress(db: &Database) -> Result<Option<SyncProgress>> {
    sqlx::query_as!(
        SyncProgress,
        r#"
        SELECT
            (SELECT COUNT(*) FROM sync_jobs WHERE status = 'completed') as completed,
            (SELECT COUNT(*) FROM sync_jobs WHERE status = 'pending') as pending,
            (SELECT COUNT(*) FROM sync_jobs WHERE status = 'in_progress') as in_progress,
            (SELECT dialog_name FROM sync_jobs WHERE status = 'in_progress' LIMIT 1) as current_dialog
        "#
    )
    .fetch_optional(db)
    .await
}
```

### Example Output

```
$ tg status

Account
  User: John Doe (@johndoe)
  Phone: +1 555-123-4567
  Premium: Yes

Daemon
  Status: Running (PID 12345)
  Uptime: 2h 34m
  Memory: 45 MB

API Activity (last 5 minutes)
  Total calls: 127
  By method:
    messages.getHistory    68
    messages.readHistory   42
    updates.getState       17

Rate Limits
  Status: OK (no active restrictions)

Sync Progress
  Status: Running
  Current: Family Group Chat
  Progress: 45/128 dialogs (35%)
  Messages synced: 12,847
  ETA: ~15 minutes

$ tg status  # When FLOOD_WAIT is active

Account
  User: John Doe (@johndoe)
  Phone: +1 555-123-4567
  Premium: Yes

Daemon
  Status: Running (PID 12345)
  Uptime: 2h 34m
  Memory: 45 MB

API Activity (last 5 minutes)
  Total calls: 89
  By method:
    messages.getHistory    52
    messages.readHistory   28
    updates.getState        9

Rate Limits
  Status: RESTRICTED

  Active FLOOD_WAIT restrictions:
  ┌─────────────────────────┬──────────────┬─────────────┐
  │ Method                  │ Wait (orig)  │ Clears in   │
  ├─────────────────────────┼──────────────┼─────────────┤
  │ messages.getHistory     │ 420s         │ 6m 32s      │
  │ channels.getParticipants│ 60s          │ 45s         │
  └─────────────────────────┴──────────────┴─────────────┘

Sync Progress
  Status: Paused (waiting for rate limit)
  Current: Tech News Channel
  Progress: 45/128 dialogs (35%)
  Messages synced: 12,847
  Resumes in: 6m 32s
```

### Compact Output Option

```
$ tg status --compact

@johndoe | Daemon: Running | Calls: 127/5m | Sync: 35% (45/128)
```

### JSON Output Option

```
$ tg status --json

{
  "account": {
    "username": "johndoe",
    "display_name": "John Doe",
    "phone": "+15551234567",
    "premium": true
  },
  "daemon": {
    "running": true,
    "pid": 12345,
    "uptime_seconds": 9240,
    "memory_bytes": 47185920
  },
  "api_activity": {
    "window_minutes": 5,
    "total_calls": 127,
    "by_method": {
      "messages.getHistory": 68,
      "messages.readHistory": 42,
      "updates.getState": 17
    }
  },
  "rate_limits": {
    "restricted": false,
    "active_waits": []
  },
  "sync": {
    "running": true,
    "paused": false,
    "current_dialog": "Family Group Chat",
    "completed": 45,
    "total": 128,
    "messages_synced": 12847,
    "eta_seconds": 900
  }
}
```

---

## Error Recovery Scenarios

### Scenario 1: Single FLOOD_WAIT

```
1. API call fails with FLOOD_WAIT_420
2. Record in flood_wait_state (method, blocked_until = now + 420)
3. Log to api_activity with error
4. Wait 420 + random(1-2) seconds
5. Clear flood_wait_state entry
6. Retry operation
```

### Scenario 2: Multiple Methods Blocked

```
1. Different methods hit FLOOD_WAIT at different times
2. Each recorded independently in flood_wait_state
3. Sync continues with non-blocked methods
4. Blocked methods resume as their waits clear
5. Status shows all active restrictions
```

### Scenario 3: Repeated FLOOD_WAIT

```
1. Same method hits FLOOD_WAIT multiple times
2. After 3rd FLOOD_WAIT in 1 hour, add extra 5-minute cooldown
3. Log escalation pattern
4. Alert user via status command
```

---

## Configuration

Default values with override options in config file:

```toml
[rate_limits]
# Sync delays
inter_batch_delay_ms = 1000
inter_job_delay_ms = 3000

# Backoff configuration
initial_backoff_ms = 100
max_backoff_ms = 60000
backoff_multiplier = 2.0
jitter_factor = 0.1
max_retries = 5

# FLOOD_WAIT handling
flood_wait_buffer_min_secs = 1
flood_wait_buffer_max_secs = 2

# Escalation thresholds
flood_wait_escalation_count = 3
flood_wait_escalation_window_mins = 60
flood_wait_escalation_extra_secs = 300

# Activity log retention
activity_log_retention_days = 7
```

---

## Maintenance

### Cleanup Old Data

Run periodically (e.g., daily):

```sql
-- Clean old rate_limits windows (older than 1 hour)
DELETE FROM rate_limits WHERE window_start < (strftime('%s', 'now') - 3600);

-- Clean old api_activity (based on retention setting)
DELETE FROM api_activity WHERE timestamp < (strftime('%s', 'now') - 86400 * 7);

-- Clean expired flood_wait_state
DELETE FROM flood_wait_state WHERE blocked_until < strftime('%s', 'now');
```

---

## Future Enhancements

1. **Adaptive rate limiting**: Learn actual limits from FLOOD_WAIT patterns
2. **Per-account limits**: Track limits separately for each account
3. **Priority queues**: High-priority operations (user-initiated) skip queue
4. **Predictive throttling**: Slow down before hitting limits
5. **Dashboard**: Web UI for monitoring rate limit status
