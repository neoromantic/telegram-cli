# Configuration Plan

> **Status: Planning**
>
> The project is currently environment-driven; no config file loader or `tg config` command exists yet.

## Current Behavior (Implemented)

### Environment Variables

| Variable | Purpose |
|----------|---------|
| `TELEGRAM_API_ID` | Telegram API ID (required) |
| `TELEGRAM_API_HASH` | Telegram API hash (required) |
| `TELEGRAM_CLI_DATA_DIR` | Override data directory |
| `MTCUTE_LOG_LEVEL` | mtcute log level |
| `VERBOSE` | Verbose logging (`1`) |

### Storage Layout

```
~/.telegram-cli/
├── data.db            # accounts table
├── cache.db           # cache + sync tables
├── session_<id>.db    # mtcute session per account
├── daemon.pid         # daemon PID when running
└── config.json        # planned (not read today)
```

Accounts are stored in the `accounts` table inside `data.db`.

## Planned Configuration File

### Global Configuration

- **Path**: `~/.telegram-cli/config.json`
- **Purpose**: app-wide settings shared across all accounts

Example (planned):

```json
{
  "activeAccount": 1,
  "cache": {
    "staleness": {
      "peers": "7d",
      "dialogs": "1h",
      "fullInfo": "7d"
    },
    "backgroundRefresh": true,
    "maxCacheAge": "30d"
  },
  "daemon": {
    "verbosity": "normal"
  }
}
```

> These fields are not read at runtime yet. Defaults are defined in `src/db/types.ts`.

## Planned CLI Integration

- `tg config get <key>`
- `tg config set <key> <value>`
- `tg config path`

## Validation

- Validate required fields (`TELEGRAM_API_ID`, `TELEGRAM_API_HASH`) on startup
- Report missing config with actionable errors

## Security

- Treat `session_<id>.db`, `data.db`, and `cache.db` as sensitive
- Never embed API credentials in compiled binaries
