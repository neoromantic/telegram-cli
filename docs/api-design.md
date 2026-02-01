# API Design

## Philosophy: Generic API Access

Rather than manually mapping every Telegram API method to a CLI command, we provide:

1. **Generic `api` command** - Call any Telegram method directly
2. **Convenience commands** - High-level wrappers for common operations
3. **Agent-friendly output** - JSON output by default, pretty-print optional

## Generic API Command

```bash
# Call any Telegram method directly
tg api account.checkUsername --username myuser
tg api messages.getHistory --peer @username --limit 10
tg api contacts.getContacts

# With JSON input for complex arguments
tg api messages.sendMessage --json '{"peer": "@user", "message": "Hello"}'
```

This maps directly to mtcute's `tg.call()`:
```typescript
await tg.call({ _: 'account.checkUsername', username: 'myuser' })
```

## Convenience Commands

High-level commands for common operations:

```bash
# Authentication
tg auth login --phone +79261408252
tg auth logout
tg auth status

# Account management
tg accounts list
tg accounts add --phone +79261408252
tg accounts switch --id 1
tg accounts remove --id 1

# Contacts (with caching)
tg contacts list [--limit 50] [--offset 0] [--fresh]
tg contacts search --query "John" [--fresh]
tg contacts get @username [--fresh]
tg contacts get 123456789 [--fresh]

# Chats/Dialogs (with caching)
tg chats list [--limit 50] [--type private|group|supergroup|channel] [--fresh]
tg chats search "query"
tg chats get @username [--fresh]

# Messaging
tg send --to @username --message "Hello"
tg send --to @username -m "Hello" --silent
tg send --to @username -m "Reply" --reply-to 123
```

### Cache Behavior

All data-fetching commands support the `--fresh` flag:

```bash
# Use cached data (default)
tg contacts list

# Force fresh API fetch
tg contacts list --fresh
```

Response always includes cache metadata:
```json
{
  "items": [...],
  "source": "cache",  // or "api"
  "stale": false      // true if cache TTL exceeded
}
```

## Output Modes

```bash
# JSON output (default, agent-friendly)
tg contacts list
# {"contacts": [{"id": 123, "name": "John", ...}], "total": 50}

# Pretty output for humans
tg contacts list --pretty
# ┌────┬──────────┬─────────────┐
# │ ID │ Name     │ Username    │
# ├────┼──────────┼─────────────┤
# │ 123│ John Doe │ @johndoe    │
# └────┴──────────┴─────────────┘

# Quiet mode (minimal output)
tg send --to @user --text "Hi" --quiet
# (just exit code)
```

## Error Handling

All errors are returned as JSON with error codes:

```json
{
  "error": true,
  "code": "PEER_ID_INVALID",
  "message": "Could not find the specified peer",
  "details": {
    "peer": "@nonexistent"
  }
}
```

Exit codes:
- 0: Success
- 1: General error
- 2: Authentication required
- 3: Invalid arguments
- 4: Network error
- 5: Telegram API error
- 6: Account not found

## Account Context

Every command runs in context of an "active" account:

```bash
# Set active account
tg accounts switch --id 1

# Or specify per-command
tg contacts list --account 2
tg api messages.getHistory --account 2 --peer @user
```

## Peer Resolution

Peers can be specified in multiple formats:
- Username: `@username`
- Phone: `+79261408252`
- User ID: `123456789`
- Chat ID: `-123456789`
- Channel ID: `-1001234567890`

## Type System

The CLI leverages mtcute's strict TypeScript types:
- Method names are validated against TL schema
- Arguments are type-checked
- Return types are known at compile time

## Implementation Notes

### Generic API Implementation

```typescript
// src/commands/api.ts
export const apiCommand = defineCommand({
  meta: { name: 'api', description: 'Call any Telegram API method' },
  args: {
    method: { type: 'positional', description: 'API method name' },
    json: { type: 'string', description: 'JSON arguments' }
  },
  async run({ args }) {
    const client = await getActiveClient()
    const params = args.json ? JSON.parse(args.json) : parseNamedArgs(args)
    const result = await client.call({ _: args.method, ...params })
    console.log(JSON.stringify(result, null, 2))
  }
})
```

### Dynamic Argument Parsing

Named arguments become method parameters:
```bash
tg api account.checkUsername --username myuser
# → { _: 'account.checkUsername', username: 'myuser' }
```

Nested objects via dot notation:
```bash
tg api messages.sendMessage --peer.username myuser --message Hello
# → { _: 'messages.sendMessage', peer: { username: 'myuser' }, message: 'Hello' }
```

### Caching Pattern

Commands that fetch data follow a consistent caching pattern:

```typescript
// Example from src/commands/contacts.ts
async run({ args }) {
  const cacheDb = getCacheDb()  // Lazy initialization
  const usersCache = createUsersCache(cacheDb)
  const cacheConfig = getDefaultCacheConfig()

  // Check cache first (unless --fresh)
  if (!args.fresh) {
    const cached = usersCache.getByUsername(identifier)
    if (cached) {
      const stale = isCacheStale(cached.fetched_at, cacheConfig.staleness.peers)
      success({ ...cachedData, source: 'cache', stale })
      return
    }
  }

  // Fetch from API
  const client = getClientForAccount(accountId)
  const result = await client.call({ _: 'contacts.resolveUsername', username })

  // Cache the result
  usersCache.upsert(apiUserToCacheInput(result))

  success({ ...freshData, source: 'api', stale: false })
}
```

### Peer Resolution with Cache

The send command demonstrates cache-first peer resolution:

```typescript
// From src/commands/send.ts
async function resolvePeer(client, identifier, usersCache, chatsCache) {
  // Check users cache first
  const cachedUser = usersCache.getByUsername(username)
  if (cachedUser?.access_hash) {
    return {
      inputPeer: { _: 'inputPeerUser', userId: Number(cachedUser.user_id), accessHash: BigInt(cachedUser.access_hash) },
      name: cachedUser.display_name
    }
  }

  // Check chats cache
  const cachedChat = chatsCache.getByUsername(username)
  if (cachedChat?.access_hash) { ... }

  // Fall back to API resolution
  const resolved = await client.call({ _: 'contacts.resolveUsername', username })
  return { inputPeer: ..., name: ... }
}
```
