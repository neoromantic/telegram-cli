# Multi-Account Support Plan

## Overview

This document outlines the design for supporting multiple Telegram accounts in telegram-cli. The implementation allows users to manage up to 5 separate Telegram accounts, each with independent sessions, message history, and configuration.

## Constraints

- **Maximum accounts**: 5
- **Phone number identification**: NOT supported (security/privacy consideration)

## Account Identification

Accounts can be identified using any of the following methods (all equivalent):

### 1. Numeric ID
```bash
tg --account 1 send @contact "Hello"
tg --account 3 chats list
```

### 2. Telegram Username
```bash
tg --account @my_work_account send @contact "Hello"
tg --account @personal_tg chats list
```

### 3. Custom Label
```bash
tg --account "Work" send @contact "Hello"
tg --account "Personal" chats list
```

## Account Storage Structure

```
~/.telegram-cli/
├── config.toml                     # Global config (includes active_account)
├── accounts/
│   ├── 1/                          # Account ID 1
│   │   ├── meta.json               # Account metadata
│   │   ├── session/                # TDLib session data
│   │   │   └── td.binlog
│   │   ├── cache/                  # Account-specific cache
│   │   └── downloads/              # Account-specific downloads
│   ├── 2/                          # Account ID 2
│   │   ├── meta.json
│   │   ├── session/
│   │   ├── cache/
│   │   └── downloads/
│   └── ...
└── daemon.sock                     # Single daemon socket
```

### meta.json Schema

```json
{
  "id": 1,
  "username": "my_telegram_username",
  "label": "Work",
  "phone": "+1234567890",
  "user_id": 123456789,
  "first_name": "John",
  "last_name": "Doe",
  "created_at": "2024-01-15T10:30:00Z",
  "last_used_at": "2024-01-20T15:45:00Z"
}
```

**Fields:**
- `id`: Numeric identifier (1-5), immutable after creation
- `username`: Telegram username (without @), updated on each login
- `label`: User-defined label, optional
- `phone`: Phone number, optional (stored for reference only, not used for identification)
- `user_id`: Telegram user ID
- `first_name`, `last_name`: User's name from Telegram
- `created_at`: Account creation timestamp
- `last_used_at`: Last activity timestamp

## CLI Commands

### List Accounts
```bash
tg accounts list
```

Output:
```
  ID  Username          Label       Status
────────────────────────────────────────────
* 1   @work_account     Work        Active
  2   @personal_tg      Personal    Connected
  3   @side_project     -           Disconnected
```

### Add Account
```bash
# Interactive login (prompts for QR or phone)
tg accounts add

# With custom label
tg accounts add --label "Work"

# Force phone authentication (no QR)
tg accounts add --phone

# Force QR authentication
tg accounts add --qr
```

**Flow:**
1. Check if account limit (5) reached
2. Allocate next available ID
3. Start TDLib authentication flow
4. On success, fetch user info and create meta.json
5. Set as active account (optional, with `--switch` flag)

### Switch Active Account
```bash
# By ID
tg accounts switch 2

# By username
tg accounts switch @personal_tg

# By label
tg accounts switch "Personal"
```

Updates `active_account` in global config.toml.

### Remove Account
```bash
# By ID
tg accounts remove 2

# By username
tg accounts remove @old_account

# With confirmation skip
tg accounts remove 2 --force
```

**Flow:**
1. Resolve account identifier
2. Prompt for confirmation (unless --force)
3. Disconnect from daemon if connected
4. Delete account directory
5. If removed account was active, switch to account 1 (or none if no accounts)

### Account Info
```bash
# Current account
tg accounts info

# Specific account
tg accounts info 2
tg accounts info @work_account
```

Output:
```
Account #1 (Active)
─────────────────────────────────
Username:    @work_account
Label:       Work
Name:        John Doe
User ID:     123456789
Phone:       +1***567890
Created:     2024-01-15 10:30:00
Last used:   2024-01-20 15:45:00
Session:     Valid
Storage:     45.2 MB
```

### Rename/Relabel Account
```bash
tg accounts label 1 "New Label"
tg accounts label @work_account "Office"
```

## Account Resolution Logic

When resolving `--account <identifier>`:

```rust
fn resolve_account(identifier: &str) -> Result<Account> {
    // 1. Try numeric ID first
    if let Ok(id) = identifier.parse::<u8>() {
        if id >= 1 && id <= 5 {
            return load_account_by_id(id);
        }
    }

    // 2. Try username (with or without @)
    let username = identifier.trim_start_matches('@');
    if let Some(account) = find_account_by_username(username)? {
        return Ok(account);
    }

    // 3. Try label (case-insensitive)
    if let Some(account) = find_account_by_label(identifier)? {
        return Ok(account);
    }

    Err(Error::AccountNotFound(identifier.to_string()))
}

fn find_account_by_username(username: &str) -> Result<Option<Account>> {
    for id in 1..=5 {
        if let Some(account) = load_account_by_id(id).ok() {
            if account.username.eq_ignore_ascii_case(username) {
                return Ok(Some(account));
            }
        }
    }
    Ok(None)
}

fn find_account_by_label(label: &str) -> Result<Option<Account>> {
    for id in 1..=5 {
        if let Some(account) = load_account_by_id(id).ok() {
            if let Some(ref acc_label) = account.label {
                if acc_label.eq_ignore_ascii_case(label) {
                    return Ok(Some(account));
                }
            }
        }
    }
    Ok(None)
}
```

### Resolution Priority
1. Exact numeric ID match
2. Username match (case-insensitive, @ optional)
3. Label match (case-insensitive)

### Conflict Handling
- Labels must be unique across accounts
- If a label matches a valid numeric ID (e.g., label "2"), numeric takes precedence
- Username updates are detected on daemon connection and meta.json is updated

## Default/Active Account Management

### Global Config (config.toml)
```toml
[accounts]
active = 1              # Currently active account ID
auto_switch = false     # Auto-switch to account receiving messages (future)
```

### Active Account Selection
1. Explicit `--account` flag takes highest priority
2. `TG_ACCOUNT` environment variable
3. `active` setting in config.toml
4. Account ID 1 (if exists)
5. First available account
6. Error if no accounts configured

### Account Context in Commands
```bash
# Uses active account
tg send @contact "Hello"

# Explicit account
tg --account 2 send @contact "Hello"

# Environment variable
TG_ACCOUNT=@work tg send @contact "Hello"
```

## Daemon Multi-Account Architecture

### Single Daemon, Multiple Connections

The daemon manages multiple TDLib client instances within a single process:

```
┌─────────────────────────────────────────────────────┐
│                    tg-daemon                         │
├─────────────────────────────────────────────────────┤
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  │
│  │  TDLib #1   │  │  TDLib #2   │  │  TDLib #3   │  │
│  │  (Account1) │  │  (Account2) │  │  (Account3) │  │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘  │
│         │                │                │         │
│  ┌──────┴────────────────┴────────────────┴──────┐  │
│  │              Connection Manager               │  │
│  └───────────────────────┬───────────────────────┘  │
│                          │                          │
│  ┌───────────────────────┴───────────────────────┐  │
│  │              Unix Socket Handler              │  │
│  └───────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────┘
                           │
                    daemon.sock
                           │
            ┌──────────────┼──────────────┐
            │              │              │
         tg CLI         tg CLI         tg CLI
        (acc 1)        (acc 2)        (acc 1)
```

### Daemon Request Protocol

Requests include account identifier:

```json
{
  "account_id": 1,
  "method": "sendMessage",
  "params": {
    "chat_id": 123456,
    "text": "Hello"
  },
  "request_id": "uuid-here"
}
```

### Connection Lifecycle

1. **On daemon start**: Load all configured accounts, initialize TDLib clients
2. **Lazy connection**: TDLib clients connect to Telegram only when first request arrives
3. **Keep-alive**: Connected clients remain active for message polling
4. **Graceful shutdown**: All clients properly disconnected

### Event Routing

Events from TDLib are tagged with account ID:

```json
{
  "account_id": 2,
  "event": "newMessage",
  "data": {
    "message_id": 789,
    "chat_id": 123,
    "text": "Incoming message"
  }
}
```

CLI subscribers specify which accounts to listen to:

```json
{
  "subscribe": {
    "accounts": [1, 2],      // Specific accounts
    "events": ["newMessage", "messageEdited"]
  }
}
```

Or subscribe to all:
```json
{
  "subscribe": {
    "accounts": "all",
    "events": ["newMessage"]
  }
}
```

## Account Migration/Export

### Export Account
```bash
tg accounts export 1 --output ./backup/
```

Exports:
- meta.json (sanitized, no phone)
- Session data (encrypted)
- Custom settings

**Note**: Session export may not work across devices due to Telegram's security measures.

### Import Account
```bash
tg accounts import ./backup/account-1.tar.gz
```

**Flow:**
1. Validate backup integrity
2. Check account limit
3. Allocate new ID (original ID not preserved)
4. Extract session data
5. Attempt connection (may require re-authentication)

### Considerations
- Telegram sessions are device-bound; import may trigger re-auth
- Phone number verification may be required
- Exported data should be encrypted at rest

## Security Considerations

### Session Isolation
- Each account has completely separate session directory
- No cross-account data leakage
- TDLib instances are isolated

### Sensitive Data
- Phone numbers stored but never used for identification
- Session files contain authentication tokens
- Consider encryption at rest for session data

### Access Control
- All account operations require local access
- No remote account management
- Account removal requires explicit confirmation

## Implementation Phases

### Phase 1: Core Infrastructure
- [ ] Account directory structure
- [ ] meta.json read/write
- [ ] Account resolution logic
- [ ] `--account` flag parsing

### Phase 2: Account Commands
- [ ] `tg accounts list`
- [ ] `tg accounts add`
- [ ] `tg accounts remove`
- [ ] `tg accounts switch`
- [ ] `tg accounts info`

### Phase 3: Daemon Multi-Account
- [ ] Multiple TDLib client management
- [ ] Account-tagged requests/responses
- [ ] Event routing with account context
- [ ] Connection pooling

### Phase 4: Polish
- [ ] Account export/import
- [ ] Session health monitoring
- [ ] Auto-reconnection per account
- [ ] Account-specific settings

## Error Handling

### Common Errors

| Error | Message | Resolution |
|-------|---------|------------|
| `AccountLimitReached` | "Maximum of 5 accounts reached" | Remove unused account |
| `AccountNotFound` | "Account '{id}' not found" | Check `tg accounts list` |
| `AccountAlreadyExists` | "Account with this phone already configured" | Use existing account |
| `LabelConflict` | "Label '{label}' already in use by account {id}" | Choose different label |
| `SessionExpired` | "Session for account {id} expired" | Re-authenticate |

## Future Considerations

- **Account groups**: Organize accounts into groups
- **Cross-account forwarding**: Forward messages between accounts
- **Unified inbox**: View messages from all accounts in one stream
- **Account templates**: Quick setup with predefined settings
- **Account health dashboard**: Monitor all accounts status
