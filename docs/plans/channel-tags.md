# Channel Tags & Auto-Tagging

> **Note:** This document contains inspiration from telegram-mcp-server, not finalized decisions.

## Database Schema

### Channel Tags Table

```sql
CREATE TABLE IF NOT EXISTS channel_tags (
  channel_id TEXT NOT NULL,
  tag TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'manual',  -- 'manual' or 'auto'
  confidence REAL,                          -- For auto-tags: 0.0-1.0
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (channel_id, tag, source)
);

CREATE INDEX channel_tags_tag_idx ON channel_tags (tag);
```

### Channel Metadata Table

```sql
CREATE TABLE IF NOT EXISTS channel_metadata (
  channel_id TEXT PRIMARY KEY,
  about TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX channel_metadata_updated_idx ON channel_metadata (updated_at);
```

## Manual Tag Operations

### Set Tags

```javascript
setChannelTags(channelId, tags, source = 'manual') {
  const normalized = tags
    .map(t => t.trim().toLowerCase())
    .filter(t => t.length > 0);

  // Remove existing tags from this source
  this.db.prepare(`
    DELETE FROM channel_tags
    WHERE channel_id = ? AND source = ?
  `).run(channelId, source);

  // Insert new tags
  const stmt = this.db.prepare(`
    INSERT INTO channel_tags (channel_id, tag, source, confidence)
    VALUES (?, ?, ?, ?)
  `);

  for (const tag of normalized) {
    stmt.run(channelId, tag, source, source === 'manual' ? null : 1.0);
  }
}
```

### List Tags

```javascript
listChannelTags(channelId) {
  return this.db.prepare(`
    SELECT tag, source, confidence
    FROM channel_tags
    WHERE channel_id = ?
    ORDER BY tag
  `).all(channelId);
}
```

### Search by Tag

```javascript
searchChannelsByTag(tag, options = {}) {
  const { source, limit = 100 } = options;

  let whereClause = 'WHERE ct.tag = ?';
  const params = [tag.toLowerCase()];

  if (source) {
    whereClause += ' AND ct.source = ?';
    params.push(source);
  }

  params.push(limit);

  return this.db.prepare(`
    SELECT DISTINCT
      c.channel_id,
      c.peer_title,
      c.username,
      c.peer_type,
      ct.source,
      ct.confidence
    FROM channel_tags ct
    JOIN channels c ON c.channel_id = ct.channel_id
    ${whereClause}
    ORDER BY c.peer_title
    LIMIT ?
  `).all(...params);
}
```

## Auto-Tagging System

### Tag Rules

```javascript
const TAG_RULES = [
  {
    tag: 'ai',
    patterns: [
      /\bai\b/iu,
      /\bartificial intelligence\b/iu,
      /\bmachine learning\b/iu,
      /\bllm\b/iu,
      /\bgpt\b/iu,
      /\bchatgpt\b/iu,
      /нейросет/iu,      // Russian: neural network
      /искусственн/iu,   // Russian: artificial
    ],
  },
  {
    tag: 'crypto',
    patterns: [
      /\bcrypto\b/iu,
      /\bbitcoin\b/iu,
      /\bbtc\b/iu,
      /\bethereum\b/iu,
      /\beth\b/iu,
      /\bblockchain\b/iu,
      /крипт/iu,
      /блокчейн/iu,
    ],
  },
  {
    tag: 'news',
    patterns: [
      /\bnews\b/iu,
      /\bbreaking\b/iu,
      /новост/iu,
    ],
  },
  {
    tag: 'tech',
    patterns: [
      /\btech\b/iu,
      /\btechnology\b/iu,
      /\bprogramming\b/iu,
      /\bdeveloper\b/iu,
      /\bсoftware\b/iu,
      /технолог/iu,
      /програм/iu,
    ],
  },
  {
    tag: 'jobs',
    patterns: [
      /\bjob\b/iu,
      /\bjobs\b/iu,
      /\bhiring\b/iu,
      /\bvacancy\b/iu,
      /вакансi/iu,
      /работ/iu,
    ],
  },
  // ... more categories
];
```

### Classification Function

```javascript
function classifyTags(text) {
  if (!text) return [];

  const results = [];

  for (const rule of TAG_RULES) {
    let hits = 0;

    for (const pattern of rule.patterns) {
      if (pattern.test(text)) {
        hits += 1;
      }
    }

    if (hits > 0) {
      // Confidence: more pattern matches = higher confidence
      const confidence = Math.min(1, hits / 3);
      results.push({ tag: rule.tag, confidence });
    }
  }

  return results;
}
```

### Auto-Tag Channels

```javascript
async autoTagChannels(options = {}) {
  const { channelIds, limit = 100 } = options;

  const channels = channelIds
    ? this.db.prepare(`
        SELECT channel_id, peer_title, username
        FROM channels
        WHERE channel_id IN (${channelIds.map(() => '?').join(',')})
      `).all(...channelIds)
    : this.listActiveChannels();

  let tagged = 0;

  for (const channel of channels.slice(0, limit)) {
    // Get metadata if available
    const metadata = this._getChannelMetadata(channel.channel_id);

    // Build text for classification
    const text = buildTagText({
      peerTitle: channel.peer_title,
      username: channel.username,
      about: metadata?.about,
    });

    // Classify
    const tags = classifyTags(text);

    if (tags.length) {
      this._setChannelTagsWithConfidence(channel.channel_id, 'auto', tags);
      tagged += 1;
    }
  }

  return { tagged, total: Math.min(channels.length, limit) };
}

function buildTagText({ peerTitle, username, about }) {
  return [peerTitle, username, about]
    .filter(Boolean)
    .join(' ');
}
```

### Store Tags with Confidence

```javascript
_setChannelTagsWithConfidence(channelId, source, tagEntries) {
  // Remove old auto-tags
  this.db.prepare(`
    DELETE FROM channel_tags
    WHERE channel_id = ? AND source = ?
  `).run(channelId, source);

  // Insert new tags
  const stmt = this.db.prepare(`
    INSERT INTO channel_tags (channel_id, tag, source, confidence)
    VALUES (?, ?, ?, ?)
  `);

  for (const { tag, confidence } of tagEntries) {
    stmt.run(channelId, tag, source, confidence);
  }
}
```

## Metadata Caching

### Staleness Check

```javascript
const METADATA_TTL_MS = 7 * 24 * 60 * 60 * 1000;  // 7 days

function isMetadataStale(updatedAt) {
  if (!updatedAt) return true;

  const ts = new Date(updatedAt).getTime();
  if (Number.isNaN(ts)) return true;

  return Date.now() - ts > METADATA_TTL_MS;
}
```

### Refresh Metadata

```javascript
async refreshChannelMetadata(channelIds) {
  const refreshed = [];

  for (const channelId of channelIds) {
    const existing = this._getChannelWithMetadata(channelId);

    // Skip if fresh
    if (!isMetadataStale(existing?.metadata_updated_at)) {
      continue;
    }

    try {
      // Fetch full chat info from Telegram
      const fullChat = await this.telegramClient.client.getFullChat(channelId);

      // Store metadata
      this.db.prepare(`
        INSERT INTO channel_metadata (channel_id, about, updated_at)
        VALUES (?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(channel_id) DO UPDATE SET
          about = excluded.about,
          updated_at = excluded.updated_at
      `).run(channelId, fullChat.about ?? fullChat.bio ?? null);

      refreshed.push(channelId);
    } catch (error) {
      console.warn(`Failed to refresh metadata for ${channelId}:`, error.message);
    }
  }

  return { refreshed: refreshed.length };
}
```

## CLI Commands

```bash
# Set tags manually
tg tags set @channel ai tech

# List tags
tg tags list @channel

# Search by tag
tg tags search ai
tg tags search ai --source auto

# Auto-tag all channels
tg tags auto

# Auto-tag specific channels
tg tags auto --channel @chan1 --channel @chan2

# Refresh metadata (for better auto-tagging)
tg metadata refresh @channel
tg metadata refresh --all
```

## Key Patterns

1. **Source tracking**: Distinguish manual vs auto tags
2. **Confidence scores**: Auto-tags have 0.0-1.0 confidence
3. **Pattern-based classification**: Regex matching with hit counting
4. **Multilingual support**: Russian patterns included
5. **Metadata caching**: 7-day TTL for channel descriptions
6. **Lowercase normalization**: All tags stored lowercase
