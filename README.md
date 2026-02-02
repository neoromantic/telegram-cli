# telegram-cli

Agent-friendly Telegram CLI client with full API support.

## Features

- **Multi-account support** — list/switch/remove accounts, per-command `--account` (see `docs/cli-commands.md`, `docs/configuration.md`)
- **Daemon + realtime sync** — background updates with read-only daemon mode (see `docs/daemon.md`, `docs/real-time.md`)
- **Full API access** — call any Telegram API method via `tg api` (see `docs/cli-commands.md`)
- **Agent-friendly output** — JSON by default, stable error schema (see `docs/api-design.md`)
- **Full-text search** — FTS5 search over cached messages (`tg messages search`) (see `docs/search.md`)
- **Cache-first UX** — stale-while-revalidate with `--fresh` overrides (see `docs/caching.md`)
- **Read-only SQL** — query local cache via `tg sql` (see `docs/sql.md`)
- **Skill integration** — `tg skill manifest|validate|install` (see `docs/api-design.md`)
- **Modern stack** — Bun runtime, mtcute, TypeScript (see `docs/architecture.md`)

## Documentation

- Architecture: `docs/architecture.md`
- Daemon: `docs/daemon.md`
- Sync strategy: `docs/sync-strategy.md`
- CLI commands: `docs/cli-commands.md`
- Contacts: `docs/contacts.md`
- Search (FTS5): `docs/search.md`
- Rate limiting: `docs/rate-limiting.md`
- Configuration: `docs/configuration.md`
- Build & distribution: `docs/build-distribution.md`
- Real-time updates: `docs/real-time.md`
- Testing: `docs/testing.md`
- Database schema: `docs/database-schema.md`
- Caching: `docs/caching.md`
- SQL command: `docs/sql.md`
- Auth: `docs/auth.md`

## Installation

```bash
# Clone the repository
git clone <repo-url>
cd telegram-cli

# Install dependencies
bun install

# Set up environment variables
cp .env.example .env
# Edit .env with your API credentials from https://my.telegram.org/apps
```

## Quick Start

### Run from source (dev)

```bash
# Login to your Telegram account
bun run src/index.ts auth login --phone +79261408252

# List your contacts
bun run src/index.ts contacts list

# Call any Telegram API method
bun run src/index.ts api account.checkUsername --username myuser
```

### Run installed binary

```bash
# Login to your Telegram account
tg auth login --phone +79261408252

# List your contacts
tg contacts list

# Call any Telegram API method
tg api account.checkUsername --username myuser
```

## Commands

### Authentication

```bash
# Login to Telegram
tg auth login --phone +79261408252

# Check auth status
tg auth status

# Logout
tg auth logout
```

### Account Management

```bash
# List all accounts
tg accounts list

# Switch active account
tg accounts switch --id 1

# Remove an account
tg accounts remove --id 1
```

### Contacts

```bash
# List contacts (paginated)
tg contacts list --limit 50 --offset 0

# Search contacts
tg contacts search --query "John"

# Get contact by ID
tg contacts get --id 123456789
```

### Messaging

```bash
# Send a message
tg send --to @username --message "Hello!"
tg send --to 123456789 -m "Hello!"
```

### Messages Search

```bash
# Search cached messages
tg messages search --query "hello"

# Filter by chat and sender (cache-only)
tg messages search --query "hello" --chat @teamchat --sender @alice

# Include deleted messages
tg messages search --query "hello" --includeDeleted
```

### Daemon & Status

```bash
# Start/stop daemon
tg daemon start
tg daemon stop

# Show system status
tg status
```

### SQL (Read-only)

```bash
# Query cache database
tg sql --query "SELECT * FROM users_cache LIMIT 10"

# Inspect schema
tg sql print-schema --table=users_cache
```

### Skill Integration

```bash
# Print skill manifest JSON
tg skill manifest

# Validate environment + data directory access
tg skill validate

# Install manifest to default path (~/.telegram-cli/skill.json)
tg skill install
```

### Generic API Access

The `api` command lets you call any Telegram API method directly:

```bash
# Check username availability
tg api account.checkUsername --username myuser

# Get chat history
tg api messages.getHistory --peer @username --limit 10

# Send a message
tg api messages.sendMessage --json '{"peer": "@username", "message": "Hello!"}'

# Get full chat info
tg api channels.getFullChannel --channel @channelname
```

## Output Formats

```bash
# JSON (default) - perfect for automation
tg contacts list

# Pretty print
tg contacts list --format pretty

# Quiet mode (no output, just exit code)
tg contacts list --format quiet
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `TELEGRAM_API_ID` | Your Telegram API ID |
| `TELEGRAM_API_HASH` | Your Telegram API Hash |
| `TELEGRAM_CLI_DATA_DIR` | Override data directory |
| `MTCUTE_LOG_LEVEL` | mtcute log level |
| `VERBOSE` | Verbose logging (`1`) |

Get API credentials from https://my.telegram.org/apps.

## Development

```bash
# Run with watch mode
bun run dev

# Type check
bun run typecheck

# Unit tests
bun run test

# E2E tests
bun run test:e2e
```
