# Real-Time Updates

> **Note:** This document contains inspiration from telegram-mcp-server, not finalized decisions.

## Update Architecture

mtcute provides event-based update handling:

```javascript
// Available events
client.onNewMessage      // New message received
client.onEditMessage     // Message edited
client.onDeleteMessage   // Message(s) deleted
client.onRawUpdate       // Low-level TL updates
```

## Setting Up Real-Time Sync

```javascript
class MessageSyncService {
  startRealtimeSync() {
    // Store handlers for cleanup
    this.handlers = {
      newMessage: (message) => this._handleIncomingMessage(message, { isEdit: false }),
      editMessage: (message) => this._handleIncomingMessage(message, { isEdit: true }),
      deleteMessage: (update) => this._handleDeleteMessage(update),
    };

    // Register handlers
    this.telegramClient.client.onNewMessage.add(this.handlers.newMessage);
    this.telegramClient.client.onEditMessage.add(this.handlers.editMessage);
    this.telegramClient.client.onDeleteMessage.add(this.handlers.deleteMessage);

    // Handle channel gaps
    this.telegramClient.onChannelTooLong((payload) => {
      this._handleChannelTooLong(payload);
    });
  }

  stopRealtimeSync() {
    this.telegramClient.client.onNewMessage.remove(this.handlers.newMessage);
    this.telegramClient.client.onEditMessage.remove(this.handlers.editMessage);
    this.telegramClient.client.onDeleteMessage.remove(this.handlers.deleteMessage);
  }
}
```

## Handling New/Edited Messages

```javascript
_handleIncomingMessage(message, { isEdit }) {
  const channelId = String(message.chat.id);

  // Ensure channel exists in registry
  const channel = this._ensureChannelFromPeer(channelId, message.chat);

  // Check if sync is enabled for this channel
  if (!channel?.sync_enabled) return;

  // Serialize message
  const serialized = this.telegramClient._serializeMessage(message, message.chat);
  const record = this._buildMessageRecord(channelId, serialized);

  // Insert or update
  if (isEdit) {
    this.upsertMessageStmt.run(record);
  } else {
    this.insertMessageStmt.run(record);
  }

  // Update denormalized tables
  this._replaceMessageLinks(record);
  this._replaceMessageMedia(record);

  // Update channel cursors
  this._updateChannelCursors(channelId, {
    lastMessageId: message.id,
    lastMessageDate: new Date(message.date * 1000).toISOString(),
  });
}

_ensureChannelFromPeer(channelId, peer) {
  const existing = this._getChannel(channelId);
  if (existing) return existing;

  // Create channel entry from peer info
  this.db.prepare(`
    INSERT OR IGNORE INTO channels (channel_id, peer_title, peer_type, username, sync_enabled)
    VALUES (?, ?, ?, ?, 1)
  `).run(
    channelId,
    peer.title ?? peer.displayName ?? null,
    normalizePeerType(peer),
    peer.username ?? null
  );

  return this._getChannel(channelId);
}
```

## Handling Deleted Messages

```javascript
_handleDeleteMessage(update) {
  const channelId = String(update.chatId ?? update.peerId);
  const ids = update.messageIds ?? [update.messageId];

  if (!ids.length) return;

  const channel = this._getChannel(channelId);
  if (!channel?.sync_enabled) return;

  const placeholders = ids.map(() => '?').join(', ');

  // Delete from messages table
  this.db.prepare(`
    DELETE FROM messages
    WHERE channel_id = ? AND message_id IN (${placeholders})
  `).run(channelId, ...ids);

  // Delete from links table
  this.db.prepare(`
    DELETE FROM message_links
    WHERE channel_id = ? AND message_id IN (${placeholders})
  `).run(channelId, ...ids);

  // Delete from media table
  this.db.prepare(`
    DELETE FROM message_media
    WHERE channel_id = ? AND message_id IN (${placeholders})
  `).run(channelId, ...ids);

  // FTS triggers handle message_search automatically
}
```

## Channel Too Long (Gap Handling)

When Telegram can't provide incremental updates (too many missed), it sends a "channel too long" event:

```javascript
_handleChannelTooLong({ channelId, diff }) {
  // Parse the diff to get available messages
  const peers = PeersIndex.from(diff);
  const records = [];

  for (const rawMessage of diff.messages) {
    if (rawMessage._ === 'messageEmpty') continue;

    const message = new Message(rawMessage, peers);
    const serialized = this.telegramClient._serializeMessage(message, message.chat);
    records.push(this._buildMessageRecord(String(message.chat?.id), serialized));
  }

  // Batch insert recovered messages
  if (records.length) {
    this.insertMessagesTx(records);
  }

  // Trigger full sync to catch up
  this._syncNewerMessages(channelId);
}
```

## Update Event Emitter Pattern

```javascript
// In TelegramClient
class TelegramClient {
  constructor(...args) {
    this.updateEmitter = new EventEmitter();
  }

  async startUpdates() {
    if (this.updatesRunning) return;

    this.rawUpdateHandler = (update) => {
      this.updateEmitter.emit('update', update);

      // Detect channel too long
      if (update._ === 'updateChannelTooLong') {
        this.updateEmitter.emit('channelTooLong', {
          channelId: String(update.channelId),
          pts: update.pts,
        });
      }
    };

    this.client.onRawUpdate.add(this.rawUpdateHandler);
    await this.client.startUpdates();
    this.updatesRunning = true;
  }

  onUpdate(listener) {
    this.updateEmitter.on('update', listener);
  }

  onChannelTooLong(listener) {
    this.updateEmitter.on('channelTooLong', listener);
  }
}
```

## Starting Updates in Client

```javascript
async initializeDialogCache() {
  console.log('Initializing dialog list...');

  const loginSuccess = await this.login();
  if (!loginSuccess) {
    throw new Error('Failed to login');
  }

  await this.startUpdates();

  console.log('Dialogs ready, real-time updates active.');
  return true;
}
```

## Graceful Shutdown

```javascript
async shutdown() {
  // Signal stop
  this.stopRequested = true;

  // Wait for in-progress operations
  while (this.processing) {
    await delay(100);
  }

  // Remove real-time handlers
  this.stopRealtimeSync();

  // Reset in-progress jobs for resume on restart
  this.db.prepare(`
    UPDATE jobs
    SET status = 'pending', error = NULL, updated_at = CURRENT_TIMESTAMP
    WHERE status = 'in_progress'
  `).run();

  // Close database
  this.db.close();
}
```

## Daemon Mode Integration

For telegram-cli daemon:

```typescript
// src/daemon/index.ts
async function startDaemon() {
  const { telegramClient, messageSyncService } = createServices();

  // Initialize and start real-time sync
  await telegramClient.initializeDialogCache();
  messageSyncService.startRealtimeSync();
  messageSyncService.resumePendingJobs();

  console.log('Daemon started, listening for updates...');

  // Handle shutdown signals
  process.on('SIGINT', async () => {
    console.log('Shutting down...');
    await messageSyncService.shutdown();
    await telegramClient.destroy();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    await messageSyncService.shutdown();
    await telegramClient.destroy();
    process.exit(0);
  });
}
```

## Key Patterns

1. **Event handlers**: Register/unregister for clean lifecycle
2. **Channel gating**: Only sync enabled channels
3. **Upsert on edit**: Use ON CONFLICT for message updates
4. **Cascade deletes**: Clean up links/media on message delete
5. **Gap recovery**: Handle "channel too long" with full sync
6. **Graceful shutdown**: Wait for operations, reset state, cleanup
