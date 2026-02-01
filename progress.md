# Development Progress

## Current Status: QR Login Ready - Phone Code Delivery Issue

## Milestone 1: Authentication & Contacts

### Completed
- [x] Research Telegram libraries (chose mtcute)
- [x] Research CLI frameworks (chose Citty)
- [x] Architecture decisions documented
- [x] Project initialized with Bun
- [x] Directory structure created
- [x] Initial documentation created
- [x] Dependencies installed (@mtcute/bun, citty)
- [x] Database schema (accounts table with sessions)
- [x] Database layer with prepared statements
- [x] Telegram client manager (multi-account support)
- [x] Output utilities (JSON, pretty, quiet modes)
- [x] Authentication commands (login, logout, status)
- [x] Account management commands (list, switch, remove, info)
- [x] Contact commands (list, search, get)
- [x] Generic API command (`tg api` for any Telegram method)
- [x] CLI entry point with subcommands
- [x] TypeScript compilation passes
- [x] PreCompact hook for state preservation
- [x] QR code login command (`tg auth login-qr`)

### Known Issues
- **Phone code delivery**: API returns success but codes don't appear in user's Telegram app
  - SMS is blocked for unofficial apps ("API_NOOFICIAL_SEND_SMS_NOT_AVAILABLE")
  - App-based codes should arrive in "Telegram" chat but don't appear
  - **Workaround**: Use QR code login instead

### Tested & Working ✓
- [x] QR login (`tg auth login-qr`) - works with 2FA
- [x] Contact retrieval (`tg contacts list`)
- [x] Generic API command (`tg api <method>`)
- [x] Session persistence (SQLite via mtcute storage)

### Pending Polish
- [ ] Better error messages
- [ ] Add more convenience commands
- [ ] Unit tests
- [ ] Integration tests

---

## Architecture Decisions

### Telegram Library: mtcute
- **Rationale**: TypeScript-first, explicit Bun support via `@mtcute/bun`, modern design
- **Key feature**: `client.call()` allows calling ANY Telegram API method
- **Alternatives rejected**:
  - GramJS: 283 open issues, older patterns
  - TDL: Native deps, Bun stability concerns

### CLI Framework: Citty
- **Rationale**: TypeScript-first, ES modules, lightweight, UnJS ecosystem
- **Alternatives rejected**:
  - Commander: Weaker TypeScript support
  - Clipanion: Overkill for utility CLI

### Database: bun:sqlite
- **Rationale**: Native Bun, zero deps, excellent performance
- Using `.as(Class)` for typed query results

### Generic API Design
- Instead of mapping every Telegram method to a CLI command, we have:
  1. High-level convenience commands (auth, accounts, contacts)
  2. Generic `tg api` command that calls ANY Telegram method
- This makes the CLI future-proof and complete without manual mapping

---

## File Structure Created

```
telegram-cli/
├── src/
│   ├── index.ts              # CLI entry point
│   ├── commands/
│   │   ├── auth.ts           # login, logout, status
│   │   ├── accounts.ts       # list, switch, remove, info
│   │   ├── contacts.ts       # list, search, get
│   │   └── api.ts            # generic API command
│   ├── services/
│   │   └── telegram.ts       # client manager
│   ├── db/
│   │   └── index.ts          # SQLite with bun:sqlite
│   ├── types/
│   │   ├── index.ts          # TypeScript types
│   │   └── qrcode-terminal.d.ts  # Type declaration
│   └── utils/
│       ├── output.ts         # JSON/pretty/quiet output
│       └── args.ts           # argument parsing
├── docs/
│   ├── architecture.md
│   └── api-design.md
├── .claude/
│   ├── settings.json         # PreCompact hook config
│   └── hooks/
│       └── precompact-preserve-state.sh
├── package.json
├── .env.example
├── README.md
├── CLAUDE.md
└── progress.md
```

---

## Next Steps
1. **Test QR login**: Run `tg auth login-qr`, scan with Telegram app
2. Once authenticated, test contact retrieval: `tg contacts list`
3. Test generic API calls: `tg api users.getUsers --params '{"id":[{"_":"inputUserSelf"}]}'`
4. Verify session persistence by restarting and running `tg auth status`

## Usage

```bash
# QR code login (recommended)
tg auth login-qr

# Phone login (may have code delivery issues)
tg auth login --phone +79261408252

# Check status
tg auth status

# List contacts
tg contacts list

# Generic API call
tg api messages.getDialogs --params '{"offset_date":0,"offset_id":0,"offset_peer":{"_":"inputPeerEmpty"},"limit":10,"hash":"0"}'
```

---

*Last updated: QR login implemented*
