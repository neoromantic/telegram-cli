# Telegram CLI - Development Guidelines

## Quick Reference

```bash
# Run CLI
bun run src/index.ts <command>

# Run tests
bun test

# Type check (fast, using tsgo)
bun run typecheck

# Type check (fallback to tsc if tsgo has issues)
bun run typecheck:tsc

# Lint (check only)
bun run lint

# Lint and auto-fix
bun run lint:fix

# Format
bun run format
```

---

## Git Hooks (Automated)

Pre-commit hooks run automatically via **lefthook**:
1. `bun run lint:fix` — Auto-fixes linting issues
2. `bun run typecheck` — Type checks with tsgo

If hooks fail, fix the errors and commit again. To skip hooks (emergency only):
```bash
git commit --no-verify -m "message"
```

---

## CI Pipeline

GitHub Actions runs on every push to `main` and on all PRs:

| Job | What it does | Timeout |
|-----|--------------|---------|
| **lint** | `bun run lint` (Biome) | 5 min |
| **typecheck** | `bun run typecheck:tsc` | 5 min |
| **test** | `bun test` | 10 min |

All jobs run in parallel with Bun dependency caching. See `.github/workflows/ci.yml`.

---

## ⚠️ CRITICAL Rules

### Documentation
- **Update docs/plans/*.md** when implementing features
- **Update ROADMAP.md** when completing phases
- **Update CLAUDE.md Tech Stack table** when adding/changing dev tools (linters, typecheckers, CI, git hooks, etc.)
- **Update CLAUDE.md sections** when adding infrastructure (CI pipelines, git hooks, deployment configs)
- **Never implement without reading the relevant plan first**

### Architecture
- **CLI and Daemon are the same binary** — different entry modes
- **Daemon is READ-ONLY** — never sends messages, edits, or performs mutations
- **CLI handles all mutations** — send, edit, delete, create groups
- **Separate database per account** — don't mix account data
- **Don't modify mtcute internals** — create parallel tables

### Data
- **Messages are eternal** — never considered stale
- **Peers expire in 1 week** — contacts, groups, channels
- **Always store raw_json** — for future-proofing
- **Use fetched_at timestamps** — on all cached entities

---

## Tech Stack

| Component | Choice | Rationale |
|-----------|--------|-----------|
| Runtime | Bun | Native SQLite, fast startup, TS support |
| Language | TypeScript | Strict mode, full type safety |
| Telegram | mtcute (`@mtcute/bun`) | TypeScript-first, Bun support, `client.call()` |
| CLI | Citty | TypeScript-first, ES modules, lightweight |
| Database | bun:sqlite | Native, zero deps, WAL mode |
| Linting | Biome | Fast, all-in-one |
| Type Checker | tsgo | 10x faster than tsc, Go-based |
| Git Hooks | lefthook | Simple, parallel execution |
| CI | GitHub Actions | Lint, typecheck, test on PRs and main |

---

## Bun-Native APIs (Always Prefer)

```typescript
// ✅ Correct
import { Database } from 'bun:sqlite'
const file = Bun.file('path.json')
await Bun.write('file.txt', content)
const result = await Bun.$`git status`

// ❌ Wrong
import sqlite3 from 'better-sqlite3'
import { readFile } from 'node:fs/promises'
import { exec } from 'child_process'
```

- `bun:sqlite` — NOT better-sqlite3
- `Bun.file()` — NOT fs.readFile
- `Bun.write()` — NOT fs.writeFile
- `Bun.$` — NOT execa or child_process
- Bun auto-loads `.env` — NO dotenv needed

---

## Architecture Overview

```
CLI Mode (tg <cmd>)           Daemon Mode (tg daemon start)
        │                              │
        ▼                              ▼
┌───────────────┐              ┌───────────────┐
│ Query cache   │              │ Real-time     │
│ On-demand API │              │ updates       │
│ Mutations     │              │ Backfill      │
└───────┬───────┘              └───────┬───────┘
        │                              │
        ▼                              ▼
    SQLite (WAL mode) ◄────────────────┘
    Per-account DBs
```

### Daemon Responsibilities (READ-ONLY)
- Maintain MTProto connections (max 5 accounts)
- Receive real-time updates
- Background history sync
- Rate limit handling

### CLI Responsibilities (MUTATIONS)
- Send messages
- Edit messages
- Create/edit groups
- Query cached data
- On-demand API fetches

---

## Sync Strategy

### Two Cursors Per Chat
1. **Forward cursor** — Real-time updates, catches up on restart
2. **Backward cursor** — History backfill, older messages

### Priorities
| P | Scope | Sync |
|---|-------|------|
| 0 | Real-time | Immediate when daemon runs |
| 1 | DMs + groups <20 | Full history |
| 2 | Groups 20-100 | Last 10, then gradual |
| 3 | Groups >100 / channels | On request only |

---

## Code Patterns

### Command Structure
```typescript
import { defineCommand } from 'citty'
import { success, error } from '../utils/output'

export const myCommand = defineCommand({
  meta: {
    name: 'my-command',
    description: 'What it does'
  },
  args: {
    param: {
      type: 'string',
      description: 'Parameter description',
      required: true
    },
    fresh: {
      type: 'boolean',
      description: 'Bypass cache',
      default: false
    }
  },
  async run({ args }) {
    try {
      const result = await doSomething(args.param, { fresh: args.fresh })
      success({ data: result })
    } catch (err) {
      error('OPERATION_FAILED', err.message)
    }
  }
})
```

### Database Pattern
```typescript
import { Database } from 'bun:sqlite'

class ContactRow {
  user_id!: number
  first_name!: string
  username!: string | null
  fetched_at!: number
  raw_json!: string
}

const db = new Database('data.db')
db.run('PRAGMA journal_mode = WAL')

const stmt = db.query(`
  SELECT * FROM contacts_cache
  WHERE username = $username
`).as(ContactRow)

const contact = stmt.get({ $username: 'someone' })
```

### Cache Check Pattern
```typescript
async function getUser(username: string, opts: { fresh?: boolean } = {}) {
  // 1. Check cache first (unless --fresh)
  if (!opts.fresh) {
    const cached = db.query('SELECT * FROM users_cache WHERE username = $u')
      .get({ $u: username })

    if (cached) {
      // Trigger background refresh if stale
      if (isStale(cached.fetched_at, PEER_TTL)) {
        queueBackgroundRefresh('user', username)
      }
      return JSON.parse(cached.raw_json)
    }
  }

  // 2. Fetch from API
  const user = await client.call({ _: 'users.getUsers', id: [username] })

  // 3. Cache response
  db.run(`
    INSERT OR REPLACE INTO users_cache (user_id, username, raw_json, fetched_at)
    VALUES ($id, $username, $json, $now)
  `, { $id: user.id, $username: username, $json: JSON.stringify(user), $now: Date.now() })

  return user
}
```

### Telegram Client Pattern
```typescript
import { TelegramClient } from '@mtcute/bun'

const client = new TelegramClient({
  apiId: API_ID,
  apiHash: API_HASH,
  storage: sessionPath,  // mtcute handles persistence
  logLevel: 2
})

// High-level methods
await client.start({ phone, code, password })
await client.signInQr({ onUrlUpdated, password })
const me = await client.getMe()

// Raw API calls (any Telegram method)
const result = await client.call({
  _: 'contacts.getContacts',
  hash: 0n  // Use BigInt for Long types
} as any)

// Iterate dialogs
for await (const dialog of client.iterDialogs({ limit: 100 })) {
  console.log(dialog.peer)
}
```

---

## File Structure

```
~/.telegram-cli/
├── config.json           # Global config
├── daemon.pid            # PID when daemon running
└── accounts/
    └── 1/
        ├── session.db    # mtcute session (DON'T TOUCH)
        ├── data.db       # Our cache tables
        └── meta.json     # Account metadata

src/
├── index.ts              # CLI entry point
├── commands/
│   ├── auth.ts           # login, logout, status
│   ├── accounts.ts       # list, add, switch, remove
│   ├── contacts.ts       # list, get, search
│   ├── send.ts           # send messages
│   ├── chats.ts          # list dialogs
│   ├── daemon.ts         # start, stop, status
│   ├── api.ts            # generic API command
│   └── status.ts         # sync status, rate limits
├── services/
│   ├── telegram.ts       # Client manager
│   ├── cache.ts          # Cache operations
│   └── sync.ts           # Sync logic
├── db/
│   └── index.ts          # Database setup
├── daemon/
│   ├── index.ts          # Daemon entry
│   ├── sync.ts           # Sync workers
│   └── handlers.ts       # Update handlers
├── types/
│   └── index.ts          # TypeScript types
└── utils/
    ├── output.ts         # JSON/pretty output
    └── config.ts         # Config loading
```

---

## Testing Strategy

### Unit Tests (Offline)
- Mock mtcute client
- Test cache logic
- Test command parsing
- Test output formatting

### Integration Tests (Online)
- Use test account: @usualguy
- Credentials in `.env`
- Snapshot responses for offline replay

```typescript
// Example test
import { describe, it, expect, mock } from 'bun:test'

describe('contacts list', () => {
  it('returns cached contacts', async () => {
    // Mock database
    const mockDb = mock(() => [{ user_id: 1, first_name: 'Test' }])

    const result = await listContacts({ limit: 10 })

    expect(result.items).toHaveLength(1)
  })
})
```

---

## CLI UX Guidelines

### Help Output
```
tg <command> [options]

Commands:
  auth        Authentication (login, logout, status)
  accounts    Account management
  contacts    Contact operations
  send        Send messages
  chats       List dialogs
  daemon      Background sync
  status      Show sync status
  api         Raw API calls
  skill       AI integration

Global Options:
  --account   Use specific account (ID, @username, or label)
  --format    Output format (json, table)
  --fresh     Bypass cache, fetch from API
  --verbose   Detailed output
  --quiet     Minimal output
  --help      Show help
```

### Error Output
```json
{
  "success": false,
  "error": {
    "code": "RATE_LIMITED",
    "message": "Too many requests",
    "details": { "wait": 30 },
    "suggestion": "Wait 30 seconds or use --account to switch"
  }
}
```

---

## Common Mistakes to Avoid

1. **Don't use Node.js APIs** when Bun equivalents exist
2. **Don't modify mtcute's session.db** — it handles its own storage
3. **Don't sync large groups by default** — only on explicit request
4. **Don't block on stale data** — return cached, refresh in background
5. **Don't forget BigInt** for Telegram Long types (hash, accessHash)
6. **Don't hardcode staleness** — use configurable TTLs

---

## Key Decisions Reference

| Decision | Choice |
|----------|--------|
| Daemon startup | Manual, foreground (`tg daemon start`) |
| Max accounts | 5 |
| Message staleness | Eternal |
| Peer staleness | 1 week |
| On-demand fetch | Stale-while-revalidate + `--fresh` |
| Account ID | Numeric, @username, or custom label |
| Config format | JSON |
| Database | Separate per account |

---

## Documentation Links

- [Architecture](docs/plans/architecture.md)
- [Daemon](docs/plans/daemon.md)
- [Sync Strategy](docs/plans/sync-strategy.md)
- [Caching](docs/plans/caching.md)
- [Database Schema](docs/plans/database-schema.md)
- [CLI Commands](docs/plans/cli-commands.md)
- [Rate Limiting](docs/plans/rate-limiting.md)
- [AI Integration](docs/plans/ai-integration.md)
- [Configuration](docs/plans/configuration.md)
- [Multi-Account](docs/plans/multi-account.md)

---

*Last updated: Architecture finalized, ready for implementation*
