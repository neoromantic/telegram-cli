# Contact Management

> **Status:** Core functionality implemented. Metadata extensions are planned.
>
> Implementation lives in `src/commands/contacts.ts` and cache access in `src/db/users-cache.ts`.

## Implemented Commands

- `tg contacts list` — List contacts with pagination and caching
- `tg contacts search` — Search contacts by name/username (cache-first, API on `--fresh`)
- `tg contacts get` — Get contact by ID or @username

### Caching Behavior

- Cache checked first unless `--fresh` is used
- Response includes `source: "cache" | "api"` and `stale: boolean`
- Stale TTL: 7 days (via `CacheConfig.staleness.peers`)

## Current Storage

Contacts are stored in the **users cache** (`users_cache`). See `docs/database-schema.md` for the full schema.

## Planned Extensions

- Local tags and aliases
- Notes field per contact
- Custom grouping

These will require new metadata tables (not yet implemented).
