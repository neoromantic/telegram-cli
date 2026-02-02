# Architecture Documentation

## Overview

telegram-cli is a command-line utility for interacting with Telegram's full API. It's designed for:
- Agent-friendly automation
- Multi-account support
- Non-interactive command execution
- Responsive caching with stale-while-revalidate pattern

## Technology Stack

| Component | Choice | Rationale |
|-----------|--------|-----------|
| Runtime | Bun | Native SQLite, fast startup, TypeScript-first |
| Language | TypeScript | Type safety, better DX |
| Telegram | mtcute (`@mtcute/bun`) | Modern, Bun support, TypeScript-first |
| CLI | Citty | Lightweight, TypeScript-first |
| Storage | bun:sqlite | Native, zero deps |
| Linting | Biome | Fast, all-in-one linter + formatter |
| Type Checker | tsgo | 10x faster than tsc, Go-based |
| Git Hooks | lefthook | Simple, parallel hook execution |

## Core Components

### 1. CLI Layer (`src/commands/`)
- Uses Citty for command parsing
- Each command is a separate module
- Commands delegate to services and cache layers
- Implemented: `auth`, `accounts`, `contacts`, `chats`, `send`, `api`, `me`, `user`, `daemon`, `status`, `sql`

### 2. Service Layer (`src/services/`)
- Telegram client management
- Rate-limit coordination
- Shared utilities

### 3. Database Layer (`src/db/`)
- **Accounts DB** (`data.db`) — account records
- **Cache/Sync DB** (`cache.db`) — users/chats cache, messages, sync jobs/state
- **Sessions** (`session_<id>.db`) — mtcute session storage per account

> `TELEGRAM_CLI_DATA_DIR` overrides the base data directory (defaults to `~/.telegram-cli`).

### 4. Cache Services (`src/db/*-cache.ts`)
- `UsersCache` — user/contact caching with search
- `ChatsCache` — dialog/chat caching with filtering
- Prepared statements for performance
- Transaction support for bulk operations

### 5. Daemon & Sync (`src/daemon/`)
- Long-running daemon process for real-time updates and background message sync
- Per-account mtcute connections (max 5)
- Sync jobs for forward catchup and backfill
- Read-only to Telegram (no mutations)

## Data Flow

```
User Input → CLI Parser → Command → Cache Check → Service → Telegram API
                              ↓                       ↓
                        Cache Services ←──────────────┘
                              ↓
                    SQLite (data.db, cache.db)
```

### Caching Flow

```
Command Request
      │
      ▼
┌─────────────────┐
│ --fresh flag?   │
└────────┬────────┘
         │
    ┌────┴────┐
   Yes        No
    │          │
    │          ▼
    │    ┌──────────────┐
    │    │ Check Cache  │
    │    └──────┬───────┘
    │           │
    │      ┌────┴────┐
    │     Hit       Miss
    │      │          │
    │      ▼          │
    │  ┌───────────┐  │
    │  │ Return    │  │
    │  │ cached +  │  │
    │  │ stale flag│  │
    │  └───────────┘  │
    │                 │
    ▼                 ▼
┌─────────────────────────┐
│ Fetch from Telegram API │
└────────────┬────────────┘
             │
             ▼
┌─────────────────────────┐
│ Update Cache + Return   │
│ source: "api"           │
└─────────────────────────┘
```

## Database Schema

The project uses two SQLite databases under the data directory:

- `data.db` — account records (`accounts` table)
- `cache.db` — users/chats cache, messages, sync jobs/state, daemon status

For full table definitions, see `docs/database-schema.md`.

## Command Structure

```
tg <command> [options]

Commands:
  auth login        Login to Telegram account
  auth login-qr     Login via QR code
  auth logout       Logout from account
  auth status       Check authentication status

  accounts list     List all accounts
  accounts switch   Switch active account
  accounts remove   Remove account
  accounts info     Show account details

  contacts list     List contacts (cached, --fresh for API)
  contacts search   Search contacts
  contacts get      Get contact by ID or @username

  chats list        List dialogs (cached, --fresh for API)
  chats search      Search chats by title/username (cache-only)
  chats get         Get chat by @username

  send              Send message to user/chat

  api               Generic API call
  me                Show current user
  user              Lookup user
  status            Show system status
  daemon            Start/stop/status daemon
  sql               Query cache DB (read-only)
```

### Global Flags

| Flag | Description |
|------|-------------|
| `--format` | Output format: `json`, `pretty`, `quiet` |
| `--verbose` | Detailed output |
| `--quiet` | Minimal output |

> `--account` and `--fresh` are **per-command** options where supported.

## Error Handling Strategy

1. Consistent JSON output with `success` wrapper
2. Structured error codes + details
3. Exit codes for scripting

## Security Considerations

- Sessions stored locally in SQLite (`session_<id>.db`)
- No cloud sync of credentials
- 2FA support
- Session revocation support
