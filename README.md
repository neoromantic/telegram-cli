# telegram-cli

Agent-friendly Telegram CLI client with full API support.

## Features

- **Multi-account support** - Manage multiple Telegram accounts
- **Full API access** - Call any Telegram API method via `tg api`
- **Agent-friendly** - JSON output by default, perfect for automation
- **Type-safe** - Built with TypeScript for reliability
- **Modern stack** - Uses Bun runtime and mtcute library

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

Get these from [my.telegram.org/apps](https://my.telegram.org/apps).

## Development

```bash
# Run with watch mode
bun run dev

# Type check
bun run typecheck

# Run tests
bun run test
```

## Architecture

- **Runtime**: Bun
- **Telegram Library**: [mtcute](https://mtcute.dev) - Modern TypeScript MTProto library
- **CLI Framework**: [Citty](https://github.com/unjs/citty) - TypeScript-first CLI builder
- **Database**: bun:sqlite - Native SQLite for session storage

## License

MIT
