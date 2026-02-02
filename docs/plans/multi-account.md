# Multi-Account Support Plan

> **Status:** Partial
>
> Core multi-account commands exist, but per-account storage and richer identifiers are still planned.

## Current Behavior

- Multiple accounts can be stored and switched
- Sessions are stored as `session_<id>.db`
- Accounts are stored in `data.db`
- Cache/sync data is stored in shared `cache.db`

## Constraints

- **Soft limit**: 5 accounts (planned enforcement)
- **Identification**: numeric account IDs only (current)

## Account Identification

### Current (Implemented)

```bash
tg accounts list
tg accounts switch --id 1

# Per-command override
tg contacts list --account 2
```

### Planned

- `--account @username`
- `--account "Work"` (custom label)
- Phone/label selectors

## Storage Layout

### Current

```
~/.telegram-cli/
├── data.db
├── cache.db
├── session_<id>.db
└── daemon.pid
```

### Planned (Per-Account Isolation)

```
~/.telegram-cli/
├── accounts/
│   ├── 1/
│   │   ├── session.db
│   │   ├── data.db
│   │   └── meta.json
│   └── 2/
│       ├── session.db
│       ├── data.db
│       └── meta.json
└── daemon.pid
```

## CLI Commands (Implemented)

- `tg accounts list`
- `tg accounts switch --id <id>`
- `tg accounts remove --id <id>`
- `tg accounts info --id <id>`

New accounts are added via:
- `tg auth login --phone ...`
- `tg auth login-qr`

## Planned Enhancements

- Per-account cache isolation (separate `cache.db` per account)
- Human-friendly labels for accounts
- `--account` selectors by username/label
- Optional per-account downloads directory
