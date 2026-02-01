# Caching Strategy

> **Status:** Implemented. This document describes the caching system for telegram-cli, using a Stale-While-Revalidate pattern for optimal performance and user experience.

## Design Philosophy

The caching system prioritizes **responsiveness** over absolute freshness. Users get instant results from cache while background processes keep data fresh. This is critical for CLI tools where latency directly impacts usability.

### Core Principles

1. **Return cached data immediately** - Never block on network when cache exists
2. **Background refresh for stale data** - Keep cache fresh without user waiting
3. **Explicit freshness when needed** - `--fresh` flag for guaranteed current data
4. **Configurable staleness thresholds** - Different TTLs for different data types
5. **Lazy initialization** - Cache database initialized on first use for faster startup

## Staleness Rules

### Data Categories

| Category | Staleness TTL | Rationale |
|----------|--------------|-----------|
| **Messages** | ETERNAL | Never considered stale; fetched in batches via cursors. Once synced, a message's content doesn't change (edits tracked separately). |
| **Users/Contacts** | 1 week (configurable) | Usernames, display names, profile photos change infrequently. |
| **Groups** | 1 week (configurable) | Group titles, descriptions, member counts change occasionally. |
| **Channels** | 1 week (configurable) | Similar to groups; metadata is relatively stable. |
| **Channel Full Info** | 1 week (configurable) | Bio/about text, participant count, linked chat info. |

### Configuration

```json
// ~/.telegram-cli/config.json
{
  "api_id": "...",
  "api_hash": "...",
  "cache": {
    "staleness": {
      "peers": "7d",          // Users, groups, channels
      "fullInfo": "7d",       // Extended peer info (about, bio)
      "dialogs": "1h"         // Dialog list ordering
    },
    "backgroundRefresh": true,  // Enable/disable background refresh
    "maxCacheAge": "30d"        // Hard limit before cache eviction
  }
}
```

### Duration Format

Staleness values support human-readable durations:
- `30s` - 30 seconds
- `5m` - 5 minutes
- `1h` - 1 hour
- `7d` - 7 days (default for peers)
- `4w` - 4 weeks

```typescript
// From src/db/types.ts
export function parseDuration(duration: DurationString): number {
  const match = duration.match(/^(\d+)(s|m|h|d|w)$/)
  const value = match?.[1]
  const unit = match?.[2] as DurationUnit | undefined

  if (!value || !unit) {
    throw new Error(`Invalid duration: ${duration}`)
  }
  const multipliers: Record<DurationUnit, number> = {
    s: SECOND,
    m: MINUTE,
    h: HOUR,
    d: DAY,
    w: WEEK,
  }

  return Number.parseInt(value, 10) * multipliers[unit]
}
```

## CLI Behavior

### Standard Flow (Cached)

```bash
tg contacts list          # Returns cached (even if stale), indicates staleness
tg chats list             # Returns cached dialogs
tg contacts get @someone  # Returns cached user
```

1. Check cache table for requested data
2. If found: return immediately with `source: "cache"` in response
3. If stale: include `stale: true` in response and suggest `--fresh` flag
4. User sees result instantly

**Response includes cache metadata:**
```json
{
  "items": [...],
  "source": "cache",
  "stale": true
}
```

### Fresh Flow (Blocking)

```bash
tg contacts list --fresh      # Blocks until fresh data retrieved
tg contacts get @someone --fresh
tg chats list --fresh
```

1. Fetch from Telegram API (blocking)
2. Update cache with new data and `fetched_at` timestamp
3. Return fresh result with `source: "api"` and `stale: false`

### Cache Miss Flow

```bash
tg contacts get @someone    # First time, no cache exists
```

1. Check cache table - not found
2. Fetch from Telegram API (blocking, unavoidable)
3. Store in cache with `fetched_at` timestamp
4. Return result with `source: "api"`

## Database Schema

The cache uses a separate SQLite database (`cache.db`) from the main accounts database, initialized lazily on first use via `getCacheDb()`.

### Users Cache Table (Implemented)

```sql
-- From src/db/schema.ts
CREATE TABLE IF NOT EXISTS users_cache (
  user_id TEXT PRIMARY KEY,
  username TEXT,
  first_name TEXT,
  last_name TEXT,
  display_name TEXT,            -- Computed: "first_name last_name"
  phone TEXT,
  access_hash TEXT,             -- Required for API calls
  is_contact INTEGER DEFAULT 0,
  is_bot INTEGER DEFAULT 0,
  is_premium INTEGER DEFAULT 0,
  fetched_at INTEGER NOT NULL,  -- Unix timestamp (ms)
  raw_json TEXT NOT NULL,       -- Original TL object for future-proofing
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000)
);

CREATE INDEX idx_users_cache_username ON users_cache(username) WHERE username IS NOT NULL;
CREATE INDEX idx_users_cache_phone ON users_cache(phone) WHERE phone IS NOT NULL;
CREATE INDEX idx_users_cache_fetched_at ON users_cache(fetched_at);
```

### Chats Cache Table (Implemented)

```sql
-- From src/db/schema.ts
CREATE TABLE IF NOT EXISTS chats_cache (
  chat_id TEXT PRIMARY KEY,
  type TEXT NOT NULL,           -- 'private', 'group', 'supergroup', 'channel'
  title TEXT,
  username TEXT,
  member_count INTEGER,
  access_hash TEXT,
  is_creator INTEGER DEFAULT 0,
  is_admin INTEGER DEFAULT 0,
  last_message_id INTEGER,
  last_message_at INTEGER,      -- Unix timestamp (ms)
  fetched_at INTEGER NOT NULL,
  raw_json TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000)
);

CREATE INDEX idx_chats_cache_username ON chats_cache(username) WHERE username IS NOT NULL;
CREATE INDEX idx_chats_cache_type ON chats_cache(type);
CREATE INDEX idx_chats_cache_fetched_at ON chats_cache(fetched_at);
CREATE INDEX idx_chats_cache_last_message_at ON chats_cache(last_message_at DESC);
```

### Sync State Table

```sql
CREATE TABLE IF NOT EXISTS sync_state (
  entity_type TEXT PRIMARY KEY,
  forward_cursor TEXT,
  backward_cursor TEXT,
  is_complete INTEGER DEFAULT 0,
  last_sync_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000)
);
```

### Rate Limits Table

```sql
CREATE TABLE IF NOT EXISTS rate_limits (
  method TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  call_count INTEGER DEFAULT 1,
  last_call_at INTEGER,
  flood_wait_until INTEGER,
  PRIMARY KEY (method, window_start)
);

CREATE INDEX idx_rate_limits_method ON rate_limits(method);
```

### API Activity Table

```sql
CREATE TABLE IF NOT EXISTS api_activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp INTEGER NOT NULL,
  method TEXT NOT NULL,
  success INTEGER NOT NULL,
  error_code TEXT,
  response_ms INTEGER,
  context TEXT
);

CREATE INDEX idx_api_activity_timestamp ON api_activity(timestamp DESC);
CREATE INDEX idx_api_activity_method ON api_activity(method);
```

## Cache Operations

### Default Cache Configuration

```typescript
// From src/db/types.ts
export function getDefaultCacheConfig(): CacheConfig {
  return {
    staleness: {
      peers: WEEK,     // 7 days for users/groups/channels
      dialogs: HOUR,   // 1 hour for dialog list
      fullInfo: WEEK,  // 7 days for extended info
    },
    backgroundRefresh: true,
    maxCacheAge: 30 * DAY,
  }
}
```

### Staleness Check

```typescript
// From src/db/types.ts
export function isCacheStale(fetchedAt: number | null, ttlMs: number): boolean {
  if (fetchedAt === null) return true
  return Date.now() - fetchedAt > ttlMs
}
```

### Cache Services

The caching system uses dedicated service classes:

**UsersCache** (`src/db/users-cache.ts`):
- `getById(userId)` - Get user by ID
- `getByUsername(username)` - Get user by @username
- `getByPhone(phone)` - Get user by phone number
- `upsert(user)` - Insert or update single user
- `upsertMany(users)` - Bulk insert/update users
- `search(query, limit)` - Search by name/username/phone
- `getStale(ttlMs)` - Get entries older than TTL
- `prune(maxAgeMs)` - Delete old entries

**ChatsCache** (`src/db/chats-cache.ts`):
- `getById(chatId)` - Get chat by ID
- `getByUsername(username)` - Get chat by @username
- `list(opts)` - List with filtering (type, pagination, ordering)
- `search(query, limit)` - Search by title/username
- `upsert(chat)` - Insert or update single chat
- `upsertMany(chats)` - Bulk insert/update chats
- `getStale(ttlMs)` - Get stale entries
- `prune(maxAgeMs)` - Delete old entries

### Cache Lookup Pattern (Implemented)

Example from contacts command:

```typescript
// From src/commands/contacts.ts
async run({ args }) {
  const cacheDb = getCacheDb()  // Lazy initialization
  const usersCache = createUsersCache(cacheDb)
  const cacheConfig = getDefaultCacheConfig()

  // Check cache first (unless --fresh)
  if (!args.fresh) {
    const cached = usersCache.getByUsername(identifier)

    if (cached) {
      const stale = isCacheStale(cached.fetched_at, cacheConfig.staleness.peers)

      success({
        id: Number(cached.user_id),
        firstName: cached.first_name ?? '',
        lastName: cached.last_name ?? null,
        username: cached.username ?? null,
        source: 'cache',
        stale,
      })
      return
    }
  }

  // Fetch from API if cache miss or --fresh
  const client = getClientForAccount(accountId)
  const resolved = await client.call({
    _: 'contacts.resolveUsername',
    username: identifier.replace('@', ''),
  })

  // Cache the result
  usersCache.upsert(apiUserToCacheInput(user))

  success({
    ...userData,
    source: 'api',
    stale: false,
  })
}
```

### Lazy Database Initialization

```typescript
// From src/db/index.ts
let cacheDb: Database | null = null

export function getCacheDb(): Database {
  if (!cacheDb) {
    cacheDb = new Database(CACHE_DB_PATH)
    initCacheSchema(cacheDb)
  }
  return cacheDb
}
```

This ensures the cache database is only created when actually needed, improving startup performance for commands that don't use caching.

## Background Refresh Mechanism

### Job Scheduler

```typescript
async function scheduleRefreshJob(
  peerId: string,
  peerType: 'user' | 'group' | 'channel',
  priority: number = 0
): Promise<void> {
  try {
    db.prepare(`
      INSERT INTO refresh_jobs (peer_id, peer_type, priority, scheduled_at)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(peer_id, status) DO UPDATE SET
        priority = MAX(priority, excluded.priority)
    `).run(peerId, peerType, priority);
  } catch (error) {
    // Duplicate job already exists, ignore
  }
}
```

### Job Worker

The daemon process runs a background worker that processes refresh jobs:

```typescript
class RefreshWorker {
  private running = false;
  private intervalId: Timer | null = null;

  constructor(
    private db: Database,
    private telegramClient: TelegramClient,
    private config: CacheConfig
  ) {}

  start(intervalMs: number = 5000): void {
    if (this.running) return;
    this.running = true;

    this.intervalId = setInterval(() => {
      this.processNextJob().catch(console.error);
    }, intervalMs);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.running = false;
  }

  async processNextJob(): Promise<void> {
    // Get next pending job (highest priority, oldest first)
    const job = this.db.prepare(`
      SELECT * FROM refresh_jobs
      WHERE status = 'pending'
      ORDER BY priority DESC, scheduled_at ASC
      LIMIT 1
    `).get();

    if (!job) return;

    // Mark as in_progress
    this.db.prepare(`
      UPDATE refresh_jobs
      SET status = 'in_progress', started_at = CURRENT_TIMESTAMP, attempts = attempts + 1
      WHERE id = ?
    `).run(job.id);

    try {
      // Fetch fresh data based on peer type
      switch (job.peer_type) {
        case 'user':
          await this.refreshUser(job.peer_id);
          break;
        case 'group':
          await this.refreshGroup(job.peer_id);
          break;
        case 'channel':
          await this.refreshChannel(job.peer_id);
          break;
      }

      // Mark as completed
      this.db.prepare(`
        UPDATE refresh_jobs
        SET status = 'completed', completed_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(job.id);

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      // Check if retryable
      if (job.attempts >= 3) {
        this.db.prepare(`
          UPDATE refresh_jobs
          SET status = 'failed', last_error = ?, completed_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(errorMessage, job.id);
      } else {
        // Reset to pending for retry
        this.db.prepare(`
          UPDATE refresh_jobs
          SET status = 'pending', last_error = ?
          WHERE id = ?
        `).run(errorMessage, job.id);
      }
    }
  }

  private async refreshUser(userId: string): Promise<void> {
    const user = await this.telegramClient.getUser(userId);
    if (user) {
      await updateUserCache(user);
    }
  }

  private async refreshGroup(groupId: string): Promise<void> {
    const group = await this.telegramClient.getChat(groupId);
    if (group) {
      await updateGroupCache(group);
    }
  }

  private async refreshChannel(channelId: string): Promise<void> {
    const channel = await this.telegramClient.getChat(channelId);
    if (channel) {
      await updateChannelCache(channel);
    }
  }
}
```

### Rate Limiting

The background worker respects Telegram's rate limits:

```typescript
class RateLimitedRefreshWorker extends RefreshWorker {
  private lastRequestTime = 0;
  private minRequestInterval = 200; // 200ms between requests

  async processNextJob(): Promise<void> {
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;

    if (timeSinceLastRequest < this.minRequestInterval) {
      await sleep(this.minRequestInterval - timeSinceLastRequest);
    }

    this.lastRequestTime = Date.now();
    await super.processNextJob();
  }
}
```

## Cache Invalidation Strategies

### Explicit Invalidation

```typescript
// Invalidate specific peer
function invalidateCache(peerId: string, peerType: string): void {
  const table = `${peerType}s_cache`;
  db.prepare(`DELETE FROM ${table} WHERE ${peerType}_id = ?`).run(peerId);
}

// Invalidate all stale entries
function pruneStaleCache(maxAge: string): number {
  const maxAgeMs = parseDuration(maxAge);
  const cutoff = new Date(Date.now() - maxAgeMs).toISOString();

  let total = 0;
  for (const table of ['users_cache', 'groups_cache', 'channels_cache']) {
    const result = db.prepare(`
      DELETE FROM ${table} WHERE fetched_at < ?
    `).run(cutoff);
    total += result.changes;
  }

  return total;
}
```

### Event-Driven Invalidation

When receiving real-time updates from Telegram:

```typescript
function handleUserUpdate(update: UserUpdate): void {
  // User changed their profile - invalidate and refresh
  invalidateCache(String(update.userId), 'user');
  scheduleRefreshJob(String(update.userId), 'user', 10); // High priority
}

function handleChatUpdate(update: ChatUpdate): void {
  // Group/channel updated - invalidate and refresh
  const peerType = update.isChannel ? 'channel' : 'group';
  invalidateCache(String(update.chatId), peerType);
  scheduleRefreshJob(String(update.chatId), peerType, 10);
}
```

### Automatic Cache Maintenance

Run periodically (e.g., daily) via daemon:

```typescript
async function performCacheMaintenance(): Promise<void> {
  const config = getConfig();

  // 1. Prune very old entries
  const pruned = pruneStaleCache(config.cache.maxCacheAge);
  console.log(`Pruned ${pruned} expired cache entries`);

  // 2. Clean up completed/failed jobs older than 24h
  db.prepare(`
    DELETE FROM refresh_jobs
    WHERE status IN ('completed', 'failed')
    AND completed_at < datetime('now', '-1 day')
  `).run();

  // 3. Reset stuck in_progress jobs (older than 1 hour)
  db.prepare(`
    UPDATE refresh_jobs
    SET status = 'pending', last_error = 'Job timed out'
    WHERE status = 'in_progress'
    AND started_at < datetime('now', '-1 hour')
  `).run();
}
```

## CLI Commands with Caching (Implemented)

### Contacts Commands

```bash
# List contacts (from cache if available)
tg contacts list
tg contacts list --limit 50 --offset 100

# Force fresh fetch
tg contacts list --fresh

# Search contacts (searches cache)
tg contacts search "Alice"

# Force fresh search via API
tg contacts search "Alice" --fresh

# Get specific contact
tg contacts get @username
tg contacts get 123456789

# Force fresh fetch
tg contacts get @username --fresh
```

**Output includes cache metadata:**
```json
{
  "id": 123456789,
  "firstName": "Alice",
  "lastName": "Smith",
  "username": "alice",
  "phone": "+1234567890",
  "source": "cache",
  "stale": false
}
```

### Chats Commands

```bash
# List all chats/dialogs
tg chats list
tg chats list --limit 20

# Filter by type
tg chats list --type private
tg chats list --type group
tg chats list --type supergroup
tg chats list --type channel

# Force fresh fetch
tg chats list --fresh

# Search chats by title/username
tg chats search "Work"

# Get specific chat
tg chats get @channelname
tg chats get @username  # private chat with user
```

### Send Command (Uses Cache for Peer Resolution)

```bash
# Send message (uses cached peer info for resolution)
tg send --to @username --message "Hello!"
tg send --to +1234567890 -m "Hello!"
tg send --to 123456789 -m "Hello!"

# Silent message (no notification)
tg send --to @username -m "Hello!" --silent

# Reply to message
tg send --to @username -m "Reply text" --reply-to 123
```

The send command leverages the UsersCache and ChatsCache to resolve peer identifiers without making API calls when possible.

## Flow Diagrams

### Standard Lookup Flow

```
CLI Request: tg user @someone
        │
        v
┌─────────────────┐
│ Check users_cache│
└────────┬────────┘
         │
    ┌────┴────┐
    │ Found?  │
    └────┬────┘
         │
    ┌────┴────┐
   Yes       No
    │         │
    v         v
┌─────────┐  ┌─────────────┐
│ Return  │  │ Fetch from  │
│ cached  │  │ Telegram API│
└────┬────┘  └──────┬──────┘
     │              │
     v              v
┌─────────┐  ┌─────────────┐
│ Stale?  │  │ Update cache│
└────┬────┘  │ Return data │
     │       └─────────────┘
┌────┴────┐
Yes       No
│         │
v         v
┌─────────────┐  ┌──────┐
│ Schedule    │  │ Done │
│ background  │  └──────┘
│ refresh job │
└─────────────┘
```

### Fresh Lookup Flow

```
CLI Request: tg user @someone --fresh
        │
        v
┌──────────────────┐
│ Fetch from       │
│ Telegram API     │
│ (blocking)       │
└────────┬─────────┘
         │
         v
┌──────────────────┐
│ Update cache     │
│ with fetched_at  │
└────────┬─────────┘
         │
         v
┌──────────────────┐
│ Return fresh data│
└──────────────────┘
```

### Background Refresh Flow

```
Daemon Process
      │
      v
┌──────────────────┐
│ RefreshWorker    │
│ checks every 5s  │
└────────┬─────────┘
         │
         v
┌──────────────────┐
│ Get pending job  │
│ (highest priority│
│  oldest first)   │
└────────┬─────────┘
         │
    ┌────┴────┐
    │ Found?  │
    └────┬────┘
         │
    ┌────┴────┐
   Yes       No
    │         │
    v         v
┌─────────┐  ┌──────┐
│ Mark    │  │ Sleep│
│ in_prog │  │ 5s   │
└────┬────┘  └──────┘
     │
     v
┌─────────────────┐
│ Fetch from API  │
│ Update cache    │
└────────┬────────┘
         │
    ┌────┴────┐
    │Success? │
    └────┬────┘
         │
    ┌────┴────┐
   Yes       No
    │         │
    v         v
┌─────────┐  ┌────────────┐
│ Mark    │  │ Retry or   │
│complete │  │ mark failed│
└─────────┘  └────────────┘
```

## Key Patterns (Implemented)

1. **Stale-While-Revalidate**: Return cached data immediately with staleness indicator
2. **Configurable TTLs**: Different staleness thresholds per data type (peers: 7d, dialogs: 1h)
3. **Explicit freshness**: `--fresh` flag for guaranteed current data
4. **Lazy initialization**: Cache database created on first use via `getCacheDb()`
5. **Cache source tracking**: All responses include `source: "cache" | "api"` and `stale: boolean`
6. **Raw JSON storage**: Original TL objects stored in `raw_json` for future-proofing
7. **Prepared statements**: All cache operations use bun:sqlite prepared statements for performance
8. **Transaction support**: Bulk operations use transactions via `upsertMany()`

## Implementation Files

| File | Description |
|------|-------------|
| `src/db/index.ts` | Database initialization, `getCacheDb()` |
| `src/db/schema.ts` | Cache schema creation, row classes |
| `src/db/types.ts` | Cache config, staleness utilities |
| `src/db/users-cache.ts` | UsersCache service class |
| `src/db/chats-cache.ts` | ChatsCache service class |
| `src/commands/contacts.ts` | Contacts commands with caching |
| `src/commands/chats.ts` | Chats commands with caching |
| `src/commands/send.ts` | Send command with cache-based peer resolution |
