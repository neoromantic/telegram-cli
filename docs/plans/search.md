# Full-Text Search

> **Note:** This document contains inspiration from telegram-mcp-server, not finalized decisions.

## FTS5 Virtual Table

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS message_search USING fts5(
  text,
  links,
  files,
  sender,
  topic,
  content='messages',        -- Backed by messages table
  content_rowid='id',
  tokenize='unicode61'       -- Unicode-aware tokenization
);
```

### Why These Columns?

| Column | Purpose |
|--------|---------|
| `text` | Message content |
| `links` | Space-separated URLs for link search |
| `files` | Space-separated filenames |
| `sender` | "username displayname userid" for sender search |
| `topic` | Forum topic title |

## Auto-Sync Triggers

```sql
-- Insert trigger
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

-- Delete trigger
CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO message_search(message_search, rowid, text, links, files, sender, topic)
  VALUES (
    'delete',
    old.id,
    COALESCE(old.text, ''),
    COALESCE(old.links, ''),
    COALESCE(old.files, ''),
    COALESCE(old.sender, ''),
    COALESCE(old.topic, '')
  );
END;

-- Update trigger
CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
  INSERT INTO message_search(message_search, rowid, text, links, files, sender, topic)
  VALUES (
    'delete',
    old.id,
    COALESCE(old.text, ''),
    COALESCE(old.links, ''),
    COALESCE(old.files, ''),
    COALESCE(old.sender, ''),
    COALESCE(old.topic, '')
  );
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
```

## Search Query Pattern

```javascript
searchMessages({ query, tags, limit = 100 }) {
  const params = [];
  let joinTags = '';
  let whereClause = 'WHERE 1=1';

  if (query) {
    whereClause += ' AND message_search MATCH ?';
    params.push(query);
  }

  if (tags?.length) {
    joinTags = `
      JOIN channel_tags ON channel_tags.channel_id = messages.channel_id
    `;
    whereClause += ` AND channel_tags.tag IN (${tags.map(() => '?').join(',')})`;
    params.push(...tags);
  }

  params.push(limit);

  // Query via FTS table joined to messages
  const sql = query ? `
    SELECT
      messages.channel_id,
      channels.peer_title,
      channels.username,
      messages.message_id,
      messages.date,
      messages.from_id,
      messages.text,
      messages.topic_id
    FROM message_search
    JOIN messages ON messages.id = message_search.rowid
    ${joinTags}
    LEFT JOIN channels ON channels.channel_id = messages.channel_id
    ${whereClause}
    ORDER BY messages.date DESC
    LIMIT ?
  ` : `
    SELECT ...
    FROM messages
    ${joinTags}
    LEFT JOIN channels ON channels.channel_id = messages.channel_id
    ${whereClause}
    ORDER BY messages.date DESC
    LIMIT ?
  `;

  return this.db.prepare(sql).all(...params);
}
```

## Search Field Extraction

### URL Extraction

```javascript
const URL_PATTERN = /https?:\/\/[^\s<>"')]+/giu;

function extractLinksFromText(text) {
  if (!text) return [];

  const matches = text.match(URL_PATTERN) ?? [];
  const results = new Set();

  for (const raw of matches) {
    // Clean trailing punctuation
    const cleaned = raw.replace(/[),.!?;:]+$/g, '');
    if (cleaned) results.add(cleaned);
  }

  return [...results];
}

function buildLinkEntries(links) {
  return links.map(url => {
    let domain = null;
    try {
      domain = new URL(url).hostname;
    } catch (error) {
      domain = null;
    }
    return { url, domain };
  });
}
```

### Sender Text Building

```javascript
function buildSenderText(message) {
  const parts = [];

  if (message.sender?.username) {
    parts.push(message.sender.username);
  }

  const displayName = [
    message.sender?.firstName,
    message.sender?.lastName,
  ].filter(Boolean).join(' ');

  if (displayName) {
    parts.push(displayName);
  }

  if (message.sender?.id) {
    parts.push(String(message.sender.id));
  }

  return parts.join(' ') || null;
}
```

### File Name Extraction

```javascript
function extractFileNames(message) {
  const files = [];

  if (message.media?.fileName) {
    files.push(message.media.fileName);
  }

  if (message.media?.document?.fileName) {
    files.push(message.media.document.fileName);
  }

  return files;
}
```

## Search Index Versioning

```javascript
const SEARCH_INDEX_VERSION = 2;

function checkSearchIndexVersion() {
  const storedVersion = this.db.prepare(`
    SELECT value FROM search_meta WHERE key = 'search_index_version'
  `).get()?.value;

  const needsRebuild = Number(storedVersion ?? 0) !== SEARCH_INDEX_VERSION;

  if (needsRebuild) {
    // Drop and recreate FTS table
    this.db.exec(`
      DROP TRIGGER IF EXISTS messages_ai;
      DROP TRIGGER IF EXISTS messages_ad;
      DROP TRIGGER IF EXISTS messages_au;
      DROP TABLE IF EXISTS message_search;
    `);

    // Recreate with new schema
    createFtsTable();

    // Rebuild index
    this.db.prepare(`
      INSERT INTO message_search(message_search) VALUES ('rebuild')
    `).run();

    // Store new version
    this.db.prepare(`
      INSERT INTO search_meta (key, value)
      VALUES ('search_index_version', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(String(SEARCH_INDEX_VERSION));
  }
}
```

## Regex Filtering (Post-FTS)

```javascript
function filterMessagesByPattern(messages, pattern, caseInsensitive = true) {
  if (!pattern) return messages;

  const flags = caseInsensitive ? 'iu' : 'u';
  const regex = new RegExp(pattern, flags);

  return messages.filter(msg => {
    const text = msg.text ?? msg.message ?? '';
    return regex.test(text);
  });
}
```

## Bun:sqlite Adaptation

```typescript
import { Database } from 'bun:sqlite';

class SearchService {
  private db: Database;

  search(query: string, options: { limit?: number; tags?: string[] } = {}) {
    const { limit = 100, tags } = options;

    let sql = `
      SELECT m.*, c.peer_title, c.username
      FROM message_search ms
      JOIN messages m ON m.id = ms.rowid
      LEFT JOIN channels c ON c.channel_id = m.channel_id
      WHERE ms MATCH ?
    `;

    const params: (string | number)[] = [query];

    if (tags?.length) {
      sql += ` AND m.channel_id IN (
        SELECT channel_id FROM channel_tags WHERE tag IN (${tags.map(() => '?').join(',')})
      )`;
      params.push(...tags);
    }

    sql += ` ORDER BY m.date DESC LIMIT ?`;
    params.push(limit);

    return this.db.query(sql).all(...params);
  }
}
```

## Key Patterns

1. **Denormalization**: Store searchable text inline in main table
2. **FTS5 content table**: Link FTS to main table via `content='messages'`
3. **Unicode tokenizer**: Handle multilingual content
4. **Trigger sync**: Auto-update search index on CRUD
5. **Version tracking**: Rebuild index when schema changes
6. **Post-FTS regex**: Filter results with regex after FTS query
