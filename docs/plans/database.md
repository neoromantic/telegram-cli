# Database Schema & Patterns

> **Note:** This document contains inspiration from telegram-mcp-server, not finalized decisions.

## Storage Architecture

### File Structure

```
~/.telegram-cli/              # Or platform-appropriate location
├── config.json               # API credentials, phone number
├── accounts/
│   └── default/
│       ├── session.db        # mtcute session (auth keys)
│       └── data.db           # Our sync data (messages, contacts)
└── daemon.pid                # Daemon process ID
```

### Database Initialization

```javascript
// WAL mode for concurrent read/write
this.db.pragma('journal_mode = WAL');
```

## Core Tables (from telegram-mcp-server)

### Channels Table

```sql
CREATE TABLE IF NOT EXISTS channels (
  channel_id TEXT PRIMARY KEY,
  peer_title TEXT,
  peer_type TEXT,        -- 'user', 'chat', 'channel'
  chat_type TEXT,        -- 'group', 'supergroup'
  is_forum INTEGER,
  username TEXT,
  sync_enabled INTEGER NOT NULL DEFAULT 1,
  last_message_id INTEGER DEFAULT 0,
  last_message_date TEXT,
  oldest_message_id INTEGER,
  oldest_message_date TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

**Key insight:** Tracks bidirectional sync cursors (`last_message_id` for newest, `oldest_message_id` for backfill).

### Messages Table

```sql
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id TEXT NOT NULL,
  message_id INTEGER NOT NULL,
  topic_id INTEGER,              -- For forum topics
  date INTEGER,                  -- Unix timestamp
  from_id TEXT,
  text TEXT,
  links TEXT,                    -- Denormalized: space-separated URLs
  files TEXT,                    -- Denormalized: file names
  sender TEXT,                   -- Denormalized sender info
  topic TEXT,                    -- Denormalized topic title
  raw_json TEXT,                 -- Full serialized message
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(channel_id, message_id)
);

CREATE INDEX messages_channel_topic_idx
  ON messages (channel_id, topic_id, message_id);
```

**Key insight:** Denormalizes `links`, `files`, `sender` for fast full-text search.

### Full-Text Search (FTS5)

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS message_search USING fts5(
  text,
  links,
  files,
  sender,
  topic,
  content='messages',        -- Backed by messages table
  content_rowid='id',
  tokenize='unicode61'       -- Supports Unicode, handles diacritics
);
```

**Auto-sync via triggers:**

```sql
CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO message_search(rowid, text, links, files, sender, topic)
  VALUES (
    new.id,
    COALESCE(new.text, ''),
    COALESCE(new.links, ''),
    COALESCE(new.files, ''),
    COALESCE(new.sender, ''),
    COALESCE(new.topic, '')
  );
END;

-- Similar triggers for DELETE and UPDATE
```

### Message Links Table

```sql
CREATE TABLE IF NOT EXISTS message_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id TEXT NOT NULL,
  message_id INTEGER NOT NULL,
  url TEXT NOT NULL,
  domain TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(channel_id, message_id, url)
);

CREATE INDEX message_links_url_idx ON message_links (url);
CREATE INDEX message_links_domain_idx ON message_links (domain);
```

### Message Media Table

```sql
CREATE TABLE IF NOT EXISTS message_media (
  channel_id TEXT NOT NULL,
  message_id INTEGER NOT NULL,
  media_type TEXT,          -- 'photo', 'video', 'document'
  file_id TEXT,
  unique_file_id TEXT,
  file_name TEXT,
  mime_type TEXT,
  file_size INTEGER,
  width INTEGER,
  height INTEGER,
  duration INTEGER,
  extra_json TEXT,
  PRIMARY KEY (channel_id, message_id)
);

CREATE INDEX message_media_type_idx ON message_media (media_type);
CREATE INDEX message_media_mime_idx ON message_media (mime_type);
```

### Users Table

```sql
CREATE TABLE IF NOT EXISTS users (
  user_id TEXT PRIMARY KEY,
  peer_type TEXT,
  username TEXT,
  display_name TEXT,
  phone TEXT,
  is_contact INTEGER,
  is_bot INTEGER,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX users_username_idx ON users (username);
CREATE INDEX users_phone_idx ON users (phone);
```

### Jobs Table (Sync Queue)

```sql
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending',  -- pending, in_progress, idle, error
  target_message_count INTEGER DEFAULT 1000,
  message_count INTEGER DEFAULT 0,
  cursor_message_id INTEGER,
  cursor_message_date TEXT,
  backfill_min_date TEXT,
  last_synced_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  error TEXT
);
```

## Prepared Statements Pattern

```javascript
// Pre-compile statements for performance
this.insertMessageStmt = this.db.prepare(`
  INSERT OR IGNORE INTO messages (
    channel_id, message_id, topic_id, date, from_id, text,
    links, files, sender, topic, raw_json
  ) VALUES (@channel_id, @message_id, @topic_id, @date, ...)
`);

this.upsertMessageStmt = this.db.prepare(`
  INSERT INTO messages (...) VALUES (...)
  ON CONFLICT(channel_id, message_id) DO UPDATE SET ...
`);
```

## Transaction Batching

```javascript
// Batch inserts in a single transaction
this.insertMessagesTx = this.db.transaction((records) => {
  let inserted = 0;
  for (const record of records) {
    const result = this.insertMessageStmt.run(record);
    if (result.changes > 0) {
      inserted += result.changes;
      this._replaceMessageLinks(record);
      this._replaceMessageMedia(record);
    }
  }
  return inserted;
});
```

## Bun:sqlite Adaptation

For telegram-cli using bun:sqlite:

```typescript
import { Database } from 'bun:sqlite';

class MessageRow {
  id!: number;
  channel_id!: string;
  message_id!: number;
  text!: string | null;
  date!: number;
  from_id!: string | null;
  raw_json!: string;
}

const db = new Database('data.db');
db.exec('PRAGMA journal_mode = WAL');

// Typed queries with .as()
const messages = db.query('SELECT * FROM messages WHERE channel_id = ?')
  .as(MessageRow)
  .all(channelId);

// Prepared statement with run()
const insertStmt = db.prepare(`
  INSERT OR IGNORE INTO messages (channel_id, message_id, text, date)
  VALUES ($channel_id, $message_id, $text, $date)
`);

// Transaction
db.transaction(() => {
  for (const msg of messages) {
    insertStmt.run({
      $channel_id: msg.channel_id,
      $message_id: msg.message_id,
      $text: msg.text,
      $date: msg.date,
    });
  }
})();
```

## Metadata Staleness

```javascript
const METADATA_TTL_MS = 7 * 24 * 60 * 60 * 1000;  // 7 days

function isMetadataStale(updatedAt: string | null): boolean {
  if (!updatedAt) return true;
  const ts = new Date(updatedAt).getTime();
  if (Number.isNaN(ts)) return true;
  return Date.now() - ts > METADATA_TTL_MS;
}
```

## Key Patterns

1. **Denormalization for Search**: Extract links, files, sender into text columns
2. **Cursor-based Pagination**: Use `(message_id, date)` as stable cursors
3. **FTS5 Triggers**: Auto-sync search index on INSERT/UPDATE/DELETE
4. **WAL Mode**: Enable concurrent reads during writes
5. **Prepared Statements**: Pre-compile for performance
6. **Transaction Batching**: Group inserts for speed
