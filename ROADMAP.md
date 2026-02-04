# Telegram Sync CLI Roadmap

## Vision

A complete Telegram Sync CLI client for developers and AI agents. Installable via `bun`, `npm`, `pnpm`, and eventually `homebrew`.

**Note:** Implemented features live in `README.md` and `docs/`. This roadmap tracks only **planned** and **partial** work.

## Plans Index (Pending/Partial)

The canonical plans index lives in `docs/plans/README.md`.

| Document | Description | Status |
|----------|-------------|--------|
| [multi-account.md](docs/plans/multi-account.md) | Per-account storage, labels | Partial |
| [ai-integration.md](docs/plans/ai-integration.md) | Skills, Claude Code, self-install | Partial |
| [core-infrastructure.md](docs/plans/core-infrastructure.md) | Store/config patterns | Partial |
| [groups.md](docs/plans/groups.md) | Group operations | Planning |
| [channel-tags.md](docs/plans/channel-tags.md) | Channel tagging system | Planning |

## Near-Term Milestones (Planned)

### v0.2.0 — Enhanced Sync

- Large group message sync
- Export commands (JSON, CSV)
- Deleted message detection (beyond realtime delete events)
- Scheduled sync tasks

### v0.3.0 — Media & Files

- Send/receive files
- Media download commands
- Attachment management
- Media sync to local storage

## Open Issues / Technical Debt (Unresolved)

- Ambiguous delete events can skip valid deletions (message_id collisions without chat context)
- Daemon contact sync is missing (no realtime contact updates or background contacts sync)
- No retry mechanism for failed sync jobs (backoff + max attempts)

## Future Ideas (Backlog)

- Launchd/systemd service installation
- Homebrew formula
- Message edit history
- Reaction tracking
- Interactive TUI mode
