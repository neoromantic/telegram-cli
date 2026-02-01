# SQL Command

The `tg sql` command provides direct SQL access to the local cache database for power users, debugging, and AI agent integration.

## Key Features

- **READ-ONLY**: Prevents accidental data corruption
- **Annotated schema**: Built-in documentation for all tables and columns
- **AI-friendly output**: JSON output for machine consumption, CSV for export

---

## Database Target

The command operates on the **cache database** (`~/.telegram-cli/cache.db`):

| Table | Description | TTL |
|-------|-------------|-----|
| `users_cache` | Cached Telegram user information | 1 week |
| `chats_cache` | Cached chat/group/channel information | 1 week |
| `messages_cache` | Synced messages from enabled chats | Eternal |
| `sync_state` | Global sync progress tracking | N/A |
| `chat_sync_state` | Per-chat sync progress | N/A |
| `sync_jobs` | Background sync job queue | N/A |
| `rate_limits` | API rate limiting data | N/A |
| `api_activity` | API call audit log | 7 days |
| `daemon_status` | Daemon runtime state | N/A |

**Note:** Account information is stored separately in `data.db`. Use `tg accounts list` for account queries.

---

## Usage

### Execute SQL Query

```bash
# JSON output (default)
tg sql --query="SELECT * FROM users_cache LIMIT 10"
tg sql -q "SELECT user_id, username FROM users_cache WHERE is_contact = 1"

# CSV output
tg sql --query="SELECT user_id, username FROM users_cache" --format=csv

# Custom row limit
tg sql --query="SELECT * FROM messages_cache" --limit=5000

# Unlimited rows
tg sql --query="SELECT * FROM messages_cache" --limit=0
```

### View Database Schema

```bash
# Full schema (all tables, JSON)
tg sql print-schema

# Single table schema
tg sql print-schema --table=users_cache

# Text format (human readable)
tg sql print-schema --table=users_cache --format=text
```

---

## Options

### `tg sql`

| Flag | Alias | Description | Default |
|------|-------|-------------|---------|
| `--query` | `-q` | SQL query to execute | - |
| `--format` | `-f` | Output format: `json`, `csv` | `json` |
| `--limit` | `-l` | Max rows to return (0 = unlimited) | `1000` |

### `tg sql print-schema`

| Flag | Alias | Description | Default |
|------|-------|-------------|---------|
| `--table` | `-t` | Show schema for specific table | All tables |
| `--format` | `-f` | Output format: `json`, `text` | `json` |

---

## Output Formats

### JSON (Default)

```bash
tg sql --query="SELECT user_id, username FROM users_cache LIMIT 2"
```

```json
{
  "success": true,
  "data": {
    "columns": ["user_id", "username"],
    "rows": [
      {"user_id": "123456", "username": "alice"},
      {"user_id": "789012", "username": "bob"}
    ],
    "rowCount": 2
  }
}
```

### CSV

```bash
tg sql --query="SELECT user_id, username FROM users_cache" --format=csv
```

```csv
user_id,username
123456,alice
789012,bob
```

CSV formatting follows RFC 4180:
- Fields with commas, quotes, or newlines are quoted
- Quotes are escaped by doubling (`"` → `""`)
- NULL values are empty fields
- Header row always included

---

## Schema Output

### JSON Format

```bash
tg sql print-schema --table=users_cache
```

Returns table metadata with column descriptions, types, and annotations.

### Text Format

```bash
tg sql print-schema --table=users_cache --format=text
```

```
Table: users_cache
Description: Cached Telegram user profiles...
TTL: 1 week
Primary Key: user_id

Columns:
  user_id  [PK, NN]
    Telegram user ID (unique identifier)
    Type: bigint_string
  username
    Telegram @username without the @ symbol
    Type: username
  ...

Indexes:
  idx_users_cache_username: Fast lookup by @username
```

---

## Security

### Read-Only Enforcement

Write operations are blocked:

```bash
tg sql --query="DELETE FROM users_cache"
# Error: SQL_WRITE_NOT_ALLOWED
```

### Blocked Operations

- `INSERT`, `UPDATE`, `DELETE`, `REPLACE`
- `DROP`, `ALTER`, `CREATE`, `TRUNCATE`
- `ATTACH`, `DETACH`
- `VACUUM`, `REINDEX`

---

## Example Queries

### Count messages per chat
```bash
tg sql --query="SELECT chat_id, COUNT(*) as count FROM messages_cache GROUP BY chat_id ORDER BY count DESC LIMIT 10"
```

### Find users by username pattern
```bash
tg sql --query="SELECT user_id, username, first_name FROM users_cache WHERE username LIKE '%john%'"
```

### Check cache freshness
```bash
tg sql --query="SELECT entity_type, datetime(last_sync_at/1000, 'unixepoch') as last_sync FROM sync_state"
```

### View rate limit status
```bash
tg sql --query="SELECT method, datetime(flood_wait_until/1000, 'unixepoch') as wait_until FROM rate_limits WHERE flood_wait_until IS NOT NULL"
```

### Export contacts to CSV
```bash
tg sql --query="SELECT first_name, last_name, username, phone FROM users_cache WHERE is_contact = 1" --format=csv > contacts.csv
```

---

## Error Codes

| Code | Description |
|------|-------------|
| `SQL_SYNTAX_ERROR` | Invalid SQL syntax |
| `SQL_TABLE_NOT_FOUND` | Table doesn't exist |
| `SQL_WRITE_NOT_ALLOWED` | Write operation attempted |
| `SQL_OPERATION_BLOCKED` | Blocked operation (ATTACH, etc.) |

---

## Implementation

Source files:
- `src/commands/sql.ts` - Command implementation
- `src/db/schema-annotations.ts` - Schema metadata registry
- `src/utils/csv.ts` - CSV formatting utilities

---

*Last updated: 2026-02-02*
