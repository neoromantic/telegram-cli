# Caching Strategy

> **Note:** This document contains the caching plan for telegram-cli, implementing a Stale-While-Revalidate pattern for optimal performance and user experience.

## Design Philosophy

The caching system prioritizes **responsiveness** over absolute freshness. Users get instant results from cache while background processes keep data fresh. This is critical for CLI tools where latency directly impacts usability.

### Core Principles

1. **Return cached data immediately** - Never block on network when cache exists
2. **Background refresh for stale data** - Keep cache fresh without user waiting
3. **Explicit freshness when needed** - `--fresh` flag for guaranteed current data
4. **Configurable staleness thresholds** - Different TTLs for different data types

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
function parseDuration(duration: string): number {
  const match = duration.match(/^(\d+)(s|m|h|d|w)$/);
  if (!match) throw new Error(`Invalid duration: ${duration}`);

  const [, value, unit] = match;
  const multipliers: Record<string, number> = {
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
    w: 7 * 24 * 60 * 60 * 1000,
  };

  return parseInt(value, 10) * multipliers[unit];
}
```

## CLI Behavior

### Standard Flow (Cached)

```bash
tg user @someone          # Returns cached (even if stale), triggers background refresh
```

1. Check `users_cache` table for `@someone`
2. If found: return immediately
3. If stale (>1 week): trigger background refresh job
4. User sees result instantly

### Fresh Flow (Blocking)

```bash
tg user @someone --fresh      # Blocks until fresh data retrieved
tg user @someone --skip-cache # Alias for --fresh
```

1. Fetch from Telegram API (blocking)
2. Update cache with new data and `fetched_at` timestamp
3. Return fresh result

### Cache Miss Flow

```bash
tg user @someone    # First time, no cache exists
```

1. Check `users_cache` table - not found
2. Fetch from Telegram API (blocking, unavoidable)
3. Store in cache with `fetched_at` timestamp
4. Return result

## Database Schema

### Users Cache Table

```sql
CREATE TABLE IF NOT EXISTS users_cache (
  user_id TEXT PRIMARY KEY,
  peer_type TEXT,               -- 'user', 'bot'
  username TEXT,
  first_name TEXT,
  last_name TEXT,
  display_name TEXT,            -- Computed: "first_name last_name"
  phone TEXT,
  is_contact INTEGER,
  is_bot INTEGER,
  is_premium INTEGER,
  access_hash TEXT,             -- Required for API calls
  photo_id TEXT,                -- Small photo file reference
  fetched_at TEXT NOT NULL,     -- ISO-8601 timestamp
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX users_cache_username_idx ON users_cache (username);
CREATE INDEX users_cache_phone_idx ON users_cache (phone);
CREATE INDEX users_cache_fetched_idx ON users_cache (fetched_at);
```

### Groups Cache Table

```sql
CREATE TABLE IF NOT EXISTS groups_cache (
  group_id TEXT PRIMARY KEY,
  peer_type TEXT,               -- 'group', 'supergroup'
  title TEXT,
  username TEXT,
  is_forum INTEGER,
  member_count INTEGER,
  access_hash TEXT,
  photo_id TEXT,
  fetched_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX groups_cache_username_idx ON groups_cache (username);
CREATE INDEX groups_cache_fetched_idx ON groups_cache (fetched_at);
```

### Channels Cache Table

```sql
CREATE TABLE IF NOT EXISTS channels_cache (
  channel_id TEXT PRIMARY KEY,
  peer_type TEXT,               -- 'channel', 'broadcast'
  title TEXT,
  username TEXT,
  is_verified INTEGER,
  is_scam INTEGER,
  subscriber_count INTEGER,
  access_hash TEXT,
  photo_id TEXT,
  fetched_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX channels_cache_username_idx ON channels_cache (username);
CREATE INDEX channels_cache_fetched_idx ON channels_cache (fetched_at);
```

### Peer Full Info Cache Table

```sql
CREATE TABLE IF NOT EXISTS peer_full_info_cache (
  peer_id TEXT PRIMARY KEY,
  peer_type TEXT,               -- 'user', 'group', 'channel'
  about TEXT,                   -- Bio/description
  common_chats_count INTEGER,   -- For users
  linked_chat_id TEXT,          -- For channels
  pinned_message_id INTEGER,
  can_set_username INTEGER,
  extra_json TEXT,              -- Additional fields as JSON
  fetched_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX peer_full_info_fetched_idx ON peer_full_info_cache (fetched_at);
```

### Background Refresh Jobs Table

```sql
CREATE TABLE IF NOT EXISTS refresh_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  peer_id TEXT NOT NULL,
  peer_type TEXT NOT NULL,      -- 'user', 'group', 'channel'
  status TEXT NOT NULL DEFAULT 'pending',  -- pending, in_progress, completed, failed
  priority INTEGER DEFAULT 0,   -- Higher = more urgent
  attempts INTEGER DEFAULT 0,
  last_error TEXT,
  scheduled_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  started_at TEXT,
  completed_at TEXT,
  UNIQUE(peer_id, status)       -- Prevent duplicate pending jobs
);

CREATE INDEX refresh_jobs_status_idx ON refresh_jobs (status, priority DESC, scheduled_at);
```

## Cache Operations

### Staleness Check

```typescript
interface CacheConfig {
  staleness: {
    peers: string;     // e.g., "7d"
    fullInfo: string;  // e.g., "7d"
    dialogs: string;   // e.g., "1h"
  };
}

function isCacheStale(
  fetchedAt: string | null,
  ttl: string
): boolean {
  if (!fetchedAt) return true;

  const fetchedTs = new Date(fetchedAt).getTime();
  if (Number.isNaN(fetchedTs)) return true;

  const ttlMs = parseDuration(ttl);
  return Date.now() - fetchedTs > ttlMs;
}
```

### Cache Lookup with Background Refresh

```typescript
interface CacheLookupResult<T> {
  data: T | null;
  source: 'cache' | 'api';
  stale: boolean;
  refreshTriggered: boolean;
}

async function getCachedUser(
  userId: string,
  options: { fresh?: boolean } = {}
): Promise<CacheLookupResult<User>> {
  // Fresh flag: bypass cache entirely
  if (options.fresh) {
    const user = await fetchUserFromApi(userId);
    await updateUserCache(user);
    return {
      data: user,
      source: 'api',
      stale: false,
      refreshTriggered: false,
    };
  }

  // Check cache
  const cached = getUserFromCache(userId);

  if (!cached) {
    // Cache miss: must fetch from API
    const user = await fetchUserFromApi(userId);
    await updateUserCache(user);
    return {
      data: user,
      source: 'api',
      stale: false,
      refreshTriggered: false,
    };
  }

  // Cache hit: check staleness
  const config = getConfig();
  const stale = isCacheStale(cached.fetched_at, config.cache.staleness.peers);

  if (stale && config.cache.backgroundRefresh) {
    // Trigger background refresh (non-blocking)
    scheduleRefreshJob(userId, 'user');
  }

  return {
    data: cached,
    source: 'cache',
    stale,
    refreshTriggered: stale && config.cache.backgroundRefresh,
  };
}
```

### Update Cache

```typescript
async function updateUserCache(user: User): Promise<void> {
  const displayName = [user.firstName, user.lastName]
    .filter(Boolean)
    .join(' ') || null;

  db.prepare(`
    INSERT INTO users_cache (
      user_id, peer_type, username, first_name, last_name,
      display_name, phone, is_contact, is_bot, is_premium,
      access_hash, photo_id, fetched_at, updated_at
    ) VALUES (
      $user_id, $peer_type, $username, $first_name, $last_name,
      $display_name, $phone, $is_contact, $is_bot, $is_premium,
      $access_hash, $photo_id, $fetched_at, CURRENT_TIMESTAMP
    )
    ON CONFLICT(user_id) DO UPDATE SET
      peer_type = excluded.peer_type,
      username = excluded.username,
      first_name = excluded.first_name,
      last_name = excluded.last_name,
      display_name = excluded.display_name,
      phone = excluded.phone,
      is_contact = excluded.is_contact,
      is_bot = excluded.is_bot,
      is_premium = excluded.is_premium,
      access_hash = excluded.access_hash,
      photo_id = excluded.photo_id,
      fetched_at = excluded.fetched_at,
      updated_at = CURRENT_TIMESTAMP
  `).run({
    $user_id: String(user.id),
    $peer_type: user.isBot ? 'bot' : 'user',
    $username: user.username ?? null,
    $first_name: user.firstName ?? null,
    $last_name: user.lastName ?? null,
    $display_name: displayName,
    $phone: user.phone ?? null,
    $is_contact: user.isContact ? 1 : 0,
    $is_bot: user.isBot ? 1 : 0,
    $is_premium: user.isPremium ? 1 : 0,
    $access_hash: user.accessHash ? String(user.accessHash) : null,
    $photo_id: user.photo?.id ?? null,
    $fetched_at: new Date().toISOString(),
  });
}
```

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

## CLI Commands

### User Commands

```bash
# Get user info (from cache if available)
tg user @someone

# Force fresh fetch
tg user @someone --fresh
tg user @someone --skip-cache

# Show cache status
tg user @someone --cache-info
# Output:
# {
#   "user": { ... },
#   "cache": {
#     "source": "cache",
#     "fetched_at": "2024-01-15T10:30:00Z",
#     "stale": false,
#     "age": "2d 5h"
#   }
# }
```

### Cache Management Commands

```bash
# Show cache statistics
tg cache stats
# Output:
# Users cached: 1,234 (45 stale)
# Groups cached: 89 (12 stale)
# Channels cached: 567 (34 stale)
# Pending refresh jobs: 15

# Clear all cache
tg cache clear

# Clear specific cache type
tg cache clear --users
tg cache clear --groups
tg cache clear --channels

# Clear specific entry
tg cache clear @username

# Force refresh stale entries
tg cache refresh --stale

# Show pending refresh jobs
tg cache jobs
```

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

## Key Patterns

1. **Stale-While-Revalidate**: Return cached data immediately, refresh in background
2. **Configurable TTLs**: Different staleness thresholds per data type
3. **Explicit freshness**: `--fresh` flag for guaranteed current data
4. **Job queue for background work**: Persistent queue survives restarts
5. **Rate limiting**: Respect Telegram's API limits during background refresh
6. **Event-driven invalidation**: Real-time updates trigger cache refresh
7. **Automatic maintenance**: Periodic pruning of old cache entries
8. **Transparent cache info**: `--cache-info` flag shows cache status
