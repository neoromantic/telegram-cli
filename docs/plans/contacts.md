# Contact Management

> **Status:** Core functionality implemented. See `src/commands/contacts.ts` for implementation.
>
> The contacts command uses `UsersCache` (`src/db/users-cache.ts`) for stale-while-revalidate caching.

## Implementation Summary

**Implemented commands:**
- `tg contacts list` - List contacts with pagination and caching
- `tg contacts search` - Search contacts by name/username
- `tg contacts get` - Get contact by ID or @username

**Caching behavior:**
- Cache checked first unless `--fresh` flag is used
- Response includes `source: "cache" | "api"` and `stale: boolean`
- Stale TTL: 7 days (configurable via `CacheConfig.staleness.peers`)

**Not yet implemented:**
- Tags and aliases (local metadata enrichment)
- Notes field

## Database Schema

### Users Table (Cache)

```sql
CREATE TABLE IF NOT EXISTS users (
  user_id TEXT PRIMARY KEY,
  peer_type TEXT,           -- 'user', 'bot'
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

### Contacts Table (Local Metadata)

```sql
CREATE TABLE IF NOT EXISTS contacts (
  user_id TEXT PRIMARY KEY,
  alias TEXT,               -- Custom display name
  notes TEXT,               -- Free-form notes
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

### Contact Tags Table

```sql
CREATE TABLE IF NOT EXISTS contact_tags (
  user_id TEXT NOT NULL,
  tag TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, tag)
);

CREATE INDEX contact_tags_tag_idx ON contact_tags (tag);
CREATE INDEX contact_tags_user_idx ON contact_tags (user_id);
```

## Operations

### Search Contacts

```javascript
searchContacts({ query, tags, limit = 100 }) {
  const params = [];
  let whereClause = 'WHERE 1=1';
  let joinTags = '';

  if (query) {
    whereClause += ` AND (
      u.username LIKE ? OR
      u.display_name LIKE ? OR
      u.phone LIKE ? OR
      c.alias LIKE ? OR
      c.notes LIKE ?
    )`;
    const pattern = `%${query}%`;
    params.push(pattern, pattern, pattern, pattern, pattern);
  }

  if (tags?.length) {
    joinTags = `
      JOIN contact_tags ct ON ct.user_id = u.user_id
    `;
    whereClause += ` AND ct.tag IN (${tags.map(() => '?').join(',')})`;
    params.push(...tags);
  }

  params.push(limit);

  return this.db.prepare(`
    SELECT DISTINCT
      u.user_id,
      u.username,
      u.display_name,
      u.phone,
      u.is_bot,
      c.alias,
      c.notes
    FROM users u
    LEFT JOIN contacts c ON c.user_id = u.user_id
    ${joinTags}
    ${whereClause}
    ORDER BY u.display_name
    LIMIT ?
  `).all(...params);
}
```

### Get Contact

```javascript
getContact(userId) {
  return this.db.prepare(`
    SELECT
      u.user_id,
      u.username,
      u.display_name,
      u.phone,
      u.is_bot,
      c.alias,
      c.notes,
      (
        SELECT GROUP_CONCAT(ct.tag, ',')
        FROM contact_tags ct
        WHERE ct.user_id = u.user_id
      ) as tags
    FROM users u
    LEFT JOIN contacts c ON c.user_id = u.user_id
    WHERE u.user_id = ?
  `).get(userId);
}
```

### Set Alias

```javascript
setContactAlias(userId, alias) {
  const normalizedAlias = alias?.trim() || null;

  if (normalizedAlias) {
    this.db.prepare(`
      INSERT INTO contacts (user_id, alias, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(user_id) DO UPDATE SET
        alias = excluded.alias,
        updated_at = excluded.updated_at
    `).run(userId, normalizedAlias);
  } else {
    // Remove alias
    this.db.prepare(`
      UPDATE contacts SET alias = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE user_id = ?
    `).run(userId);
  }
}
```

### Manage Tags

```javascript
addContactTags(userId, tags) {
  const stmt = this.db.prepare(`
    INSERT OR IGNORE INTO contact_tags (user_id, tag)
    VALUES (?, ?)
  `);

  for (const tag of tags) {
    const normalized = tag.trim().toLowerCase();
    if (normalized) {
      stmt.run(userId, normalized);
    }
  }
}

removeContactTags(userId, tags) {
  const placeholders = tags.map(() => '?').join(',');
  this.db.prepare(`
    DELETE FROM contact_tags
    WHERE user_id = ? AND tag IN (${placeholders})
  `).run(userId, ...tags.map(t => t.trim().toLowerCase()));
}

listContactTags(userId) {
  return this.db.prepare(`
    SELECT tag FROM contact_tags
    WHERE user_id = ?
    ORDER BY tag
  `).all(userId).map(row => row.tag);
}
```

### Set Notes

```javascript
setContactNotes(userId, notes) {
  const normalizedNotes = notes?.trim() || null;

  this.db.prepare(`
    INSERT INTO contacts (user_id, notes, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id) DO UPDATE SET
      notes = excluded.notes,
      updated_at = excluded.updated_at
  `).run(userId, normalizedNotes);
}
```

## User Cache Updates

```javascript
upsertUser(user) {
  const displayName = [user.firstName, user.lastName]
    .filter(Boolean)
    .join(' ') || null;

  this.db.prepare(`
    INSERT INTO users (user_id, peer_type, username, display_name, phone, is_contact, is_bot, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id) DO UPDATE SET
      peer_type = excluded.peer_type,
      username = excluded.username,
      display_name = excluded.display_name,
      phone = excluded.phone,
      is_contact = excluded.is_contact,
      is_bot = excluded.is_bot,
      updated_at = excluded.updated_at
  `).run(
    String(user.id),
    user.isBot ? 'bot' : 'user',
    user.username ?? null,
    displayName,
    user.phone ?? null,
    user.isContact ? 1 : 0,
    user.isBot ? 1 : 0
  );
}
```

## CLI Commands

### Implemented

```bash
# List contacts (cached by default)
tg contacts list
tg contacts list --limit 50 --offset 100
tg contacts list --fresh  # Force API fetch

# Search contacts
tg contacts search "query"
tg contacts search "Alice" --limit 10
tg contacts search "Alice" --fresh

# Get contact details
tg contacts get @username
tg contacts get 123456789
tg contacts get @username --fresh
```

### Planned (Not Yet Implemented)

```bash
# Manage aliases
tg contacts alias set @username "John from Work"
tg contacts alias remove @username

# Manage tags
tg contacts tags add @username work colleague
tg contacts tags remove @username work

# Set notes
tg contacts notes set @username "Met at conference 2024"
```

## Citty Commands

```typescript
export const contactsCommand = defineCommand({
  meta: { name: 'contacts', description: 'Contact management' },
  subCommands: {
    search: defineCommand({
      meta: { name: 'search', description: 'Search contacts' },
      args: {
        query: { type: 'positional', description: 'Search query' },
        tag: { type: 'string', description: 'Filter by tag' },
        limit: { type: 'string', default: '100' },
      },
      async run({ args }) {
        const results = await searchContacts({
          query: args.query,
          tags: args.tag ? [args.tag] : undefined,
          limit: parseInt(args.limit, 10),
        });
        console.log(JSON.stringify(results, null, 2));
      },
    }),

    show: defineCommand({
      meta: { name: 'show', description: 'Show contact details' },
      args: {
        user: { type: 'positional', required: true },
      },
      async run({ args }) {
        const contact = await getContact(args.user);
        console.log(JSON.stringify(contact, null, 2));
      },
    }),
  },
});
```

## Key Patterns

1. **Separate cache vs metadata**: Users table is cache, Contacts table is local enrichment
2. **Tag-based organization**: Flexible categorization via contact_tags
3. **Alias support**: Override display names locally
4. **Notes field**: Free-form text for context
5. **Case-insensitive tags**: Normalize to lowercase
