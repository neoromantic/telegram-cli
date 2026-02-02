# telegram-cli

Agent-friendly Telegram CLI with a local cache and full API access. Built on Bun + mtcute.

## Features

- 🧑‍💻 Multi-account management (`tg accounts`, `--account`)
- 🔐 Authentication helpers (`tg auth`)
- 🔄 Read-only daemon for real-time sync + CLI for mutations (`tg daemon`, `tg send`)
- 🧩 Full Telegram API access via `tg api`
- ⚡ Cache-first UX (stale-while-revalidate) with `--fresh`
- ⏱️ Rate-limit tracking for safer API usage
- 🔍 Full-text search (FTS5) over cached messages
- 🗂️ Contacts, chats, and users browsing (`tg contacts`, `tg chats`, `tg me`, `tg user`)
- 🗄️ Read-only SQL access to the cache (`tg sql`) with annotated schema output
- 🧭 Config + status tooling (`tg config`, `tg status`)
- 🤖 Agent-friendly JSON output + stable error schema
- 🧠 Skill integration (`tg skill manifest|validate|install`)
- 🧰 Modern stack: Bun runtime, TypeScript, mtcute

## Documentation

- Getting started: [CLI commands](docs/cli-commands.md), [Authentication](docs/auth.md), [Configuration](docs/configuration.md)
- Architecture & sync: [Architecture](docs/architecture.md), [Daemon](docs/daemon.md), [Sync strategy](docs/sync-strategy.md), [Real-time updates](docs/real-time.md)
- Data & cache: [Caching](docs/caching.md), [Database schema](docs/database-schema.md), [SQL](docs/sql.md), [Search](docs/search.md), [Rate limiting](docs/rate-limiting.md)
- APIs & UX: [API design](docs/api-design.md), [Contacts](docs/contacts.md)
- Build & test: [Build & distribution](docs/build-distribution.md), [Testing](docs/testing.md)

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

```bash
# Login to your Telegram account (dev)
bun run src/index.ts auth login --phone +79261408252

# List your contacts
bun run src/index.ts contacts list

# Call any Telegram API method
bun run src/index.ts api account.checkUsername --username myuser
```

```bash
# Same commands when installed as a binary
# (see build/installation docs)
tg auth login --phone +79261408252
tg contacts list
tg api account.checkUsername --username myuser
```

## Usage

```bash
tg <command> [options]

tg accounts list
tg contacts list --limit 50
tg chats list --limit 20
tg messages search --query "hello"
tg sql --query "SELECT * FROM users_cache LIMIT 10"
tg daemon start
tg status
tg config path
```

Global options: `--format`, `--verbose`, `--quiet`. Many commands also accept `--account`; cache-aware commands accept `--fresh` (see `tg <command> --help`).

## Output Formats

```bash
# JSON (default)
tg contacts list

# Pretty output
tg contacts list --format pretty

# Quiet mode (exit code only)
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

## Development

```bash
# Type check
bun run typecheck

# Unit tests
bun run test

# E2E tests
bun run test:e2e
```

More in [Testing](docs/testing.md) and [Build & distribution](docs/build-distribution.md).
