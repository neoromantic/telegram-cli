# AI Integration Plan

> **Status: Partial (skill commands implemented; Claude Code skill pending)**
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

### Skill Commands (Implemented)

The `tg skill` subcommand provides a minimal, agent-friendly surface:
- `tg skill manifest` — print the skill manifest JSON
- `tg skill validate` — validate environment + data directory access (no network calls)
- `tg skill install` — write the manifest to the default path and return metadata

Connectivity verification is still planned.

## Planned Additions

### Claude Code Skill File (Planned)

- Provide a Claude Code skill descriptor for auto-installation

### Message History Commands

- `tg messages list` (history per chat) — **Planned**
- `tg messages search` (full-text) — **Implemented**

> For history listing, use `tg chats list` + `tg api messages.getHistory` until `tg messages list` lands.

### Interactive Mode (Planned)

- `tg interactive` to keep a single session open for a batch of commands

## Skill Manifest (Implemented)

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

Default manifest path:
- `~/.telegram-cli/skill.json` (or `TELEGRAM_CLI_DATA_DIR` override)

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
