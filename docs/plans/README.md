# Implementation Plans

This directory contains detailed implementation plans for telegram-cli features.

## Document Index

| Document | Description | Priority |
|----------|-------------|----------|
| [architecture.md](./architecture.md) | System design, CLI/Daemon modes, data flow | Critical |
| [daemon.md](./daemon.md) | Background sync process, lifecycle, multi-account | Critical |
| [sync-strategy.md](./sync-strategy.md) | Dual cursors, priorities, real-time + backfill | Critical |
| [caching.md](./caching.md) | Stale-while-revalidate, `--fresh` flag | High |
| [database-schema.md](./database-schema.md) | Tables, indexes, per-account storage | High |
| [multi-account.md](./multi-account.md) | Account management, identification | High |
| [cli-commands.md](./cli-commands.md) | All commands, flags, output formats | High |
| [rate-limiting.md](./rate-limiting.md) | FLOOD_WAIT handling, `tg status` | Medium |
| [ai-integration.md](./ai-integration.md) | Skills, Claude Code, self-install | Medium |
| [configuration.md](./configuration.md) | config.json, env vars, defaults | Medium |

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

## Legacy Documents

The following documents contain **inspiration from telegram-mcp-server** and should be updated or replaced:

- `auth.md` — Auth patterns (needs update for QR login)
- `database.md` — Old schema (replaced by database-schema.md)
- `message-sync.md` — Old sync patterns (replaced by sync-strategy.md)
- `telegram-client.md` — Client wrapper patterns
- `core-infrastructure.md` — Store/config patterns
- `search.md` — FTS5 patterns (future feature)
- `contacts.md` — Contact management
- `groups.md` — Group operations
- `real-time.md` — Real-time handlers
- `channel-tags.md` — Channel tagging (future feature)

These will be consolidated or removed as we implement our own solutions.
