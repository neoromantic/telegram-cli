# Core Infrastructure (Plan)

> **Status: Partial**
>
> This document summarizes the core infrastructure as implemented and outlines planned improvements.

## Current Core Modules

### Data & Paths

- `src/db/index.ts`
  - `getDataDir()` uses `TELEGRAM_CLI_DATA_DIR ?? ~/.telegram-cli`
  - `data.db` stores accounts
  - `cache.db` stores cache + sync tables
- `src/config/index.ts`
  - `config.json` stores app-wide settings (active account, cache TTLs)

### Telegram Client

- `src/services/telegram.ts`
  - Reads `TELEGRAM_API_ID` / `TELEGRAM_API_HASH`
  - Creates mtcute clients per account
  - Session file: `session_<id>.db`

### Daemon Runtime

- `src/daemon/*`
  - Daemon lifecycle and PID file (`daemon.pid`)
  - Update handlers + sync scheduler
  - Message sync jobs in `sync_jobs`

## Current Storage Layout

```
~/.telegram-cli/
├── data.db
├── cache.db
├── session_<id>.db
├── daemon.pid
└── config.json
```

## Planned Improvements

- Per-account directories (`accounts/<id>/...`)
- Optional downloads directory per account
- Richer account labels / selectors

## Notes

Earlier versions of this plan included Node/TDLib/MCP-specific examples. Those are **not** part of the current implementation.
