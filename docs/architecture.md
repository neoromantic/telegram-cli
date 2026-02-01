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
| Telegram | mtcute | Modern, Bun support, TypeScript-first |
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
- Implemented: `auth`, `accounts`, `contacts`, `chats`, `send`, `api`

### 2. Service Layer (`src/services/`)
- Business logic
- Telegram client management
- State coordination

### 3. Database Layer (`src/db/`)
- **Accounts DB** (`data.db`) - Account storage, always initialized
- **Cache DB** (`cache.db`) - Lazy-initialized via `getCacheDb()`
- **Cache Services** - `UsersCache`, `ChatsCache` for typed cache access

### 4. Cache Services (`src/db/*-cache.ts`)
- `UsersCache` - User/contact caching with search
- `ChatsCache` - Dialog/chat caching with filtering
- Prepared statements for performance
- Transaction support for bulk operations

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

### Main Database (`data.db`)

```sql
CREATE TABLE accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT UNIQUE NOT NULL,
  name TEXT,
  session_data TEXT NOT NULL DEFAULT '',
  is_active INTEGER DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
```

### Cache Database (`cache.db`)

The cache database is lazily initialized on first use via `getCacheDb()`.

```sql
-- Users/contacts cache
CREATE TABLE users_cache (
  user_id TEXT PRIMARY KEY,
  username TEXT,
  first_name TEXT,
  last_name TEXT,
  display_name TEXT,
  phone TEXT,
  access_hash TEXT,
  is_contact INTEGER DEFAULT 0,
  is_bot INTEGER DEFAULT 0,
  is_premium INTEGER DEFAULT 0,
  fetched_at INTEGER NOT NULL,
  raw_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Chats/dialogs cache
CREATE TABLE chats_cache (
  chat_id TEXT PRIMARY KEY,
  type TEXT NOT NULL,  -- 'private', 'group', 'supergroup', 'channel'
  title TEXT,
  username TEXT,
  member_count INTEGER,
  access_hash TEXT,
  is_creator INTEGER DEFAULT 0,
  is_admin INTEGER DEFAULT 0,
  last_message_id INTEGER,
  last_message_at INTEGER,
  fetched_at INTEGER NOT NULL,
  raw_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Sync state tracking
CREATE TABLE sync_state (
  entity_type TEXT PRIMARY KEY,
  forward_cursor TEXT,
  backward_cursor TEXT,
  is_complete INTEGER DEFAULT 0,
  last_sync_at INTEGER
);

-- Rate limit tracking
CREATE TABLE rate_limits (
  method TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  call_count INTEGER DEFAULT 1,
  last_call_at INTEGER,
  flood_wait_until INTEGER,
  PRIMARY KEY (method, window_start)
);

-- API activity logging
CREATE TABLE api_activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp INTEGER NOT NULL,
  method TEXT NOT NULL,
  success INTEGER NOT NULL,
  error_code TEXT,
  response_ms INTEGER,
  context TEXT
);
```

## Authentication Flow

1. User provides phone number
2. mtcute sends code request to Telegram
3. User enters verification code
4. Optional: 2FA password
5. Session stored in database
6. Future sessions restore from database

## Command Structure

```
telegram-cli <command> [options]

Commands:
  auth login          Login to Telegram account
  auth logout         Logout from account
  auth status         Check authentication status

  accounts list       List all accounts
  accounts add        Add new account
  accounts switch     Switch active account
  accounts remove     Remove account

  contacts list       List contacts (cached, --fresh for API)
  contacts search     Search contacts
  contacts get        Get contact by ID or @username

  chats list          List dialogs (cached, --fresh for API)
  chats search        Search chats by title/username
  chats get           Get chat by ID or @username

  send                Send message to user/chat

  api                 Generic API call
```

### Global Flags

| Flag | Description |
|------|-------------|
| `--account` | Use specific account (ID, phone, or name) |
| `--fresh` | Bypass cache, fetch from API |
| `--verbose` | Detailed output |
| `--quiet` | Minimal output |

## Error Handling Strategy

1. Custom error classes with codes
2. User-friendly messages
3. JSON output option for automation
4. Exit codes for scripting

## Security Considerations

- Sessions stored locally in SQLite
- No cloud sync of credentials
- 2FA support
- Session revocation support
