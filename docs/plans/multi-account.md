# Multi-Account Support Plan

> **Status:** Partial
>
> Multi-account commands and account selectors are implemented. Per-account storage is still planned.

## Current Behavior

- Multiple accounts can be stored and switched
- Accounts can be labeled and identified by ID, @username, or label
- Labels are persisted in `data.db` and surfaced in `tg accounts list/info`
- Sessions are stored as `session_<id>.db`
- Accounts are stored in `data.db`
- Cache/sync data is stored in shared `cache.db`

## Constraints

- **Soft limit**: 5 accounts (planned enforcement)
- **Identification**: numeric IDs, `@username`, or labels

## Account Identification

### Current (Implemented)

```bash
tg accounts list
tg accounts switch --id 1

# Per-command override
tg contacts list --account 2
tg contacts list --account @username
tg contacts list --account "Work"
```

Notes:
- `--account` selectors accept **ID**, **@username**, or **label**
- Labels are stored on login (`--label` for phone, `--name` for QR)

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
- Optional per-account downloads directory
