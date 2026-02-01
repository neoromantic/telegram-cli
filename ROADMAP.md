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
- [x] Set up Biome for linting
- [x] Set up pre-commit hooks (lint, typecheck, test)
- [x] Refactor current implementation
- [ ] Improve `--help` outputs
- [ ] Add `--verbose` / `--quiet` flags

### Phase 2: Daemon
- [x] Implement `tg daemon start/stop/status`
- [x] PID file management
- [ ] Multi-account connections (max 5)
- [x] Real-time update handling

→ [Daemon Plan](docs/plans/daemon.md)

### Phase 3: Sync & Caching ✅
- [x] Dual cursor sync (forward + backward)
- [x] Contact list caching (UsersCache)
- [x] Chat/dialog caching (ChatsCache)
- [x] Message sync with priorities
- [x] Stale-while-revalidate caching (implemented)
- [x] `--fresh` flag for cache bypass (implemented)
- [x] Lazy cache database initialization (getCacheDb())

→ [Sync Strategy](docs/plans/sync-strategy.md) | [Caching](docs/caching.md)

### Phase 4: Database ✅
- [x] Implement cache schema (users_cache, chats_cache, sync_state, rate_limits, api_activity)
- [x] Rate limit tracking (RateLimitsService with flood wait handling)
- [x] API activity logging
- [x] Generic cache service with staleness checking
- [x] Users cache service (UsersCache)
- [x] Chats cache service (ChatsCache)
- [x] Comprehensive tests (818 unit tests total)

→ [Database Schema](docs/plans/database-schema.md)

### Phase 5: Core Commands ✅
- [x] `tg contacts list/get/search` (with UsersCache)
- [x] `tg send @user "message"` (with cache-based peer resolution)
- [x] `tg chats list/get/search` (with ChatsCache)
- [x] `tg me` / `tg user @username`
- [ ] `tg status`

→ [CLI Commands](docs/plans/cli-commands.md)

### Phase 6: Multi-Account
- [x] Account add/remove/switch
- [x] Account identification (ID, @username, label)
- [ ] Per-account storage

→ [Multi-Account](docs/plans/multi-account.md)

### Phase 7: AI Integration
- [ ] `tg skill` command
- [ ] Claude Code skill file
- [ ] Self-installation command

→ [AI Integration](docs/plans/ai-integration.md)

### Phase 8: Testing & Docs
- [x] Unit testing setup (818 unit tests)
- [x] GitHub Actions CI (lint, typecheck, test, build-test)
- [x] E2E testing setup (80 E2E tests)
  - [x] CLI execution helper (`Bun.spawn`)
  - [x] Test isolation via `TELEGRAM_CLI_DATA_DIR`
  - [x] Help/format/accounts/exit-code tests
- [x] Build & distribution scripts
- **Total: 898 tests, ~85% line coverage**
- [ ] Snapshot testing setup
- [ ] Mock HTTP layer
- [ ] Integration test suite with TELEGRAM_TEST_ACCOUNT env var
- [ ] Comprehensive README

→ [Testing Guide](docs/testing.md) | [Testing Plans](docs/plans/testing.md)

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

### Implemented (docs/)

| Document | Description |
|----------|-------------|
| [testing.md](docs/testing.md) | Testing guide (unit + E2E) |
| [api-design.md](docs/api-design.md) | API philosophy, output modes, exit codes |
| [architecture.md](docs/architecture.md) | System overview |
| [auth.md](docs/auth.md) | Authentication (phone, QR code) |
| [database-schema.md](docs/database-schema.md) | Tables, indexes, schema |
| [caching.md](docs/caching.md) | Stale-while-revalidate, `--fresh` flag |

### Planned (docs/plans/)

| Document | Description |
|----------|-------------|
| [architecture.md](docs/plans/architecture.md) | Full system design, data flow |
| [daemon.md](docs/plans/daemon.md) | Background process implementation |
| [sync-strategy.md](docs/plans/sync-strategy.md) | Dual cursors, priorities, resumability |
| [multi-account.md](docs/plans/multi-account.md) | Account management, identification |
| [cli-commands.md](docs/plans/cli-commands.md) | All commands, flags, output formats |
| [rate-limiting.md](docs/plans/rate-limiting.md) | FLOOD_WAIT, backoff, `tg status` |
| [ai-integration.md](docs/plans/ai-integration.md) | Skills, self-install, Claude Code |
| [configuration.md](docs/plans/configuration.md) | config.json, env vars, defaults |
| [testing.md](docs/plans/testing.md) | Integration tests (planned) |
