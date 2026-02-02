# Telegram CLI Sync Strategy

## Overview

This document outlines the comprehensive sync strategy for the Telegram CLI daemon, ensuring efficient message synchronization with proper prioritization, cursor management, and resumability.

## Core Concepts

### Dual Cursor System

Each chat maintains two independent cursors for bidirectional sync:

```
Timeline: [oldest] -------- [backward_cursor] -------- [forward_cursor] -------- [newest/realtime]
                   ^                                                        ^
                   |                                                        |
           History backfill                                          Real-time updates
           (loads older msgs)                                        (catches new msgs)
```

1. **Forward Cursor (`forward_cursor`)**: Tracks the most recent synced message for real-time updates
   - On daemon restart, first catches up on all messages since `forward_cursor`
   - Then subscribes to real-time update stream

2. **Backward Cursor (`backward_cursor`)**: Tracks progress of historical message loading
   - Moves backward in time as older messages are fetched
   - `null` indicates history sync not started; special value indicates complete

## Sync Priorities

### Priority Tiers

| Priority | Category | Sync Behavior |
|----------|----------|---------------|
| **P0** | Real-time | New messages synced immediately when daemon running |
| **P1** | DMs & Small Groups (<20 members) | Full history sync |
| **P2** | Medium Groups (20-100 members) | Last 10 messages initially, then gradual deep sync |
| **P3** | Large Groups (>100 members) & Channels | **NOT synced** unless explicitly requested |
| **P4** | Explicit Requests | User-requested sync of any chat |

### Sync Rules Summary

```
Chat Type               | Auto Sync | Initial Load | Deep Sync
------------------------|-----------|--------------|------------
DMs                     | YES       | Full         | Full
Groups < 20 members     | YES       | Full         | Full
Groups 20-100 members   | YES       | 10 messages  | Background
Groups > 100 members    | NO        | On request   | On request
Channels                | NO        | On request   | On request
```

## Data Model

### Cursor Storage Schema

```sql
-- Chat sync state table
CREATE TABLE chat_sync_state (
    chat_id             INTEGER PRIMARY KEY,
    chat_type           TEXT NOT NULL,        -- 'private', 'group', 'supergroup', 'channel'
    member_count        INTEGER,

    -- Cursors (message IDs)
    forward_cursor      INTEGER,              -- Last synced message ID (for real-time)
    backward_cursor     INTEGER,              -- Oldest synced message ID (for history)

    -- Sync metadata
    sync_priority       INTEGER NOT NULL,     -- 1-4, lower = higher priority
    sync_enabled        BOOLEAN DEFAULT TRUE, -- FALSE for large groups/channels
    history_complete    BOOLEAN DEFAULT FALSE,

    -- Progress tracking
    total_messages      INTEGER,              -- Known total (from Telegram)
    synced_messages     INTEGER DEFAULT 0,

    -- Timestamps
    last_forward_sync   DATETIME,
    last_backward_sync  DATETIME,
    created_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at          DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Contact list storage
CREATE TABLE contacts (
    user_id             INTEGER PRIMARY KEY,
    username            TEXT,
    first_name          TEXT,
    last_name           TEXT,
    phone               TEXT,
    is_mutual           BOOLEAN,
    last_seen           DATETIME,
    updated_at          DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Sync job queue
CREATE TABLE sync_jobs (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id             INTEGER NOT NULL,
    job_type            TEXT NOT NULL,        -- 'forward_catchup', 'backward_history', 'full_sync'
    priority            INTEGER NOT NULL,
    status              TEXT DEFAULT 'pending', -- 'pending', 'running', 'completed', 'failed'
    cursor_start        INTEGER,
    cursor_end          INTEGER,
    messages_fetched    INTEGER DEFAULT 0,
    error_message       TEXT,
    created_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
    started_at          DATETIME,
    completed_at        DATETIME,

    FOREIGN KEY (chat_id) REFERENCES chat_sync_state(chat_id)
);
```

## Cursor Management

### Forward Cursor Logic

```rust
/// Forward cursor tracks real-time sync position
pub struct ForwardCursor {
    chat_id: i64,
    last_message_id: Option<i64>,
    last_sync_time: DateTime<Utc>,
}

impl ForwardCursor {
    /// On daemon startup, catch up on missed messages
    pub async fn catch_up(&mut self, client: &TelegramClient) -> Result<Vec<Message>> {
        let missed_messages = if let Some(last_id) = self.last_message_id {
            // Fetch all messages after our last known message
            client.get_chat_history(
                self.chat_id,
                from_message_id: last_id,
                direction: Direction::Forward,
                limit: 0, // No limit - get all missed
            ).await?
        } else {
            // First sync - just get most recent to establish cursor
            client.get_chat_history(
                self.chat_id,
                from_message_id: 0,
                direction: Direction::Backward,
                limit: 1,
            ).await?
        };

        // Update cursor to newest message
        if let Some(newest) = missed_messages.last() {
            self.last_message_id = Some(newest.id);
            self.last_sync_time = Utc::now();
            self.persist().await?;
        }

        Ok(missed_messages)
    }

    /// Handle real-time message from update stream
    pub async fn on_new_message(&mut self, message: &Message) -> Result<()> {
        if message.id > self.last_message_id.unwrap_or(0) {
            self.last_message_id = Some(message.id);
            self.last_sync_time = Utc::now();
            self.persist().await?;
        }
        Ok(())
    }
}
```

### Backward Cursor Logic

```rust
/// Backward cursor tracks history loading progress
pub struct BackwardCursor {
    chat_id: i64,
    oldest_message_id: Option<i64>,
    history_complete: bool,
    messages_synced: u64,
}

impl BackwardCursor {
    /// Load next batch of history
    pub async fn load_history_batch(
        &mut self,
        client: &TelegramClient,
        batch_size: i32,
    ) -> Result<Vec<Message>> {
        if self.history_complete {
            return Ok(vec![]);
        }

        let messages = client.get_chat_history(
            self.chat_id,
            from_message_id: self.oldest_message_id.unwrap_or(0),
            direction: Direction::Backward,
            limit: batch_size,
        ).await?;

        if messages.is_empty() {
            // No more history - we've reached the beginning
            self.history_complete = true;
        } else if let Some(oldest) = messages.first() {
            // Update cursor to oldest fetched message
            self.oldest_message_id = Some(oldest.id);
            self.messages_synced += messages.len() as u64;
        }

        self.persist().await?;
        Ok(messages)
    }
}
```

### Combined Cursor Manager

```rust
pub struct ChatSyncManager {
    chat_id: i64,
    forward: ForwardCursor,
    backward: BackwardCursor,
    sync_priority: SyncPriority,
    sync_enabled: bool,
}

impl ChatSyncManager {
    /// Initialize sync state for a chat
    pub async fn initialize(chat: &Chat, db: &Database) -> Result<Self> {
        let (priority, enabled) = Self::determine_sync_policy(chat);

        let state = db.get_or_create_sync_state(chat.id, priority, enabled).await?;

        Ok(Self {
            chat_id: chat.id,
            forward: ForwardCursor::from_state(&state),
            backward: BackwardCursor::from_state(&state),
            sync_priority: priority,
            sync_enabled: enabled,
        })
    }

    fn determine_sync_policy(chat: &Chat) -> (SyncPriority, bool) {
        match chat.chat_type {
            ChatType::Private => (SyncPriority::P1, true),  // DMs - full sync
            ChatType::Group | ChatType::Supergroup => {
                match chat.member_count {
                    Some(n) if n < 20 => (SyncPriority::P1, true),   // Small group
                    Some(n) if n <= 100 => (SyncPriority::P2, true), // Medium group
                    _ => (SyncPriority::P3, false),                   // Large group - disabled
                }
            }
            ChatType::Channel => (SyncPriority::P3, false), // Channels - disabled
        }
    }
}
```

## Priority Queue for Sync Jobs

### Job Queue Implementation

```rust
use std::collections::BinaryHeap;
use std::cmp::Ordering;

#[derive(Debug, Clone)]
pub struct SyncJob {
    pub id: u64,
    pub chat_id: i64,
    pub job_type: SyncJobType,
    pub priority: SyncPriority,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SyncJobType {
    ForwardCatchup,    // Catch up on missed real-time messages
    InitialLoad(u32),  // Load N most recent messages
    BackwardHistory,   // Continue loading history
    FullSync,          // Complete history sync
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum SyncPriority {
    Realtime = 0,  // P0 - Immediate
    High = 1,      // P1 - DMs and small groups
    Medium = 2,    // P2 - Medium groups
    Low = 3,       // P3 - Large groups (only explicit)
    Background = 4, // P4 - Background history
}

impl Ord for SyncJob {
    fn cmp(&self, other: &Self) -> Ordering {
        // Lower priority number = higher precedence
        // For same priority, older jobs first (FIFO within priority)
        match self.priority.cmp(&other.priority) {
            Ordering::Equal => other.created_at.cmp(&self.created_at),
            ord => ord.reverse(), // Reverse because BinaryHeap is max-heap
        }
    }
}

pub struct SyncJobQueue {
    heap: BinaryHeap<SyncJob>,
    running: HashMap<u64, SyncJob>,
    max_concurrent: usize,
}

impl SyncJobQueue {
    pub fn new(max_concurrent: usize) -> Self {
        Self {
            heap: BinaryHeap::new(),
            running: HashMap::new(),
            max_concurrent,
        }
    }

    pub fn enqueue(&mut self, job: SyncJob) {
        self.heap.push(job);
    }

    pub fn next_job(&mut self) -> Option<SyncJob> {
        if self.running.len() >= self.max_concurrent {
            return None;
        }

        if let Some(job) = self.heap.pop() {
            self.running.insert(job.id, job.clone());
            Some(job)
        } else {
            None
        }
    }

    pub fn complete_job(&mut self, job_id: u64) {
        self.running.remove(&job_id);
    }
}
```

### Job Scheduling Strategy

```rust
pub struct SyncScheduler {
    queue: SyncJobQueue,
    rate_limiter: RateLimiter,
    db: Database,
}

impl SyncScheduler {
    /// Called on daemon startup
    pub async fn initialize(&mut self) -> Result<()> {
        // 1. Queue forward catchup jobs for all enabled chats (high priority)
        let enabled_chats = self.db.get_enabled_sync_chats().await?;
        for chat in enabled_chats {
            self.queue.enqueue(SyncJob {
                id: self.next_job_id(),
                chat_id: chat.id,
                job_type: SyncJobType::ForwardCatchup,
                priority: SyncPriority::Realtime,
                created_at: Utc::now(),
            });
        }

        // 2. Queue initial load for medium groups (10 messages)
        let medium_groups = self.db.get_chats_by_priority(SyncPriority::Medium).await?;
        for chat in medium_groups {
            if !chat.has_initial_load {
                self.queue.enqueue(SyncJob {
                    id: self.next_job_id(),
                    chat_id: chat.id,
                    job_type: SyncJobType::InitialLoad(10),
                    priority: SyncPriority::Medium,
                    created_at: Utc::now(),
                });
            }
        }

        // 3. Queue background history jobs for incomplete syncs
        let incomplete_chats = self.db.get_incomplete_history_chats().await?;
        for chat in incomplete_chats {
            self.queue.enqueue(SyncJob {
                id: self.next_job_id(),
                chat_id: chat.id,
                job_type: SyncJobType::BackwardHistory,
                priority: SyncPriority::Background,
                created_at: Utc::now(),
            });
        }

        Ok(())
    }

    /// Main sync loop
    pub async fn run(&mut self) -> Result<()> {
        loop {
            // Check rate limits before taking next job
            if !self.rate_limiter.can_proceed().await {
                tokio::time::sleep(self.rate_limiter.wait_duration()).await;
                continue;
            }

            if let Some(job) = self.queue.next_job() {
                self.execute_job(job).await?;
            } else {
                // No jobs - wait for new ones or schedule more history loads
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
        }
    }
}
```

## Rate Limiting Integration

### Rate Limiter

```rust
use governor::{Quota, RateLimiter as Governor, clock::DefaultClock};
use std::num::NonZeroU32;

pub struct TelegramRateLimiter {
    // Telegram limits: ~30 requests/second, but be conservative
    global_limiter: Governor<NotKeyed, InMemoryState, DefaultClock>,
    // Per-chat limits to avoid flooding single chats
    chat_limiters: HashMap<i64, Governor<NotKeyed, InMemoryState, DefaultClock>>,
    // Flood wait tracking
    flood_wait_until: Option<Instant>,
}

impl TelegramRateLimiter {
    pub fn new() -> Self {
        Self {
            global_limiter: Governor::direct(
                Quota::per_second(NonZeroU32::new(20).unwrap())
            ),
            chat_limiters: HashMap::new(),
            flood_wait_until: None,
        }
    }

    pub async fn acquire(&mut self, chat_id: i64) -> Result<()> {
        // Check flood wait
        if let Some(until) = self.flood_wait_until {
            if Instant::now() < until {
                let wait = until - Instant::now();
                tokio::time::sleep(wait).await;
            }
            self.flood_wait_until = None;
        }

        // Global rate limit
        self.global_limiter.until_ready().await;

        // Per-chat rate limit (max 3 req/sec per chat)
        let chat_limiter = self.chat_limiters.entry(chat_id).or_insert_with(|| {
            Governor::direct(Quota::per_second(NonZeroU32::new(3).unwrap()))
        });
        chat_limiter.until_ready().await;

        Ok(())
    }

    pub fn handle_flood_wait(&mut self, seconds: u64) {
        self.flood_wait_until = Some(Instant::now() + Duration::from_secs(seconds));
        log::warn!("Flood wait triggered: {} seconds", seconds);
    }
}
```

### Error Handling with Backoff

```rust
pub async fn execute_with_retry<F, T>(
    rate_limiter: &mut TelegramRateLimiter,
    chat_id: i64,
    max_retries: u32,
    operation: F,
) -> Result<T>
where
    F: Fn() -> BoxFuture<'static, Result<T, TelegramError>>,
{
    let mut retries = 0;
    let mut backoff = Duration::from_millis(100);

    loop {
        rate_limiter.acquire(chat_id).await?;

        match operation().await {
            Ok(result) => return Ok(result),
            Err(TelegramError::FloodWait(seconds)) => {
                rate_limiter.handle_flood_wait(seconds);
                // Don't count flood wait as retry
            }
            Err(TelegramError::Timeout) | Err(TelegramError::NetworkError(_)) => {
                retries += 1;
                if retries >= max_retries {
                    return Err(anyhow!("Max retries exceeded"));
                }
                tokio::time::sleep(backoff).await;
                backoff = std::cmp::min(backoff * 2, Duration::from_secs(30));
            }
            Err(e) => return Err(e.into()),
        }
    }
}
```

## Resumability After Daemon Restart

### Daemon Startup Sequence

```rust
pub struct SyncDaemon {
    client: TelegramClient,
    db: Database,
    scheduler: SyncScheduler,
    chat_managers: HashMap<i64, ChatSyncManager>,
}

impl SyncDaemon {
    pub async fn start(&mut self) -> Result<()> {
        log::info!("Starting sync daemon...");

        // Phase 1: Sync contacts (always first)
        self.sync_contacts().await?;

        // Phase 2: Load chat list and determine sync policies
        self.initialize_chat_managers().await?;

        // Phase 3: Forward catchup - process missed messages since last run
        // This is P0 priority and happens before anything else
        self.forward_catchup_all().await?;

        // Phase 4: Subscribe to real-time updates
        let update_receiver = self.client.subscribe_updates().await?;

        // Phase 5: Start background sync scheduler
        let scheduler_handle = tokio::spawn(async move {
            self.scheduler.run().await
        });

        // Phase 6: Process real-time updates (main loop)
        self.process_realtime_updates(update_receiver).await?;

        Ok(())
    }

    async fn forward_catchup_all(&mut self) -> Result<()> {
        log::info!("Starting forward catchup for missed messages...");

        let enabled_chats: Vec<_> = self.chat_managers.values()
            .filter(|m| m.sync_enabled)
            .collect();

        let mut total_caught_up = 0;

        for manager in enabled_chats {
            let missed = manager.forward.catch_up(&self.client).await?;
            if !missed.is_empty() {
                log::info!(
                    "Chat {}: caught up {} missed messages",
                    manager.chat_id,
                    missed.len()
                );
                self.db.insert_messages(&missed).await?;
                total_caught_up += missed.len();
            }
        }

        log::info!("Forward catchup complete: {} messages recovered", total_caught_up);
        Ok(())
    }
}
```

### State Persistence

```rust
impl ChatSyncManager {
    /// Persist current sync state to database
    pub async fn persist(&self, db: &Database) -> Result<()> {
        db.execute(
            "UPDATE chat_sync_state SET
                forward_cursor = ?,
                backward_cursor = ?,
                history_complete = ?,
                synced_messages = ?,
                last_forward_sync = ?,
                last_backward_sync = ?,
                updated_at = CURRENT_TIMESTAMP
             WHERE chat_id = ?",
            params![
                self.forward.last_message_id,
                self.backward.oldest_message_id,
                self.backward.history_complete,
                self.backward.messages_synced,
                self.forward.last_sync_time,
                self.backward.last_sync_time,
                self.chat_id,
            ],
        ).await?;
        Ok(())
    }

    /// Restore state from database
    pub async fn restore(chat_id: i64, db: &Database) -> Result<Option<Self>> {
        let state = db.query_one(
            "SELECT * FROM chat_sync_state WHERE chat_id = ?",
            params![chat_id],
        ).await?;

        if let Some(row) = state {
            Ok(Some(Self {
                chat_id,
                forward: ForwardCursor {
                    chat_id,
                    last_message_id: row.get("forward_cursor"),
                    last_sync_time: row.get("last_forward_sync"),
                },
                backward: BackwardCursor {
                    chat_id,
                    oldest_message_id: row.get("backward_cursor"),
                    history_complete: row.get("history_complete"),
                    messages_synced: row.get("synced_messages"),
                },
                sync_priority: SyncPriority::from(row.get::<i32>("sync_priority")),
                sync_enabled: row.get("sync_enabled"),
            }))
        } else {
            Ok(None)
        }
    }
}
```

## Contact List Sync

### Contact Storage and Updates

```rust
pub struct ContactManager {
    db: Database,
    last_sync: Option<DateTime<Utc>>,
}

impl ContactManager {
    /// Full contact sync - called on daemon startup
    pub async fn sync_all(&mut self, client: &TelegramClient) -> Result<()> {
        log::info!("Syncing contact list...");

        let contacts = client.get_contacts().await?;

        // Use transaction for atomic update
        let tx = self.db.begin_transaction().await?;

        // Clear existing and insert fresh
        tx.execute("DELETE FROM contacts", []).await?;

        for contact in &contacts {
            tx.execute(
                "INSERT INTO contacts (user_id, username, first_name, last_name, phone, is_mutual, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)",
                params![
                    contact.user_id,
                    contact.username,
                    contact.first_name,
                    contact.last_name,
                    contact.phone,
                    contact.is_mutual,
                ],
            ).await?;
        }

        tx.commit().await?;
        self.last_sync = Some(Utc::now());

        log::info!("Contact sync complete: {} contacts", contacts.len());
        Ok(())
    }

    /// Handle contact update from real-time stream
    pub async fn on_contact_update(&mut self, update: ContactUpdate) -> Result<()> {
        match update {
            ContactUpdate::Added(contact) | ContactUpdate::Changed(contact) => {
                self.db.execute(
                    "INSERT OR REPLACE INTO contacts
                     (user_id, username, first_name, last_name, phone, is_mutual, updated_at)
                     VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)",
                    params![
                        contact.user_id,
                        contact.username,
                        contact.first_name,
                        contact.last_name,
                        contact.phone,
                        contact.is_mutual,
                    ],
                ).await?;
            }
            ContactUpdate::Removed(user_id) => {
                self.db.execute(
                    "DELETE FROM contacts WHERE user_id = ?",
                    params![user_id],
                ).await?;
            }
        }
        Ok(())
    }
}
```

## Progress Tracking for `tg status`

### Status Data Structures

```rust
#[derive(Debug, Serialize)]
pub struct SyncStatus {
    pub daemon_running: bool,
    pub daemon_uptime: Option<Duration>,
    pub last_telegram_ping: Option<DateTime<Utc>>,

    pub contacts: ContactSyncStatus,
    pub chats: ChatSyncSummary,
    pub active_jobs: Vec<ActiveJobInfo>,
    pub rate_limit_status: RateLimitStatus,
}

#[derive(Debug, Serialize)]
pub struct ContactSyncStatus {
    pub total_contacts: u32,
    pub last_full_sync: Option<DateTime<Utc>>,
}

#[derive(Debug, Serialize)]
pub struct ChatSyncSummary {
    pub total_chats: u32,
    pub sync_enabled: u32,
    pub fully_synced: u32,
    pub partially_synced: u32,
    pub not_synced: u32,

    pub by_priority: HashMap<String, PrioritySyncStatus>,
}

#[derive(Debug, Serialize)]
pub struct PrioritySyncStatus {
    pub total: u32,
    pub complete: u32,
    pub in_progress: u32,
    pub total_messages: u64,
    pub synced_messages: u64,
}

#[derive(Debug, Serialize)]
pub struct ActiveJobInfo {
    pub chat_id: i64,
    pub chat_name: String,
    pub job_type: String,
    pub progress_percent: Option<f32>,
    pub messages_fetched: u64,
    pub started_at: DateTime<Utc>,
}
```

### Status Query Implementation

```rust
impl SyncDaemon {
    pub async fn get_status(&self) -> Result<SyncStatus> {
        let chats = self.db.query_all(
            "SELECT
                sync_priority,
                sync_enabled,
                history_complete,
                total_messages,
                synced_messages
             FROM chat_sync_state",
            [],
        ).await?;

        let mut by_priority: HashMap<String, PrioritySyncStatus> = HashMap::new();
        let mut fully_synced = 0u32;
        let mut partially_synced = 0u32;
        let mut not_synced = 0u32;

        for chat in &chats {
            let priority_name = match chat.sync_priority {
                1 => "high",
                2 => "medium",
                3 => "low",
                _ => "background",
            };

            let entry = by_priority.entry(priority_name.to_string())
                .or_insert(PrioritySyncStatus::default());

            entry.total += 1;
            entry.total_messages += chat.total_messages.unwrap_or(0) as u64;
            entry.synced_messages += chat.synced_messages as u64;

            if chat.history_complete {
                entry.complete += 1;
                fully_synced += 1;
            } else if chat.synced_messages > 0 {
                entry.in_progress += 1;
                partially_synced += 1;
            } else {
                not_synced += 1;
            }
        }

        let active_jobs = self.scheduler.get_running_jobs().await?;

        Ok(SyncStatus {
            daemon_running: true,
            daemon_uptime: Some(self.start_time.elapsed()),
            last_telegram_ping: self.last_ping,
            contacts: ContactSyncStatus {
                total_contacts: self.db.count("contacts").await?,
                last_full_sync: self.contact_manager.last_sync,
            },
            chats: ChatSyncSummary {
                total_chats: chats.len() as u32,
                sync_enabled: chats.iter().filter(|c| c.sync_enabled).count() as u32,
                fully_synced,
                partially_synced,
                not_synced,
                by_priority,
            },
            active_jobs: active_jobs.into_iter().map(|j| ActiveJobInfo {
                chat_id: j.chat_id,
                chat_name: self.get_chat_name(j.chat_id),
                job_type: format!("{:?}", j.job_type),
                progress_percent: j.progress_percent(),
                messages_fetched: j.messages_fetched,
                started_at: j.started_at,
            }).collect(),
            rate_limit_status: self.rate_limiter.status(),
        })
    }
}
```

### CLI Status Display

```
$ tg status

Daemon Status
  Running:     Yes (uptime: 2h 34m)
  Last ping:   2 seconds ago

Contact Sync
  Contacts:    247
  Last sync:   2024-01-15 10:30:00 UTC

Chat Sync Summary
  Total chats:     156
  Sync enabled:    89
  Fully synced:    67
  In progress:     15
  Not synced:      74 (large groups/channels)

Sync by Priority
  Priority   | Total | Complete | Progress   | Messages
  -----------|-------|----------|------------|----------
  High (P1)  | 45    | 42       | 93%        | 12,456 / 13,200
  Medium (P2)| 44    | 25       | 57%        | 3,890 / 8,500
  Low (P3)   | 0     | 0        | -          | (disabled)

Active Jobs
  Chat                  | Type           | Progress | Started
  ----------------------|----------------|----------|--------
  Family Group          | BackwardHistory| 45%      | 5m ago
  Work Channel          | ForwardCatchup | -        | 2s ago

Rate Limiting
  Requests/sec:  12/20
  Flood wait:    None
```

## Configuration Options

```toml
# ~/.config/tg/sync.toml

[sync]
# Enable/disable automatic sync
enabled = true

# Maximum concurrent sync jobs
max_concurrent_jobs = 3

# Batch size for history loading
history_batch_size = 100

# Interval between history batches (ms)
history_batch_interval = 500

[sync.priorities]
# Member count thresholds
small_group_max = 20
medium_group_max = 100

# Auto-sync settings
auto_sync_dms = true
auto_sync_small_groups = true
auto_sync_medium_groups = true
auto_sync_large_groups = false
auto_sync_channels = false

[sync.rate_limits]
# Global rate limit (requests/second)
global_rps = 20

# Per-chat rate limit (requests/second)
per_chat_rps = 3

# Backoff on flood wait
flood_wait_multiplier = 1.5

[sync.contacts]
# Full contact sync interval (hours)
full_sync_interval = 24
```

## Implementation Phases

### Phase 1: Core Infrastructure
- [x] Database schema for sync state
- [x] Cursor data structures and persistence
- [x] Basic forward cursor logic

### Phase 2: Real-time Sync
- [x] Forward catchup on startup
- [x] Real-time update processing
- [ ] Contact list sync

### Phase 3: History Sync
- [x] Backward cursor implementation
- [x] Priority queue for sync jobs
- [x] Rate limiting integration

### Phase 4: Monitoring
- [x] Progress tracking
- [x] `tg status` command
- [x] Error reporting and recovery

### Phase 5: Polish
- [ ] Configuration options
- [ ] Explicit sync requests (`tg sync <chat>`)
- [ ] Performance optimization

## Error Handling

### Recoverable Errors
- Network timeouts: Retry with exponential backoff
- Rate limits (429): Respect Retry-After header
- Temporary server errors (5xx): Retry with backoff

### Non-Recoverable Errors
- Chat not accessible (403): Mark chat as inaccessible, skip
- Chat deleted: Remove from sync state
- Invalid cursor: Reset cursor, start fresh

### State Consistency
- All cursor updates wrapped in transactions
- Sync state persisted after each batch
- Graceful shutdown saves all pending state
