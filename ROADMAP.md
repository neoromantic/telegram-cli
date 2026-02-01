# Telegram CLI Roadmap

## Vision

A complete Telegram CLI client for developers and AI agents. Installable via `bun`, `npm`, `pnpm`, and eventually `homebrew`.

## Architecture

**Same binary, two modes:**
- `tg <command>` — CLI mode: execute and exit
- `tg daemon start` — Daemon mode: long-running background sync

→ [Full Architecture](docs/plans/architecture.md)

## v0.1.0 — Foundation

**Goal:** Working CLI with daemon architecture, contact sync, basic messaging.

### Phase 1: Code Quality
- [ ] Set up Biome for linting
- [ ] Set up pre-commit hooks (lint, typecheck, test)
- [ ] Refactor current implementation
- [ ] Improve `--help` outputs
- [ ] Add `--verbose` / `--quiet` flags

### Phase 2: Daemon
- [ ] Implement `tg daemon start/stop/status`
- [ ] PID file management
- [ ] Multi-account connections (max 5)
- [ ] Real-time update handling

→ [Daemon Plan](docs/plans/daemon.md)

### Phase 3: Sync & Caching
- [ ] Dual cursor sync (forward + backward)
- [ ] Contact list sync
- [ ] Message sync with priorities
- [ ] Stale-while-revalidate caching
- [ ] `--fresh` flag for cache bypass

→ [Sync Strategy](docs/plans/sync-strategy.md) | [Caching](docs/plans/caching.md)

### Phase 4: Database
- [ ] Implement cache schema
- [ ] Rate limit tracking
- [ ] API activity logging

→ [Database Schema](docs/plans/database-schema.md)

### Phase 5: Core Commands
- [ ] `tg contacts list/get/search`
- [ ] `tg send @user "message"`
- [ ] `tg chats list`
- [ ] `tg me` / `tg user @username`
- [ ] `tg status`

→ [CLI Commands](docs/plans/cli-commands.md)

### Phase 6: Multi-Account
- [ ] Account add/remove/switch
- [ ] Account identification (ID, @username, label)
- [ ] Per-account storage

→ [Multi-Account](docs/plans/multi-account.md)

### Phase 7: AI Integration
- [ ] `tg skill` command
- [ ] Claude Code skill file
- [ ] Self-installation command

→ [AI Integration](docs/plans/ai-integration.md)

### Phase 8: Testing & Docs
- [ ] Snapshot testing setup
- [ ] Mock HTTP layer
- [ ] Comprehensive README
- [ ] GitHub Actions CI

---

## v0.2.0 — Enhanced Sync

- [ ] Large group message sync
- [ ] Full-text search (FTS5)
- [ ] Export commands (JSON, CSV)
- [ ] Deleted message detection
- [ ] Scheduled sync tasks

---

## v0.3.0 — Media & Files

- [ ] Send/receive files
- [ ] Media download commands
- [ ] Attachment management
- [ ] Media sync to local storage

---

## Future Ideas

- [ ] Launchd/systemd service installation
- [ ] Homebrew formula
- [ ] Message edit history
- [ ] Reaction tracking
- [ ] Interactive TUI mode

---

## Key Decisions

| Decision | Choice |
|----------|--------|
| Daemon startup | Manual `tg daemon start`, foreground |
| Daemon scope | Single daemon, all accounts (max 5) |
| CLI without daemon | Works standalone with caching |
| Database | Separate per account, parallel to mtcute |
| Message staleness | Eternal |
| Peer staleness | 1 week default |
| On-demand fetch | Stale-while-revalidate + `--fresh` |
| Account ID | Numeric, @username, or custom label |
| Config format | JSON |

→ [Configuration](docs/plans/configuration.md) | [Rate Limiting](docs/plans/rate-limiting.md)

---

## Sync Priorities

1. **P0:** Real-time messages (daemon running)
2. **P1:** DMs + groups <20 members (full sync)
3. **P2:** Other chats (last 10 messages, then gradual)
4. **P3:** Large groups >100 / channels (on request only)

→ [Sync Strategy](docs/plans/sync-strategy.md)

---

## Documentation Index

| Document | Description |
|----------|-------------|
| [architecture.md](docs/plans/architecture.md) | System design, data flow, components |
| [daemon.md](docs/plans/daemon.md) | Background process implementation |
| [sync-strategy.md](docs/plans/sync-strategy.md) | Dual cursors, priorities, resumability |
| [caching.md](docs/plans/caching.md) | Stale-while-revalidate, `--fresh` flag |
| [database-schema.md](docs/plans/database-schema.md) | Tables, indexes, schema |
| [multi-account.md](docs/plans/multi-account.md) | Account management, identification |
| [cli-commands.md](docs/plans/cli-commands.md) | All commands, flags, output formats |
| [rate-limiting.md](docs/plans/rate-limiting.md) | FLOOD_WAIT, backoff, `tg status` |
| [ai-integration.md](docs/plans/ai-integration.md) | Skills, self-install, Claude Code |
| [configuration.md](docs/plans/configuration.md) | config.json, env vars, defaults |
