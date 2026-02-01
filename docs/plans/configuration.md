# Configuration Plan

## Overview

This document outlines the configuration system for telegram-cli, including file locations, structure, loading/saving logic, environment variable overrides, defaults, validation, and migration strategies.

## File Locations

### Global Configuration
- **Path**: `~/.telegram-cli/config.json`
- **Purpose**: Application-wide settings shared across all accounts

### Per-Account Metadata
- **Path**: `~/.telegram-cli/accounts/{account_id}/meta.json`
- **Purpose**: Account-specific metadata and identification

## Configuration Structures

### config.json

```json
{
  "activeAccount": 1,
  "staleness": {
    "peers": 604800
  },
  "daemon": {
    "verbosity": "normal",
    "syncPriorities": {
      "dmAndSmallGroups": true,
      "largeGroups": false,
      "channels": false
    }
  },
  "api": {
    "id": 12345,
    "hash": "your-api-hash-here"
  }
}
```

#### Field Descriptions

| Field | Type | Description |
|-------|------|-------------|
| `activeAccount` | `number` | ID of the currently active account |
| `staleness.peers` | `number` | Time in seconds before peer data is considered stale (default: 604800 = 7 days) |
| `daemon.verbosity` | `string` | Logging verbosity level: `"quiet"`, `"normal"`, `"verbose"`, `"debug"` |
| `daemon.syncPriorities.dmAndSmallGroups` | `boolean` | Whether to sync DMs and small groups |
| `daemon.syncPriorities.largeGroups` | `boolean` | Whether to sync large groups (100+ members) |
| `daemon.syncPriorities.channels` | `boolean` | Whether to sync channels |
| `api.id` | `number` | Telegram API ID (obtain from my.telegram.org) |
| `api.hash` | `string` | Telegram API hash (obtain from my.telegram.org) |

### meta.json

```json
{
  "id": 1,
  "username": "usualguy",
  "label": "Personal",
  "phone": "+79261408252",
  "createdAt": "2024-01-01T00:00:00Z"
}
```

#### Field Descriptions

| Field | Type | Description |
|-------|------|-------------|
| `id` | `number` | Unique account identifier (auto-incremented) |
| `username` | `string` | Telegram username (without @) |
| `label` | `string` | User-friendly label for the account |
| `phone` | `string` | Phone number in international format |
| `createdAt` | `string` | ISO 8601 timestamp of when account was added |

## Default Values

```rust
impl Default for Config {
    fn default() -> Self {
        Config {
            active_account: None,
            staleness: Staleness {
                peers: 604800, // 7 days
            },
            daemon: DaemonConfig {
                verbosity: Verbosity::Normal,
                sync_priorities: SyncPriorities {
                    dm_and_small_groups: true,
                    large_groups: false,
                    channels: false,
                },
            },
            api: None, // Must be provided by user or environment
        }
    }
}
```

## Environment Variable Overrides

Environment variables take precedence over config file values.

| Environment Variable | Config Path | Type | Description |
|---------------------|-------------|------|-------------|
| `TELEGRAM_API_ID` | `api.id` | `number` | Telegram API ID |
| `TELEGRAM_API_HASH` | `api.hash` | `string` | Telegram API hash |
| `TELEGRAM_CLI_CONFIG` | - | `string` | Custom config file path |
| `TELEGRAM_CLI_VERBOSITY` | `daemon.verbosity` | `string` | Override verbosity level |
| `TELEGRAM_CLI_ACCOUNT` | `activeAccount` | `number` | Override active account |

### Override Priority (highest to lowest)

1. Command-line arguments
2. Environment variables
3. Config file values
4. Default values

## Config Loading Logic

```rust
use std::path::PathBuf;
use std::env;

pub struct ConfigLoader {
    config_path: PathBuf,
}

impl ConfigLoader {
    pub fn new() -> Self {
        let config_path = env::var("TELEGRAM_CLI_CONFIG")
            .map(PathBuf::from)
            .unwrap_or_else(|_| {
                dirs::home_dir()
                    .expect("Could not determine home directory")
                    .join(".telegram-cli")
                    .join("config.json")
            });

        Self { config_path }
    }

    pub fn load(&self) -> Result<Config, ConfigError> {
        // 1. Load defaults
        let mut config = Config::default();

        // 2. Load from file if exists
        if self.config_path.exists() {
            let file_config = self.load_from_file()?;
            config.merge(file_config);
        }

        // 3. Apply environment variable overrides
        self.apply_env_overrides(&mut config);

        // 4. Validate
        config.validate()?;

        Ok(config)
    }

    fn load_from_file(&self) -> Result<Config, ConfigError> {
        let content = std::fs::read_to_string(&self.config_path)?;
        let config: Config = serde_json::from_str(&content)?;
        Ok(config)
    }

    fn apply_env_overrides(&self, config: &mut Config) {
        if let Ok(api_id) = env::var("TELEGRAM_API_ID") {
            if let Ok(id) = api_id.parse::<i32>() {
                config.api.get_or_insert_default().id = id;
            }
        }

        if let Ok(api_hash) = env::var("TELEGRAM_API_HASH") {
            config.api.get_or_insert_default().hash = api_hash;
        }

        if let Ok(verbosity) = env::var("TELEGRAM_CLI_VERBOSITY") {
            if let Ok(v) = verbosity.parse::<Verbosity>() {
                config.daemon.verbosity = v;
            }
        }

        if let Ok(account) = env::var("TELEGRAM_CLI_ACCOUNT") {
            if let Ok(id) = account.parse::<i32>() {
                config.active_account = Some(id);
            }
        }
    }
}
```

## Config Saving Logic

```rust
impl ConfigLoader {
    pub fn save(&self, config: &Config) -> Result<(), ConfigError> {
        // Ensure parent directory exists
        if let Some(parent) = self.config_path.parent() {
            std::fs::create_dir_all(parent)?;
        }

        // Serialize with pretty printing
        let content = serde_json::to_string_pretty(config)?;

        // Write atomically using temp file
        let temp_path = self.config_path.with_extension("json.tmp");
        std::fs::write(&temp_path, &content)?;
        std::fs::rename(&temp_path, &self.config_path)?;

        Ok(())
    }
}
```

## Validation

```rust
impl Config {
    pub fn validate(&self) -> Result<(), ConfigError> {
        // API credentials validation
        if let Some(ref api) = self.api {
            if api.id <= 0 {
                return Err(ConfigError::InvalidApiId);
            }
            if api.hash.is_empty() {
                return Err(ConfigError::EmptyApiHash);
            }
            if api.hash.len() != 32 {
                return Err(ConfigError::InvalidApiHashLength);
            }
        }

        // Staleness validation
        if self.staleness.peers < 60 {
            return Err(ConfigError::StalenessToLow {
                field: "peers",
                minimum: 60,
            });
        }

        // Verbosity validation is handled by enum parsing

        Ok(())
    }
}

#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("Invalid API ID: must be a positive integer")]
    InvalidApiId,

    #[error("API hash cannot be empty")]
    EmptyApiHash,

    #[error("API hash must be 32 characters")]
    InvalidApiHashLength,

    #[error("Staleness value for '{field}' is too low (minimum: {minimum} seconds)")]
    StalenessToLow { field: &'static str, minimum: u64 },

    #[error("Failed to read config file: {0}")]
    IoError(#[from] std::io::Error),

    #[error("Failed to parse config file: {0}")]
    ParseError(#[from] serde_json::Error),
}
```

## Account Metadata Operations

```rust
pub struct AccountManager {
    base_path: PathBuf,
}

impl AccountManager {
    pub fn new() -> Self {
        let base_path = dirs::home_dir()
            .expect("Could not determine home directory")
            .join(".telegram-cli")
            .join("accounts");

        Self { base_path }
    }

    pub fn load_account(&self, id: i32) -> Result<AccountMeta, AccountError> {
        let meta_path = self.base_path.join(id.to_string()).join("meta.json");
        let content = std::fs::read_to_string(&meta_path)?;
        let meta: AccountMeta = serde_json::from_str(&content)?;
        Ok(meta)
    }

    pub fn save_account(&self, meta: &AccountMeta) -> Result<(), AccountError> {
        let account_dir = self.base_path.join(meta.id.to_string());
        std::fs::create_dir_all(&account_dir)?;

        let meta_path = account_dir.join("meta.json");
        let content = serde_json::to_string_pretty(meta)?;
        std::fs::write(&meta_path, content)?;

        Ok(())
    }

    pub fn list_accounts(&self) -> Result<Vec<AccountMeta>, AccountError> {
        let mut accounts = Vec::new();

        if !self.base_path.exists() {
            return Ok(accounts);
        }

        for entry in std::fs::read_dir(&self.base_path)? {
            let entry = entry?;
            if entry.file_type()?.is_dir() {
                let meta_path = entry.path().join("meta.json");
                if meta_path.exists() {
                    if let Ok(meta) = self.load_account_from_path(&meta_path) {
                        accounts.push(meta);
                    }
                }
            }
        }

        accounts.sort_by_key(|a| a.id);
        Ok(accounts)
    }

    pub fn next_account_id(&self) -> Result<i32, AccountError> {
        let accounts = self.list_accounts()?;
        Ok(accounts.iter().map(|a| a.id).max().unwrap_or(0) + 1)
    }
}
```

## Migration Strategy

### Version Tracking

Add a `version` field to the config:

```json
{
  "version": 1,
  "activeAccount": 1,
  ...
}
```

### Migration Framework

```rust
pub struct ConfigMigrator {
    migrations: Vec<Box<dyn Migration>>,
}

pub trait Migration {
    fn version(&self) -> u32;
    fn migrate(&self, config: &mut serde_json::Value) -> Result<(), MigrationError>;
}

impl ConfigMigrator {
    pub fn new() -> Self {
        Self {
            migrations: vec![
                Box::new(MigrationV1ToV2),
                // Add future migrations here
            ],
        }
    }

    pub fn migrate(&self, config: &mut serde_json::Value) -> Result<u32, MigrationError> {
        let current_version = config
            .get("version")
            .and_then(|v| v.as_u64())
            .unwrap_or(0) as u32;

        let mut version = current_version;

        for migration in &self.migrations {
            if migration.version() > current_version {
                migration.migrate(config)?;
                version = migration.version();
            }
        }

        config["version"] = serde_json::json!(version);
        Ok(version)
    }
}
```

### Example Migration: V1 to V2

```rust
struct MigrationV1ToV2;

impl Migration for MigrationV1ToV2 {
    fn version(&self) -> u32 { 2 }

    fn migrate(&self, config: &mut serde_json::Value) -> Result<(), MigrationError> {
        // Example: Rename 'syncPriorities' to 'sync'
        if let Some(daemon) = config.get_mut("daemon") {
            if let Some(priorities) = daemon.get("syncPriorities").cloned() {
                daemon["sync"] = priorities;
                daemon.as_object_mut().unwrap().remove("syncPriorities");
            }
        }
        Ok(())
    }
}
```

### Backup Before Migration

```rust
impl ConfigLoader {
    fn backup_config(&self) -> Result<PathBuf, ConfigError> {
        let timestamp = chrono::Utc::now().format("%Y%m%d_%H%M%S");
        let backup_path = self.config_path.with_extension(format!("json.backup.{}", timestamp));
        std::fs::copy(&self.config_path, &backup_path)?;
        Ok(backup_path)
    }

    pub fn load_with_migration(&self) -> Result<Config, ConfigError> {
        if !self.config_path.exists() {
            return Ok(Config::default());
        }

        // Read raw JSON
        let content = std::fs::read_to_string(&self.config_path)?;
        let mut value: serde_json::Value = serde_json::from_str(&content)?;

        // Check if migration needed
        let current_version = value.get("version").and_then(|v| v.as_u64()).unwrap_or(0);

        if current_version < CURRENT_CONFIG_VERSION {
            // Backup before migration
            let backup_path = self.backup_config()?;
            log::info!("Config backed up to: {:?}", backup_path);

            // Run migrations
            let migrator = ConfigMigrator::new();
            migrator.migrate(&mut value)?;

            // Save migrated config
            let migrated_content = serde_json::to_string_pretty(&value)?;
            std::fs::write(&self.config_path, migrated_content)?;
        }

        // Parse migrated config
        let config: Config = serde_json::from_value(value)?;
        Ok(config)
    }
}

const CURRENT_CONFIG_VERSION: u64 = 1;
```

## Rust Types

```rust
use serde::{Deserialize, Serialize};
use chrono::{DateTime, Utc};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    #[serde(default)]
    pub version: u32,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_account: Option<i32>,

    #[serde(default)]
    pub staleness: Staleness,

    #[serde(default)]
    pub daemon: DaemonConfig,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub api: Option<ApiConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Staleness {
    #[serde(default = "default_peers_staleness")]
    pub peers: u64,
}

fn default_peers_staleness() -> u64 { 604800 }

impl Default for Staleness {
    fn default() -> Self {
        Self { peers: default_peers_staleness() }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DaemonConfig {
    #[serde(default)]
    pub verbosity: Verbosity,

    #[serde(default)]
    pub sync_priorities: SyncPriorities,
}

impl Default for DaemonConfig {
    fn default() -> Self {
        Self {
            verbosity: Verbosity::Normal,
            sync_priorities: SyncPriorities::default(),
        }
    }
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Verbosity {
    Quiet,
    #[default]
    Normal,
    Verbose,
    Debug,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncPriorities {
    #[serde(default = "default_true")]
    pub dm_and_small_groups: bool,

    #[serde(default)]
    pub large_groups: bool,

    #[serde(default)]
    pub channels: bool,
}

fn default_true() -> bool { true }

impl Default for SyncPriorities {
    fn default() -> Self {
        Self {
            dm_and_small_groups: true,
            large_groups: false,
            channels: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiConfig {
    pub id: i32,
    pub hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountMeta {
    pub id: i32,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,

    pub phone: String,

    pub created_at: DateTime<Utc>,
}
```

## Directory Structure

```
~/.telegram-cli/
├── config.json                 # Global configuration
└── accounts/
    ├── 1/
    │   ├── meta.json          # Account metadata
    │   ├── session.bin        # TDLib session (encrypted)
    │   └── cache/             # Local cache
    │       └── peers.db       # SQLite peer cache
    └── 2/
        ├── meta.json
        ├── session.bin
        └── cache/
            └── peers.db
```

## Security Considerations

1. **API Credentials**: The `api.hash` should be treated as sensitive. Consider:
   - Using environment variables for CI/CD
   - Setting restrictive file permissions (600) on config.json
   - Never logging API credentials

2. **Session Files**: `session.bin` contains authentication data:
   - Encrypted by TDLib using internal key
   - Should never be shared or backed up to cloud storage
   - Set file permissions to 600

3. **File Permissions**:
   ```rust
   #[cfg(unix)]
   fn set_secure_permissions(path: &Path) -> std::io::Result<()> {
       use std::os::unix::fs::PermissionsExt;
       let mut perms = std::fs::metadata(path)?.permissions();
       perms.set_mode(0o600);
       std::fs::set_permissions(path, perms)
   }
   ```

## CLI Integration

```bash
# View current config
tg config show

# Get specific value
tg config get daemon.verbosity

# Set value
tg config set daemon.verbosity debug

# Reset to defaults
tg config reset

# Edit in $EDITOR
tg config edit

# Validate config
tg config validate
```

## Error Messages

User-friendly error messages for common issues:

```
Error: API credentials not configured.

To fix this, either:
  1. Set environment variables:
     export TELEGRAM_API_ID=your_api_id
     export TELEGRAM_API_HASH=your_api_hash

  2. Or add to ~/.telegram-cli/config.json:
     {
       "api": {
         "id": your_api_id,
         "hash": "your_api_hash"
       }
     }

Get your API credentials at: https://my.telegram.org/apps
```
