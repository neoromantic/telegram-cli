# AI Integration Plan

> **Status: Planning**
>
> This document describes how the CLI should integrate with AI agents (skills, automation, predictable outputs). It also records the current capabilities so agent tooling can be built safely.

## Goals

- **Agent-friendly**: stable JSON output by default
- **Composable**: CLI can be called from tools and scripts
- **Discoverable**: skills manifest for auto-install
- **Safe**: read-only operations are explicit; mutations are clear

## Current Capabilities

### Output Contract (Implemented)

All commands return a consistent JSON wrapper:

```json
{
  "success": true,
  "data": { ... }
}
```

Errors:

```json
{
  "success": false,
  "error": { "code": "INVALID_ARGS", "message": "..." }
}
```

Output modes:
- `--format json` (default)
- `--format pretty`
- `--format quiet` (or `--quiet`)

### Core Commands (Implemented)

- `tg auth login` / `tg auth login-qr` / `tg auth logout` / `tg auth status`
- `tg accounts list|switch|remove|info`
- `tg contacts list|search|get` (cache + `--fresh`)
- `tg chats list|search|get` (search is cache-only; get supports @username)
- `tg send` (mutations)
- `tg api` (raw Telegram methods)
- `tg status`, `tg daemon`, `tg sql`

### Data Access for Agents

- Use `tg sql` for read-only cache queries
- Use `tg api` for advanced Telegram calls not wrapped by CLI

## Planned Additions

### Skill Installation

Introduce `tg skill` subcommand to:
- install agent skill manifests
- validate environment
- verify connectivity

### Message History Commands (Planned)

- `tg messages list` (history per chat)
- `tg messages search` (full-text, once FTS5 lands)

> These are not implemented yet. For now use `tg chats list` + `tg api messages.getHistory`.

### Interactive Mode (Planned)

- `tg interactive` to keep a single session open for a batch of commands

## Skill Manifest (Planned)

Suggested fields (example):

```json
{
  "name": "telegram-cli",
  "description": "Agent-friendly Telegram CLI",
  "install_command": "bun install -g telegram-cli",
  "entrypoint": "tg",
  "version": "0.1.0",
  "output": "json"
}
```

## Environment Variables

Implemented today:

| Variable | Purpose |
|----------|---------|
| `TELEGRAM_API_ID` | Telegram API ID |
| `TELEGRAM_API_HASH` | Telegram API hash |
| `TELEGRAM_CLI_DATA_DIR` | Override data directory |
| `MTCUTE_LOG_LEVEL` | mtcute log level |
| `VERBOSE` | Verbose logging (`1`) |

## Paths

Default data directory: `~/.telegram-cli` (override with `TELEGRAM_CLI_DATA_DIR`).

Planned config path:
- `~/.telegram-cli/config.json`

## Safety / Permissions

- CLI performs mutations (send/edit/delete)
- Daemon is **read-only** to Telegram
- `tg sql` is **read-only** to local DB

## Implementation References

- `src/utils/output.ts` — JSON wrapper
- `src/commands/` — command implementations
- `docs/api-design.md` — output semantics and examples
