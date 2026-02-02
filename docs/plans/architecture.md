# Telegram CLI Architecture

> **Status: Implemented (v0.1.0)**
>
> This plan now reflects the current architecture. For the live spec, see `docs/architecture.md`.

## Overview

Telegram CLI is a single binary that operates in two modes:

1. **CLI Mode** — short-lived command execution (runs, completes, exits)
2. **Daemon Mode** — long-running background sync and realtime updates

Both modes share the same cache/sync database (`cache.db`) using WAL for safe concurrent access.

---

## Architecture Diagram (Current)

```
┌─────────────────────────────────────────────────────────┐
│                 Telegram Servers (MTProto)               │
└─────────────────────────────────────────────────────────┘
          ▲                                      │
          │ API calls (mutations, queries)       │ Updates
          │                                      ▼
┌────────────────────────────┐        ┌────────────────────────────┐
│        CLI Mode (tg)        │        │      Daemon Mode (tg)       │
│  - Citty command parser     │        │  - mtcute connections       │
│  - Cache read/write         │        │  - realtime handlers        │
│  - Mutations                │        │  - sync job scheduler        │
└──────────────┬─────────────┘        └──────────────┬─────────────┘
               │                                     │
               └──────────────┬──────────────────────┘
                              ▼
                      SQLite (WAL mode)
                       data.db / cache.db
```

---

## Data Layout (Current)

Default data directory: `~/.telegram-cli` (override with `TELEGRAM_CLI_DATA_DIR`).

```
~/.telegram-cli/
├── data.db            # accounts
├── cache.db           # cache + sync tables
├── session_<id>.db    # mtcute session per account
└── daemon.pid         # daemon PID when running
```

> **Planned:** per-account subdirectories (see `docs/plans/multi-account.md`).

---

## Responsibilities

### CLI Mode
- Executes commands
- Reads cache first, fetches from API when needed (`--fresh`)
- Performs all **mutations** (send/edit/delete)

### Daemon Mode
- Maintains MTProto connections
- Handles realtime updates (new/edit/delete messages)
- Runs background sync jobs (forward catchup + backfill)
- **Read-only** to Telegram

---

## Key Modules

- `src/commands/` — CLI commands
- `src/daemon/` — daemon lifecycle, handlers, scheduler, workers
- `src/db/` — schema, cache services, sync state, jobs
- `src/services/` — Telegram client manager

---

## References

- `docs/architecture.md` — current spec
- `docs/database-schema.md` — tables and indexes
- `docs/plans/sync-strategy.md` — sync job strategy
