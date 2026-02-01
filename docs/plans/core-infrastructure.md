# Core Infrastructure

> **Note:** This document contains inspiration from telegram-mcp-server, not finalized decisions.

## Module Organization

The telegram-mcp-server organizes core infrastructure into three modules:

```
core/
├── store.js     # Cross-platform path resolution (36 lines)
├── config.js    # Configuration normalization (101 lines)
└── services.js  # Dependency injection (52 lines)
```

## Store Management (store.js)

### Platform-Aware Paths

```javascript
function getDefaultStoreDir() {
  const platform = process.platform;
  const home = os.homedir();

  if (platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'tgcli');
  }
  if (platform === 'win32') {
    return process.env.APPDATA
      ? path.join(process.env.APPDATA, 'tgcli')
      : path.join(home, 'AppData', 'Roaming', 'tgcli');
  }
  // Linux and others
  return process.env.XDG_DATA_HOME
    ? path.join(process.env.XDG_DATA_HOME, 'tgcli')
    : path.join(home, '.local', 'share', 'tgcli');
}
```

### Path Resolution

```javascript
const STORE_ENV_VAR = 'TGCLI_STORE';

export function resolveStoreDir(storeOverride, options = {}) {
  if (storeOverride) return path.resolve(storeOverride);
  if (process.env[STORE_ENV_VAR]) return path.resolve(process.env[STORE_ENV_VAR]);
  return getDefaultStoreDir();
}

export function resolveStorePaths(storeDir, options = {}) {
  const sessionFile = options.sessionFile ?? 'session.json';
  const dbFile = options.dbFile ?? 'messages.db';
  return {
    sessionPath: path.join(storeDir, sessionFile),
    dbPath: path.join(storeDir, dbFile),
  };
}
```

### Adaptation for telegram-cli

```typescript
// For Bun, using ~/.telegram-cli as default
function getDefaultStoreDir(): string {
  const home = Bun.env.HOME ?? os.homedir();
  return path.join(home, '.telegram-cli');
}

export function resolveStorePaths(storeDir: string) {
  return {
    configPath: path.join(storeDir, 'config.json'),
    sessionPath: path.join(storeDir, 'accounts', 'default', 'session.db'),
    dataPath: path.join(storeDir, 'accounts', 'default', 'data.db'),
    daemonPid: path.join(storeDir, 'daemon.pid'),
  };
}
```

## Configuration (config.js)

### Flexible Value Normalization

```javascript
export function normalizeValue(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length ? trimmed : null;
  }
  return value;
}

export function normalizeBoolean(value, fallback = false) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const lower = value.toLowerCase().trim();
    if (['true', '1', 'yes', 'on'].includes(lower)) return true;
    if (['false', '0', 'no', 'off'].includes(lower)) return false;
    return fallback;
  }
  return fallback;
}
```

### Config Normalization

```javascript
export function normalizeConfig(raw = {}) {
  // Support multiple naming conventions
  const apiId = normalizeValue(raw.apiId ?? raw.api_id ?? raw.apiID);
  const apiHash = normalizeValue(raw.apiHash ?? raw.api_hash);
  const phoneNumber = normalizeValue(raw.phoneNumber ?? raw.phone ?? raw.phone_number);

  // Nested MCP config (optional)
  const mcpRaw = raw.mcp ?? {};
  const mcp = {
    enabled: normalizeBoolean(mcpRaw.enabled ?? raw.mcpEnabled, false),
    host: normalizeValue(mcpRaw.host ?? raw.mcpHost),
    port: Number.isFinite(mcpRaw.port) ? mcpRaw.port : null,
  };

  return { apiId, apiHash, phoneNumber, mcp };
}
```

### Validation

```javascript
export function validateConfig(config) {
  const missing = [];
  if (!config?.apiId) missing.push('apiId');
  if (!config?.apiHash) missing.push('apiHash');
  if (!config?.phoneNumber) missing.push('phoneNumber');
  return missing;
}
```

### Load/Save

```javascript
export function resolveConfigPath(storeDir) {
  return path.join(storeDir, 'config.json');
}

export function loadConfig(storeDir) {
  const configPath = resolveConfigPath(storeDir);
  try {
    const content = fs.readFileSync(configPath, 'utf8');
    const raw = JSON.parse(content);
    return { config: normalizeConfig(raw), path: configPath };
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { config: null, path: configPath };
    }
    throw error;
  }
}

export function saveConfig(storeDir, config) {
  const configPath = resolveConfigPath(storeDir);
  const dir = path.dirname(configPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(configPath, JSON.stringify(normalizeConfig(config), null, 2));
}
```

## Service Initialization (services.js)

### Factory Pattern

```javascript
export function createServices(options = {}) {
  // Resolve paths
  let storeDir, sessionPath, dbPath;

  if (options.storeDir) {
    storeDir = options.storeDir;
    const paths = resolveStorePaths(storeDir, options);
    sessionPath = options.sessionPath ?? paths.sessionPath;
    dbPath = options.dbPath ?? paths.dbPath;
  } else if (options.sessionPath && options.dbPath) {
    sessionPath = options.sessionPath;
    dbPath = options.dbPath;
    storeDir = path.dirname(sessionPath);
  } else {
    throw new Error('Either storeDir or sessionPath/dbPath required');
  }

  // Load config
  const config = options.config ?? loadConfig(storeDir).config;
  if (!config) {
    throw new Error('Missing config. Run "tg auth" to set credentials.');
  }

  const missing = validateConfig(config);
  if (missing.length) {
    throw new Error(`Missing config fields: ${missing.join(', ')}`);
  }

  // Create services
  const telegramClient = new TelegramClient(
    config.apiId,
    config.apiHash,
    config.phoneNumber,
    sessionPath,
    options
  );

  const messageSyncService = new MessageSyncService(telegramClient, dbPath, {
    batchSize: options.batchSize ?? 100,
    interJobDelayMs: options.interJobDelayMs ?? 3000,
    interBatchDelayMs: options.interBatchDelayMs ?? 1200,
  });

  return { storeDir, telegramClient, messageSyncService };
}
```

## Store Lock (Concurrent Access Prevention)

```javascript
// store-lock.js
import fs from 'node:fs';
import path from 'node:path';

export function acquireStoreLock(storeDir) {
  const lockPath = path.join(storeDir, '.lock');

  // Create lock file
  const fd = fs.openSync(lockPath, 'wx');  // Fails if exists

  return function release() {
    try {
      fs.closeSync(fd);
      fs.unlinkSync(lockPath);
    } catch (error) {
      // Ignore cleanup errors
    }
  };
}
```

## Adaptation for telegram-cli

```typescript
// src/core/store.ts
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

export const STORE_ENV_VAR = 'TELEGRAM_CLI_STORE';

export function getDefaultStoreDir(): string {
  return join(homedir(), '.telegram-cli');
}

export function resolveStoreDir(override?: string): string {
  if (override) return override;
  if (Bun.env[STORE_ENV_VAR]) return Bun.env[STORE_ENV_VAR];
  return getDefaultStoreDir();
}

export interface StorePaths {
  configPath: string;
  sessionPath: string;
  dataPath: string;
  daemonPid: string;
}

export function resolveStorePaths(storeDir: string, account = 'default'): StorePaths {
  const accountDir = join(storeDir, 'accounts', account);
  return {
    configPath: join(storeDir, 'config.json'),
    sessionPath: join(accountDir, 'session.db'),
    dataPath: join(accountDir, 'data.db'),
    daemonPid: join(storeDir, 'daemon.pid'),
  };
}
```

```typescript
// src/core/config.ts
import { Bun } from 'bun';

export interface TelegramConfig {
  apiId: number;
  apiHash: string;
  phoneNumber: string;
}

export function normalizeConfig(raw: Record<string, unknown>): TelegramConfig | null {
  const apiId = Number(raw.apiId ?? raw.api_id);
  const apiHash = String(raw.apiHash ?? raw.api_hash ?? '').trim();
  const phoneNumber = String(raw.phoneNumber ?? raw.phone ?? '').trim();

  if (!apiId || !apiHash || !phoneNumber) return null;

  return { apiId, apiHash, phoneNumber };
}

export async function loadConfig(storeDir: string): Promise<TelegramConfig | null> {
  const configPath = join(storeDir, 'config.json');
  const file = Bun.file(configPath);

  if (!await file.exists()) return null;

  const raw = await file.json();
  return normalizeConfig(raw);
}

export async function saveConfig(storeDir: string, config: TelegramConfig): Promise<void> {
  const configPath = join(storeDir, 'config.json');
  await Bun.write(configPath, JSON.stringify(config, null, 2));
}
```

## Key Patterns

1. **Separation of concerns**: store.js (paths), config.js (config), services.js (DI)
2. **Platform awareness**: Different default paths per OS
3. **Environment override**: Allow custom store via env var
4. **Flexible normalization**: Accept multiple naming conventions
5. **Factory pattern**: Single function creates all services
6. **Graceful errors**: Clear messages directing users to fix issues
