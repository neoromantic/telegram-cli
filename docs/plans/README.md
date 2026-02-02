# Implementation Plans

This directory contains detailed implementation plans for telegram-cli features.

> **For implemented features documentation**, see [../](../) (docs/ directory).

## Document Index

### Core Architecture

| Document | Description | Status |
|----------|-------------|--------|
| [architecture.md](./architecture.md) | Full system design, CLI/Daemon modes, data flow | Planning |
| [daemon.md](./daemon.md) | Background sync process, lifecycle, multi-account | Planning |
| [sync-strategy.md](./sync-strategy.md) | Dual cursors, priorities, real-time + backfill | Planning |

### Features

| Document | Description | Status |
|----------|-------------|--------|
| [cli-commands.md](./cli-commands.md) | CLI commands: auth, accounts, contacts, chats, send | **Implemented** |
| [contacts.md](./contacts.md) | Contact management with caching | **Implemented** |
| [multi-account.md](./multi-account.md) | Per-account storage, labels | Partial |
| [rate-limiting.md](./rate-limiting.md) | FLOOD_WAIT handling, `tg status` | Partial |
| [ai-integration.md](./ai-integration.md) | Skills, Claude Code, self-install | Planning |
| [configuration.md](./configuration.md) | config.json, env vars, defaults | Planning |
| [build-distribution.md](./build-distribution.md) | Publishing, releases, homebrew | **Implemented** |
| [testing.md](./testing.md) | Unit + E2E tests | **Implemented** |
| [../sql.md](../sql.md) | SQL command (read-only cache access) | **Implemented** |
| [real-time.md](./real-time.md) | Real-time event handlers | **Implemented** |

### Future Features

| Document | Description | Status |
|----------|-------------|--------|
| [search.md](./search.md) | FTS5 full-text search | Planning |
| [groups.md](./groups.md) | Group operations | Planning |
| [channel-tags.md](./channel-tags.md) | Channel tagging system | Planning |
| [core-infrastructure.md](./core-infrastructure.md) | Store/config patterns | Partial |

## Recently Implemented

### Caching System (see [../caching.md](../caching.md))
- `UsersCache` - User/contact caching with stale-while-revalidate
- `ChatsCache` - Dialog/chat caching with filtering
- Lazy database initialization via `getCacheDb()`
- `--fresh` flag for bypassing cache

### Commands
- `tg contacts list/search/get` - With UsersCache
- `tg chats list/search/get` - With ChatsCache
- `tg send` - With cache-based peer resolution

## Architecture Summary

```
┌─────────────────────────────────────────────────────────────┐
│                     CLI Mode (tg <cmd>)                     │
│  Query cache → On-demand fetch → Mutations                  │
└─────────────────────────────────────────────────────────────┘
        │                                       │
        │ reads/writes                          │ direct API
        ▼                                       ▼
┌──────────────────────┐              ┌──────────────────────┐
│   SQLite (WAL)       │              │    Telegram API      │
│   per account        │              └──────────────────────┘
└──────────────────────┘                        ▲
        ▲                                       │
        │ writes                                │ real-time
        │                                       │
┌─────────────────────────────────────────────────────────────┐
│                  Daemon Mode (tg daemon start)              │
│  Real-time sync → Backfill history → READ-ONLY to Telegram  │
└─────────────────────────────────────────────────────────────┘
```

## Key Principles

1. **Same binary, two modes** — `tg` for commands, `tg daemon start` for background sync
2. **CLI works without daemon** — Uses cache, fetches on-demand when needed
3. **Daemon is read-only** — Never sends messages or performs mutations
4. **Stale-while-revalidate** — Return cached data immediately, refresh in background
5. **Dual cursors** — Forward (real-time) + backward (history backfill)
6. **Per-account isolation** — Separate databases, sessions, configs

## Sync Priorities

| Priority | Scope | Behavior |
|----------|-------|----------|
| P0 | Real-time | Immediate sync when daemon running |
| P1 | DMs + small groups (<20) | Full message history |
| P2 | Medium groups (20-100) | Last 10 msgs, then gradual |
| P3 | Large groups (>100) / channels | On explicit request only |

## Reading Order

1. **Start with [architecture.md](./architecture.md)** — Understand the overall system
2. **Then [daemon.md](./daemon.md)** — How background sync works
3. **Then [sync-strategy.md](./sync-strategy.md)** — Cursor management, priorities
4. **Then [cli-commands.md](./cli-commands.md)** — What users can do
