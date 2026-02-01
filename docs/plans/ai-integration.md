# AI Integration Plan

This document outlines the plan for making `telegram-cli` fully compatible with AI agents, specifically targeting Claude Code skills integration and distribution via platforms like skills.sh.

## Overview

The goal is to enable AI agents to:
1. Discover and understand the CLI's capabilities
2. Self-install the tool into their environment
3. Use the tool effectively with structured, parseable output
4. Handle errors gracefully with actionable feedback

## Skill Metadata Command

### `tg skill` Command

The `tg skill` command outputs structured JSON describing all capabilities:

```bash
tg skill
```

Output format:

```json
{
  "name": "telegram-cli",
  "version": "0.1.0",
  "description": "Telegram CLI client for AI agents",
  "repository": "https://github.com/user/telegram-cli",
  "license": "MIT",
  "commands": [
    {
      "name": "send",
      "description": "Send a message to a user or group",
      "usage": "tg send <recipient> <message>",
      "args": [
        {
          "name": "recipient",
          "type": "string",
          "required": true,
          "description": "Username (@user), phone number, or chat ID"
        },
        {
          "name": "message",
          "type": "string",
          "required": true,
          "description": "Message text to send"
        }
      ],
      "flags": [
        {
          "name": "--silent",
          "short": "-s",
          "type": "boolean",
          "description": "Send without notification sound"
        },
        {
          "name": "--reply-to",
          "type": "integer",
          "description": "Message ID to reply to"
        }
      ],
      "examples": [
        "tg send @username \"Hello, world!\"",
        "tg send +1234567890 \"Meeting at 3pm\" --silent"
      ]
    },
    {
      "name": "read",
      "description": "Read messages from a chat",
      "usage": "tg read <chat> [options]",
      "args": [
        {
          "name": "chat",
          "type": "string",
          "required": true,
          "description": "Chat identifier (username, phone, or ID)"
        }
      ],
      "flags": [
        {
          "name": "--limit",
          "short": "-n",
          "type": "integer",
          "default": 10,
          "description": "Number of messages to retrieve"
        },
        {
          "name": "--json",
          "type": "boolean",
          "description": "Output as JSON for programmatic parsing"
        }
      ],
      "examples": [
        "tg read @channel --limit 5",
        "tg read @user --json"
      ]
    },
    {
      "name": "list",
      "description": "List chats, contacts, or groups",
      "usage": "tg list <type> [options]",
      "args": [
        {
          "name": "type",
          "type": "string",
          "required": true,
          "enum": ["chats", "contacts", "groups", "channels"],
          "description": "Type of items to list"
        }
      ],
      "flags": [
        {
          "name": "--limit",
          "short": "-n",
          "type": "integer",
          "default": 20,
          "description": "Maximum items to return"
        },
        {
          "name": "--json",
          "type": "boolean",
          "description": "Output as JSON"
        }
      ],
      "examples": [
        "tg list chats --limit 10",
        "tg list contacts --json"
      ]
    },
    {
      "name": "search",
      "description": "Search messages across chats",
      "usage": "tg search <query> [options]",
      "args": [
        {
          "name": "query",
          "type": "string",
          "required": true,
          "description": "Search query"
        }
      ],
      "flags": [
        {
          "name": "--chat",
          "short": "-c",
          "type": "string",
          "description": "Limit search to specific chat"
        },
        {
          "name": "--limit",
          "short": "-n",
          "type": "integer",
          "default": 20,
          "description": "Maximum results"
        },
        {
          "name": "--json",
          "type": "boolean",
          "description": "Output as JSON"
        }
      ],
      "examples": [
        "tg search \"meeting notes\" --chat @workgroup",
        "tg search \"important\" --limit 50 --json"
      ]
    },
    {
      "name": "auth",
      "description": "Authenticate with Telegram",
      "usage": "tg auth [options]",
      "flags": [
        {
          "name": "--status",
          "type": "boolean",
          "description": "Check authentication status"
        },
        {
          "name": "--logout",
          "type": "boolean",
          "description": "Log out and clear credentials"
        }
      ],
      "examples": [
        "tg auth",
        "tg auth --status"
      ]
    },
    {
      "name": "skill",
      "description": "Output skill metadata for AI agents",
      "usage": "tg skill [subcommand]",
      "subcommands": [
        {
          "name": "install",
          "description": "Install skill file into AI agent config",
          "usage": "tg skill install [options]",
          "flags": [
            {
              "name": "--agent",
              "type": "string",
              "enum": ["claude-code", "cursor", "generic"],
              "default": "claude-code",
              "description": "Target AI agent"
            },
            {
              "name": "--path",
              "type": "string",
              "description": "Custom installation path"
            }
          ]
        },
        {
          "name": "generate",
          "description": "Generate skill file to stdout",
          "usage": "tg skill generate [options]",
          "flags": [
            {
              "name": "--format",
              "type": "string",
              "enum": ["markdown", "json"],
              "default": "markdown",
              "description": "Output format"
            }
          ]
        }
      ],
      "examples": [
        "tg skill",
        "tg skill install --agent claude-code",
        "tg skill generate --format markdown > telegram.md"
      ]
    }
  ],
  "capabilities": {
    "authentication": {
      "methods": ["phone", "bot_token"],
      "storage": "encrypted_keychain"
    },
    "output_formats": ["text", "json"],
    "platforms": ["macos", "linux", "windows"]
  },
  "ai_integration": {
    "skill_file": "~/.claude/skills/telegram-cli.md",
    "error_format": "structured_json",
    "supports_json_output": true
  }
}
```

### Subcommands

#### `tg skill install`

Self-installs the skill file into the AI agent's configuration directory:

```bash
# Install for Claude Code (default)
tg skill install

# Install for specific agent
tg skill install --agent claude-code
tg skill install --agent cursor

# Custom path
tg skill install --path ~/.my-agent/skills/
```

The command will:
1. Detect the target agent's skill directory
2. Generate the appropriate skill file format
3. Write the file to the correct location
4. Verify the installation
5. Output confirmation with next steps

#### `tg skill generate`

Outputs the skill file content without installing:

```bash
# Generate markdown skill file
tg skill generate --format markdown

# Generate JSON metadata
tg skill generate --format json
```

## Skill File Format

### Claude Code Skill File

Location: `~/.claude/skills/telegram-cli.md`

```markdown
---
name: telegram-cli
description: Send and read Telegram messages from the command line
version: 0.1.0
tools:
  - Bash
triggers:
  - telegram
  - tg
  - send message
  - read messages
---

# Telegram CLI

A command-line interface for Telegram that enables sending and reading messages.

## Prerequisites

- Authenticated session (run `tg auth` if not authenticated)
- Check status with `tg auth --status`

## Commands

### Send a Message

```bash
# Send to a user by username
tg send @username "Your message here"

# Send to a user by phone number
tg send +1234567890 "Your message here"

# Send silently (no notification)
tg send @username "Quiet message" --silent

# Reply to a specific message
tg send @username "Reply text" --reply-to 12345
```

### Read Messages

```bash
# Read last 10 messages from a chat
tg read @username

# Read specific number of messages
tg read @channel --limit 20

# Get JSON output for parsing
tg read @user --json
```

### List Chats and Contacts

```bash
# List recent chats
tg list chats

# List contacts
tg list contacts --json

# List groups
tg list groups --limit 50
```

### Search Messages

```bash
# Search across all chats
tg search "meeting notes"

# Search in specific chat
tg search "project update" --chat @workgroup

# Get JSON results
tg search "deadline" --json
```

## JSON Output Mode

For programmatic parsing, use the `--json` flag:

```bash
tg read @user --json
```

Output:
```json
{
  "success": true,
  "data": {
    "messages": [
      {
        "id": 12345,
        "from": "@username",
        "text": "Hello!",
        "timestamp": "2024-01-15T10:30:00Z"
      }
    ]
  }
}
```

## Error Handling

Errors are returned in a structured format:

```json
{
  "success": false,
  "error": {
    "code": "AUTH_REQUIRED",
    "message": "Not authenticated. Run 'tg auth' to log in.",
    "suggestion": "tg auth"
  }
}
```

## Common Error Codes

| Code | Description | Resolution |
|------|-------------|------------|
| AUTH_REQUIRED | Not logged in | Run `tg auth` |
| USER_NOT_FOUND | User/chat not found | Verify username or ID |
| RATE_LIMITED | Too many requests | Wait and retry |
| NETWORK_ERROR | Connection failed | Check internet connection |

## Examples

### Send a reminder
```bash
tg send @alice "Don't forget the meeting at 3pm!"
```

### Check for new messages
```bash
tg read @projectgroup --limit 5 --json | jq '.data.messages[] | select(.unread)'
```

### Find important messages
```bash
tg search "urgent" --limit 10 --json
```
```

## Error Handling for AI Agents

All errors should be returned in a structured JSON format when `--json` flag is used or when the tool detects it's being called by an AI agent (via environment variable or TTY detection):

### Error Response Structure

```json
{
  "success": false,
  "error": {
    "code": "ERROR_CODE",
    "message": "Human-readable error message",
    "details": {
      "field": "specific_field",
      "value": "provided_value",
      "expected": "expected_format"
    },
    "suggestion": "tg command --to-fix",
    "documentation": "https://docs.example.com/errors/ERROR_CODE"
  }
}
```

### Standard Error Codes

| Code | HTTP-like | Description |
|------|-----------|-------------|
| `AUTH_REQUIRED` | 401 | Authentication needed |
| `AUTH_EXPIRED` | 401 | Session expired |
| `FORBIDDEN` | 403 | No permission for action |
| `NOT_FOUND` | 404 | Resource not found |
| `RATE_LIMITED` | 429 | Rate limit exceeded |
| `VALIDATION_ERROR` | 400 | Invalid input |
| `NETWORK_ERROR` | 503 | Network connectivity issue |
| `INTERNAL_ERROR` | 500 | Unexpected error |

### AI Agent Detection

The CLI should detect AI agent context via:

```rust
fn is_ai_agent_context() -> bool {
    // Check for AI agent environment variables
    std::env::var("CLAUDE_CODE").is_ok()
        || std::env::var("AI_AGENT").is_ok()
        || std::env::var("MCP_SERVER").is_ok()
        // Check if not running in interactive terminal
        || !atty::is(atty::Stream::Stdout)
}
```

When in AI agent context, automatically:
1. Use JSON output format
2. Include error codes and suggestions
3. Suppress interactive prompts
4. Provide machine-parseable responses

## Distribution via skills.sh

### Registration

Register the skill on skills.sh for discovery:

```bash
# Submit skill for listing
curl -X POST https://skills.sh/api/skills \
  -H "Authorization: Bearer $SKILLS_SH_TOKEN" \
  -d @skill-manifest.json
```

### Skill Manifest

```json
{
  "name": "telegram-cli",
  "slug": "telegram",
  "description": "Send and read Telegram messages from AI agents",
  "version": "0.1.0",
  "author": "Your Name",
  "repository": "https://github.com/user/telegram-cli",
  "install_command": "cargo install telegram-cli && tg skill install",
  "verify_command": "tg --version",
  "skill_file_url": "https://raw.githubusercontent.com/user/telegram-cli/main/skills/claude-code.md",
  "tags": ["messaging", "telegram", "communication"],
  "platforms": ["macos", "linux", "windows"],
  "ai_agents": ["claude-code", "cursor", "generic"]
}
```

### One-Line Installation

Users can install via:

```bash
# Using skills.sh installer
curl -fsSL https://skills.sh/install/telegram | sh

# Or manual
cargo install telegram-cli && tg skill install
```

## Implementation Tasks

### Phase 1: Core Skill Infrastructure

1. [ ] Implement `tg skill` command with JSON output
2. [ ] Implement `tg skill generate` for skill file generation
3. [ ] Implement `tg skill install` for self-installation
4. [ ] Add AI agent detection logic
5. [ ] Ensure all commands support `--json` flag

### Phase 2: Error Handling

1. [ ] Define comprehensive error code enum
2. [ ] Implement structured error responses
3. [ ] Add suggestion generation for common errors
4. [ ] Test error handling in AI agent context

### Phase 3: Distribution

1. [ ] Create skill manifest for skills.sh
2. [ ] Set up automated skill file updates on release
3. [ ] Create installation documentation
4. [ ] Submit to skills.sh registry

### Phase 4: Testing

1. [ ] Test with Claude Code
2. [ ] Test with Cursor
3. [ ] Verify JSON parsing with `jq`
4. [ ] End-to-end AI agent workflow testing

## Claude Code Integration Example

### Agent Workflow

When a user asks Claude Code to send a Telegram message:

1. **Discovery**: Agent reads `~/.claude/skills/telegram-cli.md`
2. **Understanding**: Agent parses available commands and examples
3. **Execution**: Agent runs appropriate command:
   ```bash
   tg send @recipient "Message from Claude" --json
   ```
4. **Response Handling**: Agent parses JSON response:
   ```json
   {
     "success": true,
     "data": {
       "message_id": 12345,
       "chat": "@recipient",
       "timestamp": "2024-01-15T10:30:00Z"
     }
   }
   ```
5. **Error Recovery**: If error occurs, agent reads suggestion and retries

### Example Conversation

**User**: Send a message to @alice saying "The report is ready"

**Claude Code**:
1. Checks skill file for `send` command syntax
2. Executes: `tg send @alice "The report is ready" --json`
3. Parses response
4. Reports: "Message sent successfully to @alice at 10:30 AM"

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `TG_JSON_OUTPUT` | Always output JSON | `false` |
| `TG_NO_COLOR` | Disable colored output | `false` |
| `TG_CONFIG_DIR` | Config directory | `~/.config/telegram-cli` |
| `TG_SKILL_DIR` | Skill file location | `~/.claude/skills` |

### Config File

`~/.config/telegram-cli/config.toml`:

```toml
[output]
format = "auto"  # auto, json, text
color = true

[ai]
auto_detect = true
skill_format = "markdown"
```

## Future Considerations

### MCP Server Mode

Consider implementing Model Context Protocol (MCP) server mode for direct integration:

```bash
tg mcp serve
```

This would allow AI agents to connect directly without shell execution.

### Streaming Output

For long-running operations, support streaming JSON:

```bash
tg read @channel --stream --json
```

Output (newline-delimited JSON):
```json
{"type":"message","data":{"id":1,"text":"Hello"}}
{"type":"message","data":{"id":2,"text":"World"}}
{"type":"end","data":{"count":2}}
```

### Interactive Mode

For complex multi-step operations:

```bash
tg interactive --json
```

Enables back-and-forth communication for operations requiring confirmation.
