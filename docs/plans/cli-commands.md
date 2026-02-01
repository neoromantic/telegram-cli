# CLI Commands Plan

## Overview

This document defines the command-line interface for `tg` - a Telegram CLI tool designed for AI agent integration. Commands prioritize machine-readable output (JSON by default) while remaining human-usable.

## Design Principles

1. **JSON-first output** - All commands output JSON by default for AI consumption
2. **Consistent flag patterns** - Same flags work across all commands
3. **Graceful degradation** - Clear error messages with actionable guidance
4. **Caching by default** - Use cached data when available, explicit flags for fresh fetch
5. **Multi-account support** - All commands work with account selection

---

## Global Flags

Available on all commands:

| Flag | Short | Description | Default |
|------|-------|-------------|---------|
| `--account ACCOUNT` | `-a` | Use specific account (name, phone, or index) | Active account |
| `--format FORMAT` | `-f` | Output format: `json`, `table`, `minimal` | `json` |
| `--verbose` | `-v` | Increase output verbosity | Off |
| `--quiet` | `-q` | Suppress non-essential output | Off |
| `--fresh` | | Force fresh API fetch, skip cache | Off |
| `--skip-cache` | | Alias for `--fresh` | Off |
| `--help` | `-h` | Show help for command | |
| `--version` | `-V` | Show version info | |

---

## Core Commands (v0.1)

### Authentication

#### `tg auth login`

Interactive login flow. Prefers QR code, falls back to phone number.

```bash
# Interactive login (recommended)
tg auth login

# Output (success)
{
  "status": "authenticated",
  "user_id": 123456789,
  "username": "johndoe",
  "phone": "+1234567890",
  "method": "qr_code"
}

# Output (needs 2FA)
{
  "status": "pending_2fa",
  "hint": "Enter your two-factor authentication password"
}
```

#### `tg auth login-qr`

QR code login specifically.

```bash
tg auth login-qr

# Outputs QR code to terminal + JSON status
{
  "status": "awaiting_scan",
  "qr_link": "tg://login?token=...",
  "expires_in": 30
}
```

#### `tg auth logout`

Log out current or specified account.

```bash
tg auth logout
tg auth logout --account work

# Output
{
  "status": "logged_out",
  "account": "work"
}
```

#### `tg auth status`

Check authentication status.

```bash
tg auth status

# Output (authenticated)
{
  "authenticated": true,
  "user_id": 123456789,
  "username": "johndoe",
  "session_age_days": 45,
  "needs_refresh": false
}

# Output (not authenticated)
{
  "authenticated": false,
  "reason": "no_session"
}
```

---

### Account Management

#### `tg accounts list`

List all configured accounts.

```bash
tg accounts list

# Output
{
  "accounts": [
    {
      "label": "personal",
      "phone": "+1234567890",
      "username": "johndoe",
      "user_id": 123456789,
      "active": true,
      "authenticated": true
    },
    {
      "label": "work",
      "phone": "+0987654321",
      "username": "john_work",
      "user_id": 987654321,
      "active": false,
      "authenticated": true
    }
  ],
  "active_account": "personal"
}
```

#### `tg accounts add`

Add a new account.

```bash
tg accounts add
tg accounts add --label work

# Output
{
  "status": "account_added",
  "label": "work",
  "awaiting_auth": true
}
```

#### `tg accounts switch`

Switch active account.

```bash
tg accounts switch work
tg accounts switch +1234567890
tg accounts switch 1  # By index

# Output
{
  "status": "switched",
  "previous": "personal",
  "current": "work"
}
```

#### `tg accounts remove`

Remove an account.

```bash
tg accounts remove work

# Output
{
  "status": "removed",
  "account": "work"
}
```

#### `tg accounts info`

Detailed info about current account.

```bash
tg accounts info
tg accounts info --account work

# Output
{
  "label": "personal",
  "user_id": 123456789,
  "username": "johndoe",
  "phone": "+1234567890",
  "first_name": "John",
  "last_name": "Doe",
  "premium": false,
  "session_created": "2024-01-15T10:30:00Z",
  "last_activity": "2024-12-01T15:45:00Z"
}
```

---

### Contacts

#### `tg contacts list`

List contacts with pagination.

```bash
tg contacts list
tg contacts list --limit 50 --offset 100

# Output
{
  "contacts": [
    {
      "user_id": 111222333,
      "username": "alice",
      "first_name": "Alice",
      "last_name": "Smith",
      "phone": "+1111111111",
      "mutual": true
    }
  ],
  "total": 150,
  "limit": 50,
  "offset": 0,
  "has_more": true
}
```

#### `tg contacts get`

Get specific contact by username.

```bash
tg contacts get @alice
tg contacts get @alice --fresh

# Output
{
  "user_id": 111222333,
  "username": "alice",
  "first_name": "Alice",
  "last_name": "Smith",
  "phone": "+1111111111",
  "status": "online",
  "last_seen": null,
  "mutual": true,
  "cached": true,
  "cache_age_seconds": 3600
}
```

#### `tg contacts search`

Search contacts by name or username.

```bash
tg contacts search "alice"
tg contacts search "ali" --limit 10

# Output
{
  "results": [
    {
      "user_id": 111222333,
      "username": "alice",
      "first_name": "Alice",
      "last_name": "Smith",
      "match_type": "username"
    }
  ],
  "query": "alice",
  "count": 1
}
```

---

### Messaging

#### `tg send`

Send a message to a user or group.

```bash
# Send to user
tg send @alice "Hello, how are you?"
tg send +1111111111 "Hello!"

# Send to group
tg send -g "Family Chat" "Hello everyone!"
tg send --group "Work Team" "Meeting in 5 minutes"

# Send with specific account
tg send @alice "Hi from work" --account work

# Output
{
  "status": "sent",
  "message_id": 12345,
  "chat_id": -1001234567890,
  "recipient": "@alice",
  "timestamp": "2024-12-01T15:45:00Z"
}
```

**Flags:**
- `-g, --group NAME` - Send to group by name
- `--reply-to MSG_ID` - Reply to specific message (future)
- `--silent` - Send without notification (future)

---

### Chats

#### `tg chats list`

List recent chats/dialogs.

```bash
tg chats list
tg chats list --limit 20

# Output
{
  "chats": [
    {
      "chat_id": 111222333,
      "type": "private",
      "title": "Alice Smith",
      "username": "alice",
      "unread_count": 3,
      "last_message": {
        "id": 9999,
        "text": "See you tomorrow!",
        "date": "2024-12-01T14:30:00Z",
        "from_id": 111222333
      }
    },
    {
      "chat_id": -1001234567890,
      "type": "supergroup",
      "title": "Work Team",
      "username": "workteam",
      "unread_count": 15,
      "last_message": {
        "id": 8888,
        "text": "Meeting notes attached",
        "date": "2024-12-01T15:00:00Z",
        "from_id": 222333444
      }
    }
  ],
  "total": 45,
  "limit": 20,
  "has_more": true
}
```

---

### Info Commands

#### `tg me`

Get current authenticated user info.

```bash
tg me

# Output
{
  "user_id": 123456789,
  "username": "johndoe",
  "first_name": "John",
  "last_name": "Doe",
  "phone": "+1234567890",
  "premium": false,
  "bio": "Software developer",
  "profile_photo": true
}
```

#### `tg user`

Get info about any user.

```bash
tg user @alice
tg user @alice --fresh  # Force fresh fetch

# Output
{
  "user_id": 111222333,
  "username": "alice",
  "first_name": "Alice",
  "last_name": "Smith",
  "status": "recently",
  "last_seen": "2024-12-01T10:00:00Z",
  "bot": false,
  "verified": false,
  "premium": true,
  "cached": true,
  "cache_age_seconds": 1800
}
```

---

### Status

#### `tg status`

Show daemon status, sync progress, and rate limit info.

```bash
tg status

# Output
{
  "daemon": {
    "running": true,
    "pid": 12345,
    "uptime_seconds": 86400,
    "memory_mb": 45
  },
  "sync": {
    "status": "idle",
    "last_sync": "2024-12-01T15:40:00Z",
    "pending_updates": 0
  },
  "rate_limits": {
    "messages_remaining": 45,
    "reset_in_seconds": 120,
    "flood_wait_until": null
  },
  "accounts": {
    "total": 2,
    "authenticated": 2,
    "active": "personal"
  }
}
```

---

### Daemon

#### `tg daemon start`

Start the background daemon.

```bash
tg daemon start
tg daemon start --verbose

# Output
{
  "status": "started",
  "pid": 12345,
  "log_file": "/Users/user/.tg/daemon.log"
}
```

#### `tg daemon stop`

Stop the daemon.

```bash
tg daemon stop

# Output
{
  "status": "stopped",
  "pid": 12345,
  "uptime_seconds": 86400
}
```

#### `tg daemon status`

Check daemon status.

```bash
tg daemon status

# Output (running)
{
  "running": true,
  "pid": 12345,
  "uptime_seconds": 86400,
  "memory_mb": 45,
  "connections": 2
}

# Output (not running)
{
  "running": false,
  "reason": "not_started"
}
```

---

### Generic API

#### `tg api`

Call any Telegram API method directly.

```bash
tg api messages.getDialogs --json '{"limit": 10}'
tg api users.getFullUser --json '{"id": {"_": "inputUser", "user_id": 123456789}}'

# Output
{
  "ok": true,
  "result": {
    // Raw API response
  }
}
```

---

### AI Integration

#### `tg skill`

Output capabilities as structured data for AI agents.

```bash
tg skill

# Output
{
  "name": "telegram-cli",
  "version": "0.1.0",
  "description": "Telegram CLI for AI agents",
  "capabilities": [
    {
      "name": "send_message",
      "command": "tg send TARGET MESSAGE",
      "description": "Send a message to a user or group",
      "parameters": {
        "target": "Username (@user), phone number, or group name (-g)",
        "message": "Text message to send"
      }
    },
    {
      "name": "list_contacts",
      "command": "tg contacts list",
      "description": "List all contacts"
    },
    {
      "name": "list_chats",
      "command": "tg chats list",
      "description": "List recent conversations"
    }
  ],
  "rate_limits": {
    "messages_per_minute": 30,
    "api_calls_per_second": 1
  },
  "output_format": "json"
}
```

---

## Error Handling

### Standard Error Format

All errors return consistent JSON:

```json
{
  "error": true,
  "code": "AUTH_REQUIRED",
  "message": "Authentication required. Run 'tg auth login' to authenticate.",
  "details": {
    "account": "personal"
  },
  "suggestion": "tg auth login"
}
```

### Common Error Codes

| Code | Description | Suggestion |
|------|-------------|------------|
| `AUTH_REQUIRED` | Not authenticated | `tg auth login` |
| `AUTH_EXPIRED` | Session expired | `tg auth login` |
| `ACCOUNT_NOT_FOUND` | Account doesn't exist | `tg accounts list` |
| `USER_NOT_FOUND` | User doesn't exist | Check username |
| `CHAT_NOT_FOUND` | Chat doesn't exist | Check chat name |
| `RATE_LIMITED` | Too many requests | Wait and retry |
| `FLOOD_WAIT` | Telegram flood wait | Wait specified time |
| `NETWORK_ERROR` | Connection failed | Check network |
| `DAEMON_NOT_RUNNING` | Daemon not started | `tg daemon start` |
| `INVALID_ARGUMENT` | Bad parameter | Check help |

### Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | General error |
| 2 | Invalid arguments |
| 3 | Authentication error |
| 4 | Network error |
| 5 | Rate limited |
| 6 | Resource not found |

---

## Help Text Examples

### Main Help

```
$ tg --help
Telegram CLI for AI agents

Usage: tg <COMMAND> [OPTIONS]

Commands:
  auth      Authentication management
  accounts  Multi-account management
  contacts  Contact operations
  send      Send messages
  chats     Chat/dialog operations
  me        Current user info
  user      User info lookup
  status    Daemon and sync status
  daemon    Daemon management
  api       Raw API calls
  skill     AI integration info

Options:
  -a, --account <ACCOUNT>  Use specific account
  -f, --format <FORMAT>    Output format [default: json]
  -v, --verbose            Verbose output
  -q, --quiet              Quiet output
  -h, --help               Print help
  -V, --version            Print version
```

### Command Help

```
$ tg send --help
Send a message to a user or group

Usage: tg send [OPTIONS] <TARGET> <MESSAGE>

Arguments:
  <TARGET>   Recipient (@username, phone, or group with -g)
  <MESSAGE>  Message text to send

Options:
  -g, --group              Send to group by name
  -a, --account <ACCOUNT>  Use specific account
  -f, --format <FORMAT>    Output format [default: json]
  -h, --help               Print help

Examples:
  tg send @alice "Hello!"
  tg send +1234567890 "Hi there"
  tg send -g "Family Chat" "Hello everyone!"
```

---

## Future Commands (Post v0.1)

### Messaging Extensions
```bash
tg send @user --file /path/to/file    # Send file
tg send @user --photo /path/to/img    # Send photo
tg send @user --reply-to 123          # Reply to message
tg messages list @user [--limit N]    # List messages in chat
tg messages read @user                # Mark as read
tg messages delete @user MSG_ID       # Delete message
```

### Group Management
```bash
tg groups list
tg groups info "Group Name"
tg groups members "Group Name"
tg groups create "Name" [--description]
tg groups invite "Group" @user
```

### Channel Operations
```bash
tg channels list
tg channels post "Channel" "message"
tg channels schedule "Channel" "message" --at "2024-12-25T10:00:00"
```

### Media
```bash
tg download MSG_ID [--output /path]
tg upload /path/to/file @user
```

### Search
```bash
tg search "query" [--in @user] [--limit N]
tg search --global "query"
```

---

## Implementation Notes

### Caching Strategy

1. **User info**: Cache for 1 hour, `--fresh` bypasses
2. **Contacts**: Cache for 15 minutes
3. **Chats**: Cache for 5 minutes
4. **Messages**: No caching (always fresh)

### Rate Limiting

- Internal rate limiter prevents flood wait
- Exponential backoff on FLOOD_WAIT
- Status command shows remaining quota

### Multi-Account Handling

1. Accounts stored in `~/.tg/accounts/`
2. Each account has separate session file
3. Active account persisted in config
4. Daemon handles multiple account connections
