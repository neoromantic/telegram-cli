# Multi-Account Support Plan (Remaining Work)

> **Status: Partial** - remaining items below.

This plan tracks only the multi-account work that is not implemented yet. For
current behavior, see:
- [Architecture](../architecture.md#data-layout-current)
- [CLI Commands](../cli-commands.md)
- [Configuration](../configuration.md)

## Remaining Work

### Per-Account Storage Isolation

Planned layout:

```
~/.telegram-sync-cli/
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

Follow-ups:
- Move account-specific state into the account directory.
- Add per-account cache isolation (`cache.db` per account).
- Plan a migration path from the current shared layout.

### Soft Limit Enforcement
- Enforce the soft limit of 5 accounts.

### Per-Account Downloads Directory
- Add an optional downloads directory per account.
