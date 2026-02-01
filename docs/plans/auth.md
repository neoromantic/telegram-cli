# Authentication Flow

> **Note:** This document contains inspiration from telegram-mcp-server, not finalized decisions. These patterns have been observed to work in a production implementation.

## Why Their Auth Works (And Ours Might Not)

### Critical Differences

| Aspect | telegram-mcp-server (works) | telegram-cli (issues) |
|--------|----------------------------|----------------------|
| **mtcute package** | `@mtcute/node` | `@mtcute/bun` |
| **Session storage** | File path string (`session.json`) | Possibly bun:sqlite Database object |
| **Auth callbacks** | Async functions returning promises | May be using direct await pattern |
| **Password handling** | Returns `undefined` if empty | May return empty string |
| **Error handling** | Graceful boolean returns | Exception-based |

### The Working Pattern

```javascript
// telegram-client.js lines 393-419
async login() {
  try {
    if (await this._isAuthorized()) {
      console.log('Existing session is valid.');
      return true;
    }

    if (!this.phoneNumber) {
      throw new Error('TELEGRAM_PHONE_NUMBER is not configured.');
    }

    await this.client.start({
      phone: this.phoneNumber,
      code: async () => await this._askQuestion('Enter the code you received: '),
      password: async () => {
        const value = await this._askHiddenQuestion('Enter your 2FA password: ');
        return value.length ? value : undefined;  // KEY: undefined, not empty string
      },
    });

    console.log('Logged in successfully!');
    return true;
  } catch (error) {
    console.error('Error during login:', error);
    return false;
  }
}
```

### Key Pattern 1: Session Storage as File Path

```javascript
// Their approach - simple file path string
this.client = new MtCuteClient({
  apiId: this.apiId,
  apiHash: this.apiHash,
  storage: this.sessionPath,  // Just a string: '/path/to/session.json'
  updates: updatesConfig,
});
```

mtcute's Node.js driver expects a file path and handles JSON serialization internally.

### Key Pattern 2: Async Callbacks for Code/Password

```javascript
await this.client.start({
  phone: this.phoneNumber,
  code: async () => await this._askQuestion('Enter code: '),  // Async callback
  password: async () => {
    const value = await this._askHiddenQuestion('Enter 2FA password: ');
    return value.length ? value : undefined;  // Return undefined if no 2FA
  },
});
```

### Key Pattern 3: Hidden Password Input

```javascript
// Lines 365-391
async _askHiddenQuestion(prompt) {
  if (!process.stdin.isTTY) {
    return this._askQuestion(prompt);  // Fallback for non-TTY
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  // Hijack output to hide typed characters
  rl.stdoutMuted = false;
  const writeOutput = rl._writeToOutput.bind(rl);
  rl._writeToOutput = (stringToWrite) => {
    if (!rl.stdoutMuted) {
      writeOutput(stringToWrite);
    }
  };

  return new Promise(resolve => {
    rl.question(prompt, answer => {
      rl.output.write('\n');
      rl.close();
      resolve(answer.trim());
    });
    rl.stdoutMuted = true;
  });
}
```

### Key Pattern 4: Authorization Check

```javascript
// Lines 314-338
_isUnauthorizedError(error) {
  if (!error) return false;
  const code = error.code || error.status || error.errorCode;
  if (code === 401) return true;

  const message = (error.errorMessage || error.message || '').toUpperCase();
  return message.includes('AUTH_KEY') ||
         message.includes('AUTHORIZATION') ||
         message.includes('SESSION_PASSWORD_NEEDED');
}

async _isAuthorized() {
  try {
    await this.client.getMe();
    return true;
  } catch (error) {
    if (this._isUnauthorizedError(error)) {
      return false;  // Graceful: not logged in
    }
    throw error;  // Other errors propagate
  }
}
```

### Key Pattern 5: Global setTimeout Patch

```javascript
// Lines 9-20 - Prevents crashes from invalid timeouts
const timeoutPatchKey = Symbol.for('tgcli.timeoutPatch');
if (!globalThis[timeoutPatchKey]) {
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (handler, delay, ...args) => {
    const safeDelay = Math.max(0, Number.isFinite(delay) ? delay : 0);
    return originalSetTimeout(handler, safeDelay, ...args);
  };
  globalThis[timeoutPatchKey] = true;
}
```

### Key Pattern 6: Store Lock for Concurrent Access

```javascript
// Prevents multiple processes from corrupting session
const release = acquireStoreLock(storeDir);
try {
  const loginSuccess = await telegramClient.login();
  // ... do work
} finally {
  release();
}
```

## Recommended Fix for telegram-cli

1. **Session storage**: Pass file path string, not Database object
   ```typescript
   const client = new TelegramClient({
     apiId: API_ID,
     apiHash: API_HASH,
     storage: '/path/to/session.db',  // String path, not Database instance
   });
   ```

2. **Password callback**: Return `undefined` for empty password
   ```typescript
   password: async () => {
     const value = await askPassword();
     return value.length ? value : undefined;  // Not empty string
   }
   ```

3. **Auth check**: Use `_isAuthorized()` pattern before operations
   ```typescript
   async isAuthorized(): Promise<boolean> {
     try {
       await this.client.getMe();
       return true;
     } catch (error) {
       if (this.isAuthError(error)) return false;
       throw error;
     }
   }
   ```

4. **Phone persistence**: Store in config file, not just env var

5. **Add timeout patch**: For robustness with mtcute's internal timers

## Phone Number Storage

They store phone in `config.json`, not environment:

```javascript
// core/config.js
export function normalizeConfig(raw = {}) {
  const phoneNumber = normalizeValue(
    raw.phoneNumber ?? raw.phone ?? raw.phone_number
  );
  return { apiId, apiHash, phoneNumber, mcp };
}
```

Config is loaded at startup and passed to TelegramClient constructor.

## Full Auth Flow

```
User runs `tg auth`
    ↓
acquireStoreLock(storeDir)  // Prevent concurrent access
    ↓
loadConfig() or prompt for credentials
    ↓
saveConfig() with normalized values
    ↓
new TelegramClient(apiId, apiHash, phone, sessionPath)
    ↓
client.login()
    ↓
  _isAuthorized()? → return true (session reuse)
    ↓
  client.start({ phone, code, password })
    ↓
  User enters code from Telegram
    ↓
  User enters 2FA password (if enabled)
    ↓
Login success → return true
    ↓
release() store lock
```
