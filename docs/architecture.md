# Architecture Documentation

## Overview

telegram-cli is a command-line utility for interacting with Telegram's full API. It's designed for:
- Agent-friendly automation
- Multi-account support
- Non-interactive command execution

## Technology Stack

| Component | Choice | Rationale |
|-----------|--------|-----------|
| Runtime | Bun | Native SQLite, fast startup, TypeScript-first |
| Language | TypeScript | Type safety, better DX |
| Telegram | mtcute | Modern, Bun support, TypeScript-first |
| CLI | Citty | Lightweight, TypeScript-first |
| Storage | bun:sqlite | Native, zero deps |

## Core Components

### 1. CLI Layer (`src/commands/`)
- Uses Citty for command parsing
- Each command is a separate module
- Commands delegate to services

### 2. Service Layer (`src/services/`)
- Business logic
- Telegram client management
- State coordination

### 3. Database Layer (`src/db/`)
- SQLite via bun:sqlite
- Session storage
- Account metadata

## Data Flow

```
User Input → CLI Parser → Command → Service → Telegram API
                                      ↓
                                   Database
```

## Database Schema

### accounts
```sql
CREATE TABLE accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT UNIQUE NOT NULL,
  name TEXT,
  session_data TEXT NOT NULL,
  is_active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
```

### contacts_cache
```sql
CREATE TABLE contacts_cache (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  first_name TEXT,
  last_name TEXT,
  username TEXT,
  phone TEXT,
  cached_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (account_id) REFERENCES accounts(id)
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
  accounts list       List all accounts
  accounts switch     Switch active account
  contacts list       List contacts (paginated)
  contacts search     Search contacts
```

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
