# Message Sync Service

> **Note:** This document contains inspiration from telegram-mcp-server, not finalized decisions.

## Architecture Overview

The sync service operates in two directions:
1. **Forward sync**: Fetch messages newer than last known
2. **Backward sync (backfill)**: Fetch older messages for history

## Sync Strategy

### Two-Phase Approach

```
Job starts
    ↓
Phase 1: Sync newer messages (_syncNewerMessages)
  - Start from last_message_id
  - Fetch batches moving forward
  - Stop when no more new messages
    ↓
Phase 2: Backfill history (_backfillHistory)
  - Start from oldest_message_id
  - Fetch batches moving backward
  - Stop at target_message_count or backfill_min_date
    ↓
Job complete (status: idle) or paused (status: pending)
```

### Forward Sync Pattern

```javascript
async _syncNewerMessages(channelId) {
  const channel = this._getChannel(channelId);
  let minId = channel.last_message_id || 0;

  while (true) {
    if (this.stopRequested) break;

    const { messages } = await this.telegramClient.getMessagesByChannelId(
      channelId,
      this.batchSize,  // 100
      { minId }  // Only messages newer than this
    );

    const newMessages = messages
      .filter((msg) => msg.id > minId)
      .sort((a, b) => a.id - b.id);

    if (!newMessages.length) break;

    // Batch insert
    const records = newMessages.map((msg) => this._buildMessageRecord(channelId, msg));
    this.insertMessagesTx(records);

    minId = newMessages[newMessages.length - 1].id;

    // Rate limiting
    await delay(this.interBatchDelayMs);  // 1000ms
  }

  this._updateChannelCursors(channelId, { lastMessageId: minId });
}
```

### Backward Sync (Backfill) Pattern

```javascript
async _backfillHistory(job, currentCount, targetCount) {
  const minDateSeconds = job.backfill_min_date
    ? parseIsoDate(job.backfill_min_date)
    : null;

  let cursor = job.cursor_message_id ?? channel.oldest_message_id;

  while (currentCount < targetCount) {
    if (this.stopRequested) break;

    // Fetch messages BEFORE current oldest
    const messages = await this.telegramClient.getMessagesByChannelId(
      channelId,
      this.batchSize,
      { maxId: cursor }  // Get older messages
    );

    if (!messages.length) break;  // No more history

    // Check date limit
    const oldest = messages[messages.length - 1];
    if (minDateSeconds && oldest.date < minDateSeconds) break;

    // Insert and update cursor
    this.insertMessagesTx(messages.map(m => this._buildMessageRecord(channelId, m)));
    cursor = oldest.id;
    currentCount += messages.length;

    await delay(this.interBatchDelayMs);
  }

  return {
    hasMoreOlder: messages.length === this.batchSize,
    cursorMessageId: cursor
  };
}
```

## Job Queue System

### Job States

```typescript
enum JobStatus {
  PENDING = 'pending',      // Ready to process
  IN_PROGRESS = 'in_progress',  // Currently running
  IDLE = 'idle',           // Complete (no more history)
  ERROR = 'error',         // Failed
}
```

### Queue Processing

```javascript
async processQueue() {
  if (this.processing) return;
  this.processing = true;

  try {
    while (true) {
      if (this.stopRequested) break;

      const job = this._getNextJob();  // Gets oldest PENDING job
      if (!job) break;

      await this._processJob(job);
      await delay(this.interJobDelayMs);  // 3000ms between jobs
    }
  } finally {
    this.processing = false;
  }
}

_getNextJob() {
  return this.db.prepare(`
    SELECT * FROM jobs
    WHERE status = 'pending'
    ORDER BY updated_at ASC
    LIMIT 1
  `).get();
}
```

## Rate Limiting

### Multi-Level Delays

```javascript
this.batchSize = 100;              // Messages per API call
this.interBatchDelayMs = 1000;     // 1s between batches
this.interJobDelayMs = 3000;       // 3s between jobs
```

### Telegram FLOOD_WAIT Handling

```javascript
try {
  await this._processJob(job);
} catch (error) {
  // Parse Telegram's rate limit error
  const waitMatch = /wait of (\d+) seconds is required/i.exec(error.message);
  if (waitMatch) {
    const waitSeconds = Number(waitMatch[1]);

    // Pause job and wait
    this._updateJobStatus(job.id, 'pending', `Rate limited, waiting ${waitSeconds}s`);
    await delay(waitSeconds * 1000);
  } else {
    this._markJobError(job.id, error);
  }
}
```

## Real-Time Sync

### Event Handlers

```javascript
startRealtimeSync() {
  this.telegramClient.client.onNewMessage.add((message) => {
    this._handleIncomingMessage(message, { isEdit: false });
  });

  this.telegramClient.client.onEditMessage.add((message) => {
    this._handleIncomingMessage(message, { isEdit: true });
  });

  this.telegramClient.client.onDeleteMessage.add((update) => {
    this._handleDeleteMessage(update);
  });
}

_handleIncomingMessage(message, { isEdit }) {
  const channelId = String(message.chat.id);
  const channel = this._ensureChannelFromPeer(channelId, message.chat);

  if (!channel?.sync_enabled) return;

  const record = this._buildMessageRecord(channelId, message);

  if (isEdit) {
    this.upsertMessageStmt.run(record);
  } else {
    this.insertMessageStmt.run(record);
  }

  this._updateChannelCursors(channelId, { lastMessageId: message.id });
}
```

## Graceful Shutdown

```javascript
async shutdown() {
  this.stopRequested = true;

  // Wait for current job to finish
  while (this.processing) {
    await delay(100);
  }

  // Reset in-progress jobs to pending (for resume on restart)
  this.db.prepare(`
    UPDATE jobs
    SET status = 'pending', error = NULL, updated_at = CURRENT_TIMESTAMP
    WHERE status = 'in_progress'
  `).run();

  // Remove event handlers
  this.telegramClient.client.onNewMessage.remove(this.handlers.newMessage);
  this.telegramClient.client.onEditMessage.remove(this.handlers.editMessage);
}
```

## Message Record Building

```javascript
function buildMessageRecord(channelId, message) {
  const links = extractLinksFromText(message.text);
  const files = extractFileNames(message);
  const sender = buildSenderText(message);

  return {
    channel_id: channelId,
    message_id: message.id,
    topic_id: message.topic_id ?? null,
    date: message.date,
    from_id: message.from_id,
    text: message.text,
    links: links.join(' '),       // Denormalized for search
    files: files.join(' '),
    sender: sender,
    raw_json: JSON.stringify(message),
  };
}

function extractLinksFromText(text) {
  if (!text) return [];
  const URL_PATTERN = /https?:\/\/[^\s<>"')]+/giu;
  const matches = text.match(URL_PATTERN) ?? [];
  return [...new Set(matches.map(url =>
    url.replace(/[),.!?;:]+$/g, '')  // Clean trailing punctuation
  ))];
}
```

## Cursor Management

```javascript
_updateChannelCursors(channelId, { lastMessageId, oldestMessageId }) {
  const existing = this._getChannel(channelId);

  // Only move lastMessageId forward
  const newLast = Math.max(existing?.last_message_id ?? 0, lastMessageId ?? 0);

  // Only move oldestMessageId backward
  const newOldest = Math.min(
    existing?.oldest_message_id ?? Infinity,
    oldestMessageId ?? Infinity
  );

  this.db.prepare(`
    UPDATE channels
    SET last_message_id = ?, oldest_message_id = ?, updated_at = CURRENT_TIMESTAMP
    WHERE channel_id = ?
  `).run(newLast, newOldest === Infinity ? null : newOldest, channelId);
}
```

## Key Insights

1. **Bidirectional sync**: Forward (incremental) + backward (backfill)
2. **Resumable**: Cursors saved in database, survives restarts
3. **Rate-limit aware**: Parses Telegram errors, backs off appropriately
4. **Real-time capable**: Event handlers for live updates
5. **Transaction batching**: 100 messages per batch insert
6. **Graceful shutdown**: Resets in-progress jobs for resume
