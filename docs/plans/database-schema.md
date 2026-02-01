# Database Schema Plan

## Overview

This document defines the database schema for telegram-cli's local data storage. The design follows these principles:

1. **Separate database per account** - Each Telegram account has its own isolated storage
2. **No mtcute modifications** - We create parallel tables alongside mtcute's session storage
3. **Future-proofing with raw_json** - All cached entities store their original JSON for schema evolution

## File Structure

```
~/.telegram-cli/
├── config.json              # Global CLI configuration
├── daemon.pid               # PID file for background daemon
└── accounts/
    ├── 1/
    │   ├── session.db       # mtcute session database (auth keys, DC info)
    │   ├── data.db          # Our cache/sync data (this schema)
    │   └── meta.json        # Account metadata (label, username, phone)
    └── 2/
        ├── session.db
        ├── data.db
        └── meta.json
```

### meta.json Structure

```json
{
  "label": "personal",
  "user_id": 123456789,
  "username": "johndoe",
  "phone": "+1234567890",
  "first_name": "John",
  "last_name": "Doe",
  "created_at": "2024-01-15T10:30:00Z",
  "last_used_at": "2024-01-20T15:45:00Z"
}
```

---

## data.db Schema

All tables use SQLite with WAL mode enabled for concurrent read/write access.

### Table: sync_state

Tracks synchronization progress for incremental fetching. Supports bidirectional sync (forward for new data, backward for historical data).

```sql
CREATE TABLE sync_state (
    entity_type     TEXT PRIMARY KEY,   -- 'contacts', 'dialogs', 'messages:{chat_id}'
    forward_cursor  TEXT,               -- Cursor/offset for fetching newer data
    backward_cursor TEXT,               -- Cursor/offset for fetching older data
    is_complete     INTEGER DEFAULT 0,  -- 1 if historical sync reached the beginning
    last_sync_at    INTEGER,            -- Unix timestamp of last successful sync
    created_at      INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    updated_at      INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

-- Index for finding stale sync states
CREATE INDEX idx_sync_state_last_sync ON sync_state(last_sync_at);
```

**Purpose**: Enables resumable, incremental synchronization. When syncing messages for a chat:
- `forward_cursor` stores the newest message ID we've seen (for fetching new messages)
- `backward_cursor` stores the oldest message ID (for fetching history)
- `is_complete` marks when we've reached the beginning of chat history

**Entity types**:
- `contacts` - Contact list sync state
- `dialogs` - Chat/dialog list sync state
- `messages:{chat_id}` - Per-chat message sync state

---

### Table: contacts_cache

Cached contact information from the user's Telegram contacts.

```sql
CREATE TABLE contacts_cache (
    user_id     INTEGER PRIMARY KEY,    -- Telegram user ID
    first_name  TEXT,                   -- User's first name
    last_name   TEXT,                   -- User's last name (nullable)
    username    TEXT,                   -- @username without @ (nullable)
    phone       TEXT,                   -- Phone number (nullable, contacts only)
    is_contact  INTEGER DEFAULT 1,     -- 1 if in user's contacts
    is_mutual   INTEGER DEFAULT 0,     -- 1 if mutual contact
    is_blocked  INTEGER DEFAULT 0,     -- 1 if user is blocked
    fetched_at  INTEGER NOT NULL,      -- Unix timestamp when data was fetched
    raw_json    TEXT NOT NULL,         -- Original TL object as JSON
    created_at  INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    updated_at  INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

-- Index for searching by username
CREATE INDEX idx_contacts_username ON contacts_cache(username) WHERE username IS NOT NULL;

-- Index for searching by phone
CREATE INDEX idx_contacts_phone ON contacts_cache(phone) WHERE phone IS NOT NULL;

-- Index for full-text search on names
CREATE INDEX idx_contacts_names ON contacts_cache(first_name, last_name);

-- Index for finding stale cache entries
CREATE INDEX idx_contacts_fetched ON contacts_cache(fetched_at);
```

**Purpose**: Local cache of contacts for offline access and fast lookups. The `raw_json` field preserves all fields from mtcute's User object for future features.

---

### Table: chats_cache

Cached information about all chats (private chats, groups, channels).

```sql
CREATE TABLE chats_cache (
    chat_id         INTEGER PRIMARY KEY,    -- Telegram chat/channel ID
    type            TEXT NOT NULL,          -- 'private', 'group', 'supergroup', 'channel'
    title           TEXT,                   -- Chat title (groups/channels) or user name (private)
    username        TEXT,                   -- @username for public chats (nullable)
    member_count    INTEGER,                -- Number of members (nullable, groups/channels)
    is_verified     INTEGER DEFAULT 0,      -- 1 if verified account
    is_restricted   INTEGER DEFAULT 0,      -- 1 if restricted
    is_creator      INTEGER DEFAULT 0,      -- 1 if user created this chat
    is_admin        INTEGER DEFAULT 0,      -- 1 if user is admin
    unread_count    INTEGER DEFAULT 0,      -- Unread message count
    last_message_id INTEGER,                -- ID of last message in chat
    last_message_at INTEGER,                -- Timestamp of last message
    sync_enabled    INTEGER DEFAULT 0,      -- 1 if auto-sync enabled for this chat
    sync_priority   INTEGER DEFAULT 0,      -- Higher = sync more frequently
    pinned_order    INTEGER,                -- Order in pinned chats (nullable if not pinned)
    fetched_at      INTEGER NOT NULL,       -- Unix timestamp when data was fetched
    raw_json        TEXT NOT NULL,          -- Original TL object as JSON
    created_at      INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    updated_at      INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

-- Index for listing chats by type
CREATE INDEX idx_chats_type ON chats_cache(type);

-- Index for searching by username
CREATE INDEX idx_chats_username ON chats_cache(username) WHERE username IS NOT NULL;

-- Index for ordering by last activity
CREATE INDEX idx_chats_last_message ON chats_cache(last_message_at DESC);

-- Index for finding sync-enabled chats
CREATE INDEX idx_chats_sync ON chats_cache(sync_enabled, sync_priority DESC) WHERE sync_enabled = 1;

-- Index for pinned chats
CREATE INDEX idx_chats_pinned ON chats_cache(pinned_order) WHERE pinned_order IS NOT NULL;

-- Index for finding stale cache entries
CREATE INDEX idx_chats_fetched ON chats_cache(fetched_at);

-- Full-text search on titles
CREATE INDEX idx_chats_title ON chats_cache(title);
```

**Purpose**: Local cache of all dialogs/chats. The `sync_enabled` and `sync_priority` fields allow users to configure which chats should be automatically synchronized for offline access.

---

### Table: messages_cache

Cached messages from synchronized chats.

```sql
CREATE TABLE messages_cache (
    chat_id         INTEGER NOT NULL,       -- Chat this message belongs to
    message_id      INTEGER NOT NULL,       -- Message ID within the chat
    from_id         INTEGER,                -- Sender user ID (nullable for channels)
    reply_to_id     INTEGER,                -- ID of message being replied to (nullable)
    forward_from_id INTEGER,                -- Original sender if forwarded (nullable)
    text            TEXT,                   -- Message text content (nullable for media-only)
    message_type    TEXT DEFAULT 'text',    -- 'text', 'photo', 'video', 'document', 'sticker', etc.
    has_media       INTEGER DEFAULT 0,      -- 1 if message contains media
    media_path      TEXT,                   -- Local path to downloaded media (nullable)
    is_outgoing     INTEGER DEFAULT 0,      -- 1 if sent by current user
    is_edited       INTEGER DEFAULT 0,      -- 1 if message was edited
    is_pinned       INTEGER DEFAULT 0,      -- 1 if message is pinned
    edit_date       INTEGER,                -- Unix timestamp of last edit (nullable)
    date            INTEGER NOT NULL,       -- Unix timestamp when message was sent
    fetched_at      INTEGER NOT NULL,       -- Unix timestamp when data was fetched
    raw_json        TEXT NOT NULL,          -- Original TL object as JSON
    created_at      INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    updated_at      INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    PRIMARY KEY (chat_id, message_id)
);

-- Index for listing messages in chronological order
CREATE INDEX idx_messages_date ON messages_cache(chat_id, date DESC);

-- Index for finding messages by sender
CREATE INDEX idx_messages_from ON messages_cache(from_id) WHERE from_id IS NOT NULL;

-- Index for full-text search on message content
CREATE INDEX idx_messages_text ON messages_cache(text) WHERE text IS NOT NULL;

-- Index for finding replies
CREATE INDEX idx_messages_reply ON messages_cache(chat_id, reply_to_id) WHERE reply_to_id IS NOT NULL;

-- Index for finding media messages
CREATE INDEX idx_messages_media ON messages_cache(chat_id, message_type) WHERE has_media = 1;

-- Index for finding pinned messages
CREATE INDEX idx_messages_pinned ON messages_cache(chat_id) WHERE is_pinned = 1;

-- Index for finding stale cache entries
CREATE INDEX idx_messages_fetched ON messages_cache(fetched_at);
```

**Purpose**: Local cache of messages for offline access, search, and history. Only messages from `sync_enabled` chats are typically stored here. The `media_path` field supports optional local media caching.

---

### Table: rate_limits

Tracks API call rate limiting to prevent flood errors.

```sql
CREATE TABLE rate_limits (
    method              TEXT PRIMARY KEY,   -- API method name (e.g., 'messages.getHistory')
    last_call_at        INTEGER NOT NULL,   -- Unix timestamp of last successful call
    calls_count         INTEGER DEFAULT 1,  -- Number of calls in current window
    window_start        INTEGER NOT NULL,   -- Start of rate limit window
    flood_wait_until    INTEGER,            -- Unix timestamp when flood wait expires (nullable)
    avg_response_ms     INTEGER,            -- Average response time in milliseconds
    created_at          INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    updated_at          INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

-- Index for finding active flood waits
CREATE INDEX idx_rate_limits_flood ON rate_limits(flood_wait_until)
    WHERE flood_wait_until IS NOT NULL;

-- Index for finding methods that need throttling
CREATE INDEX idx_rate_limits_window ON rate_limits(window_start, calls_count);
```

**Purpose**: Prevents hitting Telegram's rate limits by tracking API usage. When a `FLOOD_WAIT` error is received, `flood_wait_until` is set to the earliest time we can retry. The daemon uses this to intelligently schedule API calls.

**Common rate-limited methods**:
- `messages.getHistory` - Fetching message history
- `messages.getDialogs` - Fetching chat list
- `contacts.getContacts` - Fetching contact list
- `messages.sendMessage` - Sending messages

---

### Table: api_activity

Audit log of all API activity for debugging and analytics.

```sql
CREATE TABLE api_activity (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp       INTEGER NOT NULL,       -- Unix timestamp of the call
    method          TEXT NOT NULL,          -- API method name
    chat_id         INTEGER,                -- Related chat ID if applicable (nullable)
    success         INTEGER NOT NULL,       -- 1 if successful, 0 if failed
    error_code      INTEGER,                -- Error code if failed (nullable)
    error_message   TEXT,                   -- Error message if failed (nullable)
    response_ms     INTEGER,                -- Response time in milliseconds
    request_size    INTEGER,                -- Request payload size in bytes
    response_size   INTEGER                 -- Response payload size in bytes
);

-- Index for querying by timestamp (for cleanup and analytics)
CREATE INDEX idx_api_activity_timestamp ON api_activity(timestamp DESC);

-- Index for finding errors
CREATE INDEX idx_api_activity_errors ON api_activity(error_code) WHERE success = 0;

-- Index for per-method analytics
CREATE INDEX idx_api_activity_method ON api_activity(method, timestamp DESC);

-- Index for per-chat activity
CREATE INDEX idx_api_activity_chat ON api_activity(chat_id, timestamp DESC) WHERE chat_id IS NOT NULL;
```

**Purpose**: Debugging and monitoring tool. Helps identify:
- Which API calls are failing and why
- Performance bottlenecks
- Usage patterns for optimization

**Retention**: Old records should be periodically purged (e.g., keep last 7 days).

---

## Database Initialization

```sql
-- Enable WAL mode for better concurrent access
PRAGMA journal_mode = WAL;

-- Enable foreign keys (not used yet, but good practice)
PRAGMA foreign_keys = ON;

-- Optimize for our read-heavy workload
PRAGMA synchronous = NORMAL;
PRAGMA cache_size = -64000;  -- 64MB cache
PRAGMA temp_store = MEMORY;
```

---

## Migration Strategy

Each database version is tracked in a `schema_version` table:

```sql
CREATE TABLE schema_version (
    version     INTEGER PRIMARY KEY,
    applied_at  INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    description TEXT
);

-- Initial version
INSERT INTO schema_version (version, description) VALUES (1, 'Initial schema');
```

Migrations are applied sequentially on startup if `schema_version` is behind the expected version.

---

## Usage Patterns

### Incremental Message Sync

```
1. Check sync_state for 'messages:{chat_id}'
2. If forward_cursor exists, fetch messages newer than cursor
3. Update forward_cursor with newest message ID
4. Insert/update messages in messages_cache
5. Update sync_state.last_sync_at
```

### Historical Backfill

```
1. Check sync_state for 'messages:{chat_id}'
2. If not is_complete, fetch messages older than backward_cursor
3. If no more messages, set is_complete = 1
4. Otherwise, update backward_cursor with oldest message ID
5. Insert messages in messages_cache
```

### Rate Limit Handling

```
1. Before API call, check rate_limits for the method
2. If flood_wait_until > now, wait or skip
3. If calls_count > threshold in window, throttle
4. After call, update last_call_at and calls_count
5. On FLOOD_WAIT error, set flood_wait_until
```

---

## Capacity Planning

Estimated storage per account:

| Data Type | Records | Est. Size |
|-----------|---------|-----------|
| contacts_cache | 500 | ~500 KB |
| chats_cache | 200 | ~200 KB |
| messages_cache (per chat) | 10,000 | ~10 MB |
| messages_cache (50 synced chats) | 500,000 | ~500 MB |
| api_activity (7 days) | 10,000 | ~5 MB |

**Total estimate**: 500 MB - 1 GB per actively synced account.

---

## Security Considerations

1. **File permissions**: data.db should be readable only by the owner (chmod 600)
2. **No encryption at rest**: SQLite doesn't encrypt by default; consider SQLCipher for sensitive deployments
3. **raw_json may contain sensitive data**: Treat the entire database as sensitive
4. **Phone numbers**: Stored in contacts_cache; ensure proper access controls

---

## Future Enhancements

1. **Full-text search**: Add FTS5 virtual tables for message search
2. **Media cache table**: Track downloaded media files with expiration
3. **Drafts table**: Store unsent message drafts per chat
4. **Reactions table**: Cache message reactions
5. **Read receipts**: Track read state for messages
