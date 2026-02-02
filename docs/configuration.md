# Configuration

> **Status: Implemented (v0.1.0)** — current configuration system for telegram-cli.

## Overview

The CLI supports an optional JSON config file for app-wide settings such as
active account selection and cache TTLs. Environment variables remain the
source of truth for Telegram API credentials.

## Storage Layout

Default data directory: `~/.telegram-cli` (override with `TELEGRAM_CLI_DATA_DIR`).

```
~/.telegram-cli/
├── data.db            # Accounts table
├── cache.db           # Cache + sync tables
├── session_<id>.db    # mtcute session per account
├── daemon.pid         # PID file when daemon is running
└── config.json        # User config
```

## Configuration File

**Path:** `<dataDir>/config.json` where `dataDir` is `TELEGRAM_CLI_DATA_DIR` or
`~/.telegram-cli`.

Supported keys:

- `activeAccount` (number)
- `cache.staleness.peers` (duration)
- `cache.staleness.dialogs` (duration)
- `cache.staleness.fullInfo` (duration)
- `cache.backgroundRefresh` (boolean)
- `cache.maxCacheAge` (duration)

Duration format: `<number><unit>` with units `s`, `m`, `h`, `d`, `w`
(case-insensitive). Values are normalized to lowercase (e.g., `7D` → `7d`).

Example:

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
  }
}
```

Unknown keys are ignored. Invalid values produce errors when running commands
that require strict config validation.

## CLI Commands

```bash
tg config path
tg config get <key>
tg config set <key> <value>
```

Examples:

```bash
tg config get cache.staleness.peers
tg config set cache.staleness.peers 3d
tg config set activeAccount 2
```

## Runtime Behavior

- On startup (except for `tg config`), the CLI reads `activeAccount` and switches
  the active account if it exists.
- Cache-related commands resolve TTLs via `config.json` overrides.
- Config errors are surfaced as `INVALID_ARGS` with issue details.

## Validation

- `TELEGRAM_API_ID` and `TELEGRAM_API_HASH` are required.
- Missing credentials fail fast with actionable errors.

## Security

- Treat `session_<id>.db`, `data.db`, and `cache.db` as sensitive.
- Do not embed API credentials in compiled binaries.
