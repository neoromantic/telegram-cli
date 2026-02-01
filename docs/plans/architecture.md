# Telegram CLI Architecture

## Overview

Telegram CLI is a single binary that operates in two distinct modes:

1. **CLI Mode** - Interactive command execution (runs, completes, exits)
2. **Daemon Mode** - Background process that maintains Telegram connection and syncs updates

Both modes share the same SQLite database using WAL (Write-Ahead Logging) mode for safe concurrent access.

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              TELEGRAM SERVERS                                │
│                         (MTProto / TDLib Protocol)                          │
└─────────────────────────────────────────────────────────────────────────────┘
                    │                                    ▲
                    │ Updates (messages, status,         │ Mutations (send,
                    │ presence, typing, etc.)            │ read, delete, etc.)
                    ▼                                    │
┌─────────────────────────────────┐    ┌─────────────────────────────────────┐
│         DAEMON MODE             │    │            CLI MODE                  │
│    (telegram-cli daemon)        │    │     (telegram-cli <command>)         │
│                                 │    │                                      │
│  ┌───────────────────────────┐  │    │  ┌────────────────────────────────┐  │
│  │   Telegram Client         │  │    │  │   Command Parser               │  │
│  │   (grammers/TDLib)        │  │    │  │   (clap)                       │  │
│  └───────────────────────────┘  │    │  └────────────────────────────────┘  │
│              │                  │    │              │                       │
│              ▼                  │    │              ▼                       │
│  ┌───────────────────────────┐  │    │  ┌────────────────────────────────┐  │
│  │   Update Processor        │  │    │  │   Query Engine                 │  │
│  │   - New messages          │  │    │  │   - Read from DB               │  │
│  │   - User status           │  │    │  │   - Format output              │  │
│  │   - Chat updates          │  │    │  └────────────────────────────────┘  │
│  │   - Read receipts         │  │    │              │                       │
│  └───────────────────────────┘  │    │              ▼                       │
│              │                  │    │  ┌────────────────────────────────┐  │
│              │ WRITE            │    │  │   Mutation Engine              │──┼──► Telegram API
│              ▼                  │    │  │   - Send messages              │  │
│  ┌───────────────────────────┐  │    │  │   - Mark as read               │  │
│  │   Database Writer         │  │    │  │   - Delete messages            │  │
│  │   (INSERT/UPDATE only)    │  │    │  └────────────────────────────────┘  │
│  └───────────────────────────┘  │    │              │ WRITE                 │
│              │                  │    │              ▼                       │
└──────────────┼──────────────────┘    └──────────────┼───────────────────────┘
               │                                      │
               │                                      │
               ▼                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           SQLite DATABASE (WAL Mode)                         │
│                                                                              │
│   ~/.telegram-cli/accounts/<phone>/                                          │
│   ├── data.db          (messages, chats, users, media references)           │
│   ├── data.db-wal      (write-ahead log)                                    │
│   └── data.db-shm      (shared memory index)                                │
│                                                                              │
│   Tables:                                                                    │
│   ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐      │
│   │ messages │  │  chats   │  │  users   │  │  media   │  │  state   │      │
│   └──────────┘  └──────────┘  └──────────┘  └──────────┘  └──────────┘      │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Data Flow

### 1. Query Operations (CLI Mode - Read Only)

```
User runs: telegram-cli messages list --chat "Alice"

┌─────────────┐     ┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   CLI       │────►│   Query     │────►│   SQLite    │────►│   Output    │
│   Parser    │     │   Engine    │     │   (READ)    │     │   Formatter │
└─────────────┘     └─────────────┘     └─────────────┘     └─────────────┘
                                                                   │
                                                                   ▼
                                                            Terminal/Stdout
```

**Example query flow:**
```rust
// CLI parses command
let cmd = MessagesListCommand {
    chat: Some("Alice".to_string()),
    limit: 50,
};

// Query engine reads from DB
let messages = db.query(
    "SELECT * FROM messages
     WHERE chat_id = ?
     ORDER BY timestamp DESC
     LIMIT ?",
    [chat_id, limit]
)?;

// Output formatter displays
for msg in messages {
    println!("{}: {}", msg.sender, msg.text);
}
```

### 2. Mutation Operations (CLI Mode - Write to DB + API Call)

```
User runs: telegram-cli send "Alice" "Hello!"

┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   CLI       │────►│   Mutation  │────►│  Telegram   │
│   Parser    │     │   Engine    │     │  API Call   │
└─────────────┘     └─────────────┘     └─────────────┘
                           │                   │
                           │                   │ Response (msg_id, timestamp)
                           ▼                   ▼
                    ┌─────────────┐     ┌─────────────┐
                    │   SQLite    │◄────│   Update    │
                    │   (WRITE)   │     │   Local DB  │
                    └─────────────┘     └─────────────┘
```

**Example mutation flow:**
```rust
// CLI parses command
let cmd = SendCommand {
    chat: "Alice".to_string(),
    message: "Hello!".to_string(),
};

// Mutation engine sends via API
let result = telegram_client.send_message(
    chat_id,
    &cmd.message
).await?;

// Write confirmation to local DB
db.execute(
    "INSERT INTO messages (id, chat_id, sender_id, text, timestamp, is_outgoing)
     VALUES (?, ?, ?, ?, ?, true)",
    [result.msg_id, chat_id, my_user_id, cmd.message, result.timestamp]
)?;

println!("Message sent (id: {})", result.msg_id);
```

### 3. Sync Operations (Daemon Mode - Telegram to DB)

```
Telegram sends: New message update

┌─────────────┐     ┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│  Telegram   │────►│   Update    │────►│   Entity    │────►│   SQLite    │
│  Update     │     │   Handler   │     │   Resolver  │     │   (WRITE)   │
└─────────────┘     └─────────────┘     └─────────────┘     └─────────────┘
```

**Example sync flow:**
```rust
// Daemon receives update from Telegram
async fn handle_update(update: Update) {
    match update {
        Update::NewMessage(msg) => {
            // Resolve entities (user info, chat info)
            let sender = resolve_user(msg.sender_id).await;
            let chat = resolve_chat(msg.chat_id).await;

            // Upsert user/chat if needed
            db.upsert_user(&sender)?;
            db.upsert_chat(&chat)?;

            // Insert message
            db.execute(
                "INSERT OR REPLACE INTO messages
                 (id, chat_id, sender_id, text, timestamp, is_outgoing)
                 VALUES (?, ?, ?, ?, ?, ?)",
                [msg.id, msg.chat_id, msg.sender_id, msg.text, msg.date, false]
            )?;
        }
        Update::UserStatus(status) => {
            db.execute(
                "UPDATE users SET last_seen = ?, is_online = ? WHERE id = ?",
                [status.timestamp, status.online, status.user_id]
            )?;
        }
        // ... other update types
    }
}
```

---

## Component Responsibilities

### Daemon Mode

| Component | Responsibility |
|-----------|----------------|
| **Telegram Client** | Maintains persistent connection to Telegram servers via MTProto |
| **Update Processor** | Receives and categorizes incoming updates |
| **Entity Resolver** | Fetches full user/chat info when encountering new entities |
| **Database Writer** | Persists updates to SQLite (INSERT/UPDATE operations) |
| **Session Manager** | Handles reconnection, session persistence |

**Key constraint:** Daemon NEVER sends messages or makes mutations to Telegram. It is strictly a one-way sync from Telegram to local database.

### CLI Mode

| Component | Responsibility |
|-----------|----------------|
| **Command Parser** | Parses CLI arguments into structured commands |
| **Query Engine** | Executes read queries against SQLite |
| **Mutation Engine** | Sends mutations to Telegram API and updates local DB |
| **Output Formatter** | Formats query results for terminal display |
| **Account Selector** | Determines which account database to use |

**Key constraint:** CLI makes direct API calls for mutations. It does not rely on the daemon for any operations.

---

## File Structure

```
~/.telegram-cli/
├── config.toml                    # Global configuration
├── accounts/
│   ├── +1234567890/              # Account directory (phone number)
│   │   ├── session.dat           # Telegram session file (auth)
│   │   ├── data.db               # SQLite database
│   │   ├── data.db-wal           # WAL file (auto-managed)
│   │   ├── data.db-shm           # Shared memory (auto-managed)
│   │   └── media/                # Downloaded media cache
│   │       ├── photos/
│   │       ├── videos/
│   │       ├── documents/
│   │       └── voice/
│   ├── +0987654321/              # Second account
│   │   ├── session.dat
│   │   ├── data.db
│   │   └── media/
│   └── ... (max 5 accounts)
├── daemon.pid                     # PID file for daemon process
└── daemon.log                     # Daemon log file
```

### config.toml

```toml
# Global configuration
default_account = "+1234567890"
theme = "dark"
date_format = "%Y-%m-%d %H:%M"

[daemon]
log_level = "info"
auto_start = true

[display]
message_limit = 50
show_timestamps = true
show_read_status = true

[media]
auto_download_photos = true
auto_download_limit_mb = 10
cache_max_size_gb = 5
```

---

## Concurrency Model

### SQLite WAL Mode

We use SQLite's Write-Ahead Logging (WAL) mode to enable safe concurrent access:

```rust
// Database initialization
fn init_database(path: &Path) -> Result<Connection> {
    let conn = Connection::open(path)?;

    // Enable WAL mode for concurrent access
    conn.pragma_update(None, "journal_mode", "WAL")?;

    // Optimize for our read-heavy workload
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    conn.pragma_update(None, "cache_size", -64000)?; // 64MB cache
    conn.pragma_update(None, "busy_timeout", 5000)?;  // 5s timeout

    Ok(conn)
}
```

### Concurrent Access Patterns

```
┌──────────────────────────────────────────────────────────────────┐
│                    SQLITE WAL ARCHITECTURE                        │
├──────────────────────────────────────────────────────────────────┤
│                                                                   │
│   ┌─────────────┐         ┌─────────────┐                        │
│   │   DAEMON    │         │    CLI      │                        │
│   │  (Writer)   │         │  (Reader +  │                        │
│   │             │         │   Writer)   │                        │
│   └──────┬──────┘         └──────┬──────┘                        │
│          │                       │                                │
│          │ WRITE                 │ READ (snapshot isolation)     │
│          ▼                       ▼                                │
│   ┌─────────────────────────────────────────────┐                │
│   │              data.db-wal                     │                │
│   │         (Write-Ahead Log)                    │                │
│   │                                              │                │
│   │   [tx1: INSERT msg] [tx2: UPDATE user] ...  │                │
│   └─────────────────────────────────────────────┘                │
│                         │                                         │
│                         │ Checkpoint (automatic)                  │
│                         ▼                                         │
│   ┌─────────────────────────────────────────────┐                │
│   │              data.db                         │                │
│   │         (Main Database)                      │                │
│   └─────────────────────────────────────────────┘                │
│                                                                   │
└──────────────────────────────────────────────────────────────────┘
```

**Benefits of WAL mode:**

1. **Multiple readers, one writer** - CLI can read while daemon writes
2. **No blocking** - Readers don't block writers, writers don't block readers
3. **Snapshot isolation** - Each reader sees consistent state
4. **Crash safety** - WAL provides durability guarantees

### Write Conflict Resolution

Since both daemon and CLI can write, we use these strategies:

```rust
// Strategy 1: Different domains (preferred)
// - Daemon writes: messages, users, chats, status updates
// - CLI writes: sent messages, read markers, local preferences

// Strategy 2: INSERT OR REPLACE for idempotent operations
db.execute(
    "INSERT OR REPLACE INTO messages (id, chat_id, text, ...) VALUES (?, ?, ?, ...)",
    params
)?;

// Strategy 3: Busy timeout for rare conflicts
// Already set: busy_timeout = 5000 (5 seconds)
```

---

## Multi-Account Support

### Account Selection

```rust
// Priority order for account selection:
// 1. Explicit --account flag
// 2. TELEGRAM_CLI_ACCOUNT environment variable
// 3. default_account from config.toml
// 4. Only account (if single account configured)
// 5. Interactive prompt (if multiple accounts, none default)

fn select_account(args: &Args) -> Result<Account> {
    if let Some(phone) = &args.account {
        return load_account(phone);
    }

    if let Ok(phone) = std::env::var("TELEGRAM_CLI_ACCOUNT") {
        return load_account(&phone);
    }

    let config = load_config()?;
    if let Some(phone) = &config.default_account {
        return load_account(phone);
    }

    let accounts = list_accounts()?;
    match accounts.len() {
        0 => Err(Error::NoAccounts),
        1 => load_account(&accounts[0]),
        _ => prompt_account_selection(&accounts),
    }
}
```

### Account Limit Enforcement

```rust
const MAX_ACCOUNTS: usize = 5;

fn add_account(phone: &str) -> Result<()> {
    let accounts = list_accounts()?;

    if accounts.len() >= MAX_ACCOUNTS {
        return Err(Error::AccountLimitReached(MAX_ACCOUNTS));
    }

    // Proceed with authentication...
}
```

---

## Database Schema

```sql
-- Core tables
CREATE TABLE messages (
    id INTEGER PRIMARY KEY,
    chat_id INTEGER NOT NULL,
    sender_id INTEGER NOT NULL,
    reply_to_id INTEGER,
    text TEXT,
    timestamp INTEGER NOT NULL,
    is_outgoing BOOLEAN NOT NULL,
    is_read BOOLEAN DEFAULT FALSE,
    media_type TEXT,  -- 'photo', 'video', 'document', 'voice', etc.
    media_id TEXT,    -- Reference to media file
    FOREIGN KEY (chat_id) REFERENCES chats(id),
    FOREIGN KEY (sender_id) REFERENCES users(id)
);

CREATE TABLE chats (
    id INTEGER PRIMARY KEY,
    type TEXT NOT NULL,  -- 'user', 'group', 'supergroup', 'channel'
    title TEXT,
    username TEXT,
    unread_count INTEGER DEFAULT 0,
    last_message_id INTEGER,
    last_message_timestamp INTEGER,
    is_muted BOOLEAN DEFAULT FALSE,
    is_archived BOOLEAN DEFAULT FALSE
);

CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    first_name TEXT,
    last_name TEXT,
    username TEXT,
    phone TEXT,
    is_bot BOOLEAN DEFAULT FALSE,
    is_contact BOOLEAN DEFAULT FALSE,
    last_seen INTEGER,
    is_online BOOLEAN DEFAULT FALSE
);

CREATE TABLE media (
    id TEXT PRIMARY KEY,
    message_id INTEGER,
    type TEXT NOT NULL,
    file_path TEXT,  -- Local path if downloaded
    file_size INTEGER,
    mime_type TEXT,
    width INTEGER,
    height INTEGER,
    duration INTEGER,  -- For video/audio
    thumbnail_path TEXT,
    FOREIGN KEY (message_id) REFERENCES messages(id)
);

CREATE TABLE sync_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- Indexes for common queries
CREATE INDEX idx_messages_chat ON messages(chat_id, timestamp DESC);
CREATE INDEX idx_messages_sender ON messages(sender_id);
CREATE INDEX idx_chats_last_message ON chats(last_message_timestamp DESC);
CREATE INDEX idx_users_username ON users(username);
```

---

## Daemon Lifecycle

### Starting the Daemon

```bash
# Start daemon for default account
telegram-cli daemon start

# Start daemon for specific account
telegram-cli daemon start --account +1234567890

# Start daemons for all accounts
telegram-cli daemon start --all
```

### Daemon Management

```rust
// PID file management
fn start_daemon(account: &str) -> Result<()> {
    let pid_file = get_pid_path(account);

    if pid_file.exists() {
        let pid = read_pid(&pid_file)?;
        if process_exists(pid) {
            return Err(Error::DaemonAlreadyRunning(pid));
        }
        // Stale PID file, remove it
        fs::remove_file(&pid_file)?;
    }

    // Fork and detach
    let child = Command::new(current_exe()?)
        .args(["daemon", "run", "--account", account])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()?;

    write_pid(&pid_file, child.id())?;
    println!("Daemon started (PID: {})", child.id());
    Ok(())
}
```

### Graceful Shutdown

```rust
async fn run_daemon(account: &str) -> Result<()> {
    let client = create_telegram_client(account).await?;
    let db = open_database(account)?;

    // Handle SIGTERM/SIGINT
    let shutdown = Arc::new(AtomicBool::new(false));
    let shutdown_clone = shutdown.clone();

    ctrlc::set_handler(move || {
        shutdown_clone.store(true, Ordering::SeqCst);
    })?;

    // Main update loop
    while !shutdown.load(Ordering::SeqCst) {
        tokio::select! {
            update = client.next_update() => {
                if let Some(update) = update {
                    process_update(&db, update).await?;
                }
            }
            _ = tokio::time::sleep(Duration::from_millis(100)) => {
                // Check shutdown flag
            }
        }
    }

    // Cleanup
    client.disconnect().await?;
    remove_pid_file(account)?;

    Ok(())
}
```

---

## Error Handling

### CLI Mode Errors

```rust
#[derive(Error, Debug)]
pub enum CliError {
    #[error("Account not found: {0}")]
    AccountNotFound(String),

    #[error("Database error: {0}")]
    Database(#[from] rusqlite::Error),

    #[error("Telegram API error: {0}")]
    TelegramApi(String),

    #[error("Chat not found: {0}")]
    ChatNotFound(String),

    #[error("Not authenticated. Run 'telegram-cli auth' first.")]
    NotAuthenticated,

    #[error("Daemon not running. Start with 'telegram-cli daemon start'")]
    DaemonNotRunning,
}
```

### Daemon Resilience

```rust
async fn run_with_reconnect(account: &str) -> Result<()> {
    loop {
        match run_daemon_inner(account).await {
            Ok(()) => break,  // Clean shutdown
            Err(e) if e.is_network_error() => {
                eprintln!("Connection lost, reconnecting in 5s...");
                tokio::time::sleep(Duration::from_secs(5)).await;
            }
            Err(e) => return Err(e),  // Fatal error
        }
    }
    Ok(())
}
```

---

## Future Considerations

### Not in Initial Scope

- **Encryption at rest** - Database encryption for sensitive data
- **Push notifications** - System notifications for new messages
- **Media streaming** - Progressive download for large files
- **Group admin features** - Ban, kick, promote users
- **Bot API support** - Running bots through CLI

### Extension Points

The architecture supports future additions through:

1. **Plugin system** - Additional output formatters
2. **Webhook support** - HTTP callbacks for updates
3. **Export formats** - JSON, CSV export of chat history
4. **TUI mode** - Full terminal UI using ratatui
