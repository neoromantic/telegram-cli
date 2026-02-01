# Daemon Implementation Plan

## Overview

The `tg daemon` subcommand provides a long-running process that maintains persistent MTProto connections for all configured Telegram accounts, receives real-time updates, and synchronizes data to the local SQLite database.

**Key Principles:**
- **READ-ONLY**: The daemon NEVER performs mutations (no sending messages, no marking as read, no status changes)
- **Foreground execution**: User manages backgrounding via `&`, `tmux`, `nohup`, or systemd
- **Multi-account**: Single daemon instance manages ALL configured accounts (max 5)
- **Resilient**: Handles disconnections, rate limits, and errors gracefully

---

## Command Interface

```bash
# Start daemon in foreground
tg daemon start

# With verbosity control
tg daemon start --verbose    # Detailed sync logging (connection events, message counts, backfill progress)
tg daemon start --quiet      # Minimal output (errors only)

# Lifecycle management
tg daemon stop               # Gracefully stops daemon via PID file
tg daemon status             # Shows daemon state, connected accounts, sync progress
```

### Exit Codes

| Code | Meaning |
|------|---------|
| 0    | Clean shutdown |
| 1    | General error |
| 2    | Already running (PID file exists with live process) |
| 3    | No accounts configured |
| 4    | All accounts failed to connect |

---

## Architecture

### Process Model

```
┌─────────────────────────────────────────────────────────────┐
│                      tg daemon process                       │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐         │
│  │  Account 1  │  │  Account 2  │  │  Account N  │         │
│  │  MTProto    │  │  MTProto    │  │  MTProto    │  (max 5)│
│  │  Connection │  │  Connection │  │  Connection │         │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘         │
│         │                │                │                 │
│         └────────────────┼────────────────┘                 │
│                          │                                  │
│                          ▼                                  │
│              ┌───────────────────────┐                      │
│              │    Update Router      │                      │
│              │  (demux by account)   │                      │
│              └───────────┬───────────┘                      │
│                          │                                  │
│         ┌────────────────┼────────────────┐                 │
│         ▼                ▼                ▼                 │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐         │
│  │  Messages   │  │  Contacts   │  │   Chats     │         │
│  │  Handler    │  │  Handler    │  │  Handler    │         │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘         │
│         │                │                │                 │
│         └────────────────┼────────────────┘                 │
│                          │                                  │
│                          ▼                                  │
│              ┌───────────────────────┐                      │
│              │   SQLite Writer       │                      │
│              │  (single connection,  │                      │
│              │   batched writes)     │                      │
│              └───────────────────────┘                      │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### Component Responsibilities

#### 1. Connection Manager
- Establishes and maintains MTProto connections per account
- Handles reconnection with exponential backoff
- Monitors connection health via ping/pong
- Reports connection state changes

#### 2. Update Router
- Receives updates from all account connections
- Tags updates with account identifier
- Routes to appropriate handlers based on update type

#### 3. Update Handlers
- **MessagesHandler**: New messages, edited messages, deleted messages
- **ContactsHandler**: Contact additions, removals, status changes
- **ChatsHandler**: Chat metadata updates, participant changes
- **UserHandler**: User info updates, online status

#### 4. SQLite Writer
- Single database connection (thread-safe)
- Batches writes for efficiency (flush every 100ms or 50 items)
- Maintains `sync_metadata` table for resumption
- All writes include `received_at` timestamp

#### 5. Backfill Scheduler
- Manages background sync tasks for historical data
- Respects rate limits
- Prioritizes by recency and importance
- Tracks progress per account/chat

---

## Data Flow

### Real-time Updates

```
Telegram Server
      │
      │ MTProto push
      ▼
┌─────────────┐
│  grammers   │
│  TdLib/MTProto
└──────┬──────┘
       │
       ▼
┌─────────────────────────────────────┐
│           Update Event              │
│  - account_id: i64                  │
│  - update_type: UpdateType          │
│  - payload: TelegramUpdate          │
│  - received_at: DateTime<Utc>       │
└──────────────────┬──────────────────┘
                   │
                   ▼
┌─────────────────────────────────────┐
│         Transform to Model          │
│  - Extract relevant fields          │
│  - Normalize data                   │
│  - Handle media references          │
└──────────────────┬──────────────────┘
                   │
                   ▼
┌─────────────────────────────────────┐
│         SQLite UPSERT               │
│  - messages table                   │
│  - users table                      │
│  - chats table                      │
│  - sync_metadata update             │
└─────────────────────────────────────┘
```

### Backfill Process

```
┌─────────────────────────────────────┐
│       Backfill Scheduler            │
│  - Check sync_metadata for gaps     │
│  - Prioritize active chats          │
│  - Rate limit aware                 │
└──────────────────┬──────────────────┘
                   │
                   ▼
┌─────────────────────────────────────┐
│      Request Historical Data        │
│  - messages.getHistory              │
│  - contacts.getContacts             │
│  - messages.getDialogs              │
└──────────────────┬──────────────────┘
                   │
                   ▼
┌─────────────────────────────────────┐
│         Rate Limit Check            │
│  - 429 response → backoff           │
│  - Track request timestamps         │
│  - Respect flood_wait               │
└──────────────────┬──────────────────┘
                   │
                   ▼
┌─────────────────────────────────────┐
│         Batch Insert to DB          │
│  - Use transactions                 │
│  - Update sync cursors              │
└─────────────────────────────────────┘
```

---

## Implementation Details

### PID File Management

Location: `~/.config/tg/daemon.pid`

```rust
pub struct PidFile {
    path: PathBuf,
}

impl PidFile {
    /// Creates PID file, fails if daemon already running
    pub fn acquire() -> Result<Self, DaemonError> {
        let path = config_dir().join("daemon.pid");

        // Check if existing PID file points to running process
        if path.exists() {
            let pid = fs::read_to_string(&path)?.parse::<u32>()?;
            if process_exists(pid) {
                return Err(DaemonError::AlreadyRunning(pid));
            }
            // Stale PID file, remove it
            fs::remove_file(&path)?;
        }

        fs::write(&path, std::process::id().to_string())?;
        Ok(Self { path })
    }

    /// Reads PID from file, returns None if not running
    pub fn read() -> Option<u32> {
        let path = config_dir().join("daemon.pid");
        fs::read_to_string(&path)
            .ok()
            .and_then(|s| s.trim().parse().ok())
            .filter(|&pid| process_exists(pid))
    }
}

impl Drop for PidFile {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}
```

### Startup Sequence

```rust
pub async fn daemon_start(verbosity: Verbosity) -> Result<(), DaemonError> {
    // 1. Acquire PID file (fails if already running)
    let _pid_file = PidFile::acquire()?;

    // 2. Initialize logging based on verbosity
    init_logging(verbosity);

    // 3. Load all configured accounts
    let accounts = Account::load_all()?;
    if accounts.is_empty() {
        return Err(DaemonError::NoAccounts);
    }

    // 4. Open database connection
    let db = Database::open()?;

    // 5. Set up signal handlers
    let shutdown = setup_signal_handlers();

    // 6. Create shared state
    let state = Arc::new(DaemonState {
        db,
        shutdown: shutdown.clone(),
        accounts: RwLock::new(HashMap::new()),
    });

    // 7. Connect all accounts concurrently
    let connection_tasks: Vec<_> = accounts
        .into_iter()
        .map(|account| connect_account(account, state.clone()))
        .collect();

    let results = futures::future::join_all(connection_tasks).await;

    // 8. Check at least one account connected
    let connected = results.iter().filter(|r| r.is_ok()).count();
    if connected == 0 {
        return Err(DaemonError::AllAccountsFailed);
    }

    info!("{} of {} accounts connected", connected, results.len());

    // 9. Start backfill scheduler
    let backfill_handle = tokio::spawn(backfill_loop(state.clone()));

    // 10. Wait for shutdown signal
    shutdown.notified().await;

    // 11. Graceful shutdown
    info!("Shutting down...");
    backfill_handle.abort();
    disconnect_all_accounts(&state).await;

    Ok(())
}
```

### Signal Handling

```rust
fn setup_signal_handlers() -> Arc<Notify> {
    let shutdown = Arc::new(Notify::new());
    let shutdown_clone = shutdown.clone();

    tokio::spawn(async move {
        let mut sigterm = signal(SignalKind::terminate()).unwrap();
        let mut sigint = signal(SignalKind::interrupt()).unwrap();

        tokio::select! {
            _ = sigterm.recv() => info!("Received SIGTERM"),
            _ = sigint.recv() => info!("Received SIGINT"),
        }

        shutdown_clone.notify_waiters();
    });

    shutdown
}
```

### Connection Management

```rust
async fn connect_account(
    account: Account,
    state: Arc<DaemonState>,
) -> Result<(), ConnectionError> {
    let client = Client::connect(account.session_file()).await?;

    // Start update receiver loop
    let state_clone = state.clone();
    let account_id = account.id;

    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = state_clone.shutdown.notified() => break,
                update = client.next_update() => {
                    match update {
                        Some(Ok(update)) => {
                            handle_update(account_id, update, &state_clone).await;
                        }
                        Some(Err(e)) => {
                            warn!("Update error for account {}: {}", account_id, e);
                        }
                        None => {
                            // Connection closed, attempt reconnect
                            if let Err(e) = reconnect_with_backoff(&client).await {
                                error!("Reconnection failed: {}", e);
                                break;
                            }
                        }
                    }
                }
            }
        }
    });

    state.accounts.write().await.insert(account_id, client);
    Ok(())
}
```

### Reconnection with Exponential Backoff

```rust
async fn reconnect_with_backoff(client: &Client) -> Result<(), ConnectionError> {
    let mut attempt = 0;
    let max_attempts = 10;

    loop {
        attempt += 1;
        let delay = Duration::from_secs(2u64.pow(attempt.min(6))); // Max 64 seconds

        info!("Reconnection attempt {} in {:?}", attempt, delay);
        tokio::time::sleep(delay).await;

        match client.reconnect().await {
            Ok(_) => {
                info!("Reconnected successfully");
                return Ok(());
            }
            Err(e) if attempt >= max_attempts => {
                return Err(ConnectionError::MaxRetriesExceeded(e));
            }
            Err(e) => {
                warn!("Reconnection attempt {} failed: {}", attempt, e);
            }
        }
    }
}
```

### Rate Limiting

```rust
pub struct RateLimiter {
    /// Per-account request timestamps
    requests: HashMap<i64, VecDeque<Instant>>,
    /// Global flood wait until
    flood_wait_until: Option<Instant>,
}

impl RateLimiter {
    const REQUESTS_PER_SECOND: usize = 30;
    const WINDOW: Duration = Duration::from_secs(1);

    pub async fn acquire(&mut self, account_id: i64) {
        // Check global flood wait
        if let Some(until) = self.flood_wait_until {
            if Instant::now() < until {
                tokio::time::sleep_until(until.into()).await;
            }
            self.flood_wait_until = None;
        }

        // Per-account rate limiting
        let timestamps = self.requests.entry(account_id).or_default();

        // Remove old timestamps
        let cutoff = Instant::now() - Self::WINDOW;
        while timestamps.front().map_or(false, |&t| t < cutoff) {
            timestamps.pop_front();
        }

        // Wait if at limit
        if timestamps.len() >= Self::REQUESTS_PER_SECOND {
            let wait_until = timestamps.front().unwrap() + Self::WINDOW;
            tokio::time::sleep_until(wait_until.into()).await;
            timestamps.pop_front();
        }

        timestamps.push_back(Instant::now());
    }

    pub fn handle_flood_wait(&mut self, seconds: u32) {
        let until = Instant::now() + Duration::from_secs(seconds as u64);
        self.flood_wait_until = Some(until);
        warn!("Flood wait: pausing requests for {} seconds", seconds);
    }
}
```

### Update Handling

```rust
async fn handle_update(
    account_id: i64,
    update: Update,
    state: &DaemonState,
) {
    let received_at = Utc::now();

    match update {
        Update::NewMessage(msg) => {
            state.db.upsert_message(account_id, &msg, received_at).await;
        }
        Update::MessageEdited { chat_id, message_id, new_text, date } => {
            state.db.update_message_text(
                account_id, chat_id, message_id, &new_text, date, received_at
            ).await;
        }
        Update::MessageDeleted { chat_id, message_ids } => {
            state.db.mark_messages_deleted(
                account_id, chat_id, &message_ids, received_at
            ).await;
        }
        Update::UserStatus { user_id, status } => {
            state.db.update_user_status(account_id, user_id, &status, received_at).await;
        }
        Update::ChatParticipant { chat_id, user_id, action } => {
            state.db.update_chat_participant(
                account_id, chat_id, user_id, &action, received_at
            ).await;
        }
        // ... other update types
    }
}
```

### Daemon Status Command

```rust
pub async fn daemon_status() -> Result<(), DaemonError> {
    match PidFile::read() {
        Some(pid) => {
            println!("Daemon Status: RUNNING");
            println!("  PID: {}", pid);

            // Read status from shared state file
            if let Ok(status) = read_daemon_status_file() {
                println!("  Uptime: {}", format_duration(status.uptime));
                println!("  Accounts: {}/{} connected",
                    status.connected_accounts, status.total_accounts);
                println!();

                for account in &status.accounts {
                    println!("  Account: {} ({})", account.phone, account.name);
                    println!("    Status: {}", account.connection_status);
                    println!("    Messages synced: {}", account.messages_synced);
                    println!("    Last update: {}", account.last_update);
                }
            }

            Ok(())
        }
        None => {
            println!("Daemon Status: STOPPED");
            Err(DaemonError::NotRunning)
        }
    }
}
```

### Daemon Stop Command

```rust
pub fn daemon_stop() -> Result<(), DaemonError> {
    match PidFile::read() {
        Some(pid) => {
            // Send SIGTERM for graceful shutdown
            unsafe {
                libc::kill(pid as i32, libc::SIGTERM);
            }

            // Wait for process to exit (with timeout)
            let start = Instant::now();
            let timeout = Duration::from_secs(10);

            while start.elapsed() < timeout {
                if !process_exists(pid) {
                    println!("Daemon stopped successfully");
                    return Ok(());
                }
                std::thread::sleep(Duration::from_millis(100));
            }

            // Force kill if still running
            warn!("Daemon did not stop gracefully, sending SIGKILL");
            unsafe {
                libc::kill(pid as i32, libc::SIGKILL);
            }

            Ok(())
        }
        None => {
            println!("Daemon is not running");
            Err(DaemonError::NotRunning)
        }
    }
}
```

---

## Verbosity Levels

### `--quiet` (Errors Only)
```
[ERROR] Account +1234567890: Connection failed: Network unreachable
[ERROR] Database write failed: disk full
```

### Default (Normal)
```
[INFO] Starting daemon with 3 accounts
[INFO] Account +1234567890: Connected
[INFO] Account +0987654321: Connected
[INFO] Account +1122334455: Connected
[INFO] Received SIGTERM, shutting down...
[INFO] Daemon stopped
```

### `--verbose` (Detailed)
```
[INFO] Starting daemon with 3 accounts
[DEBUG] Loading session for account +1234567890
[DEBUG] Connecting to DC 2 (149.154.167.50:443)
[INFO] Account +1234567890: Connected
[DEBUG] Starting update receiver for account +1234567890
[DEBUG] Received update: NewMessage { chat_id: -1001234567, message_id: 42 }
[DEBUG] Inserted message 42 into database
[DEBUG] Backfill: Fetching history for chat -1001234567 (offset: 1000)
[DEBUG] Backfill: Received 100 messages, inserted 98 new
[INFO] Backfill progress: chat -1001234567: 45% complete
```

---

## Database Schema Additions

```sql
-- Sync state tracking for daemon
CREATE TABLE IF NOT EXISTS sync_metadata (
    account_id INTEGER NOT NULL,
    entity_type TEXT NOT NULL,  -- 'messages', 'dialogs', 'contacts'
    entity_id INTEGER NOT NULL, -- chat_id for messages, 0 for global

    -- Sync cursors
    last_message_id INTEGER,
    last_message_date INTEGER,
    pts INTEGER,

    -- Backfill state
    backfill_complete BOOLEAN DEFAULT FALSE,
    backfill_oldest_id INTEGER,

    -- Timestamps
    last_sync_at TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (account_id, entity_type, entity_id)
);

-- Daemon status (written periodically for status command)
CREATE TABLE IF NOT EXISTS daemon_status (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
```

---

## Error Handling

| Error | Recovery Strategy |
|-------|-------------------|
| Network timeout | Exponential backoff retry |
| AUTH_KEY_INVALID | Remove account, notify user |
| FLOOD_WAIT_X | Pause all requests for X seconds |
| DATABASE_LOCKED | Retry with backoff, single writer pattern |
| CHAT_FORBIDDEN | Skip chat, log warning |
| FILE_REFERENCE_EXPIRED | Re-fetch media reference |

---

## Security Considerations

1. **Session files**: Stored with 600 permissions, never logged
2. **PID file**: Prevents multiple daemon instances
3. **Database**: Single writer prevents corruption
4. **No mutations**: Daemon cannot send messages or modify Telegram state
5. **Graceful shutdown**: Ensures database consistency

---

## Future Enhancements

1. **Systemd integration**: Provide unit file template
2. **Launchd integration**: Provide plist template for macOS
3. **Metrics endpoint**: Prometheus-compatible metrics
4. **Health check endpoint**: HTTP endpoint for monitoring
5. **Selective sync**: Configure which chats to sync
6. **Media download**: Background media caching (optional)
