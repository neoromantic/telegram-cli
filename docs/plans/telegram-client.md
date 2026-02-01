# Telegram Client Wrapper

> **Note:** This document contains inspiration from telegram-mcp-server, not finalized decisions.

## Design Philosophy

The TelegramClient class wraps mtcute to provide:
- **Higher-level abstractions** for common operations
- **Consistent error handling** with graceful degradation
- **Type normalization** for flexible input
- **Data serialization** for agent-friendly output

## Input Normalization

### Channel ID Handling

```javascript
function normalizeChannelId(channelId) {
  if (typeof channelId === 'bigint') {
    return Number(channelId);
  }
  if (typeof channelId === 'number') {
    return channelId;
  }
  if (typeof channelId === 'string') {
    const trimmed = channelId.trim();
    // If it looks like a username, keep as string
    if (trimmed.startsWith('@') || !/^-?\d+$/.test(trimmed)) {
      return trimmed;
    }
    return Number(trimmed);
  }
  return channelId;
}
```

### Peer Type Normalization

```javascript
function normalizePeerType(peer) {
  if (!peer) return 'chat';
  if (peer.type === 'user' || peer.type === 'bot') return 'user';
  if (peer.type === 'channel') return 'channel';
  if (peer.type === 'chat' && peer.chatType !== 'group') return 'channel';
  return 'chat';
}

function isGroupPeer(peer) {
  if (peer.isGroup === true) return true;
  if (peer.type === 'chat') return true;
  if (peer.type === 'channel' && peer.chatType !== 'channel') return true;
  return false;
}
```

## Message Serialization

```javascript
_serializeMessage(message, peer) {
  // Normalize date (Date object or unix timestamp)
  const dateValue = message.date instanceof Date
    ? Math.floor(message.date.getTime() / 1000)
    : message.date;

  // Extract text from various formats
  const text = message.text ?? message.message ?? null;

  // Resolve sender ID
  const fromId = message.sender?.id
    ?? message.senderId
    ?? message.from_id
    ?? null;

  // Extract topic ID
  const topicId = message.replyTo?.threadId
    ?? message.action?.topicId
    ?? null;

  return {
    id: message.id,
    date: dateValue,
    text,
    message: text,
    from_id: fromId,
    from_username: message.sender?.username ?? null,
    from_display_name: this._buildDisplayName(message.sender),
    from_peer_type: normalizePeerType(message.sender),
    from_is_bot: message.sender?.isBot ?? false,
    peer_type: normalizePeerType(peer),
    peer_id: peer?.id ?? null,
    topic_id: topicId,
    media: summarizeMedia(message.media),
    raw: message.raw ?? message,
  };
}
```

## Media Summarization

```javascript
export function summarizeMedia(media) {
  if (!media) return null;

  const type = media.type ?? media._ ?? null;
  if (!type) return null;

  // Handle webpage previews (nested media)
  if (type === 'webpage' && media.photo) {
    return summarizeMedia(media.photo);
  }

  return {
    type,
    fileId: media.fileId ?? media.file_id ?? null,
    uniqueFileId: media.uniqueFileId ?? media.unique_file_id ?? null,
    fileName: media.fileName ?? media.file_name ?? null,
    mimeType: media.mimeType ?? media.mime_type ?? (type === 'photo' ? 'image/jpeg' : null),
    fileSize: media.fileSize ?? media.file_size ?? null,
    width: media.width ?? null,
    height: media.height ?? null,
    duration: media.duration ?? null,
  };
}
```

## Core Methods

### Dialog Operations

```javascript
async listDialogs(limit = 50) {
  await this.ensureLogin();
  const dialogs = [];

  for await (const dialog of this.client.iterDialogs()) {
    dialogs.push({
      id: dialog.id,
      type: normalizePeerType(dialog),
      title: dialog.title ?? dialog.displayName,
      username: dialog.username ?? null,
      chatType: dialog.chatType ?? null,
      isForum: dialog.isForum ?? false,
      isGroup: isGroupPeer(dialog),
    });

    if (dialogs.length >= limit) break;
  }

  return dialogs;
}

async searchDialogs(keyword, limit = 100) {
  await this.ensureLogin();
  const results = await this.client.searchGlobal(keyword, { limit });
  return results.map(this._serializeDialog.bind(this));
}
```

### Message Operations

```javascript
async getMessagesByChannelId(channelId, limit = 100, options = {}) {
  await this.ensureLogin();
  const peer = await this.client.resolvePeer(normalizeChannelId(channelId));

  const messages = [];
  for await (const message of this.client.iterHistory(peer, {
    limit,
    minId: options.minId,
    maxId: options.maxId,
  })) {
    messages.push(this._serializeMessage(message, peer));
    if (messages.length >= limit) break;
  }

  return {
    peerTitle: peer.title ?? peer.displayName,
    peerId: peer.id,
    peerType: normalizePeerType(peer),
    messages,
  };
}

async getMessageContext(channelId, messageId, options = {}) {
  const { before = 20, after = 20 } = options;
  await this.ensureLogin();

  const peer = await this.client.resolvePeer(normalizeChannelId(channelId));

  // Get the target message
  const [targetMsg] = await this.client.getMessages(peer, [messageId]);

  // Get messages before
  const beforeMsgs = [];
  for await (const msg of this.client.iterHistory(peer, {
    maxId: messageId,
    limit: before
  })) {
    beforeMsgs.push(this._serializeMessage(msg, peer));
  }

  // Get messages after
  const afterMsgs = [];
  for await (const msg of this.client.iterHistory(peer, {
    minId: messageId,
    limit: after,
    reverse: true,
  })) {
    afterMsgs.push(this._serializeMessage(msg, peer));
  }

  return {
    target: this._serializeMessage(targetMsg, peer),
    before: beforeMsgs.reverse(),
    after: afterMsgs,
  };
}
```

### Send Operations

```javascript
async sendTextMessage(channelId, text, options = {}) {
  await this.ensureLogin();
  const peer = await this.client.resolvePeer(normalizeChannelId(channelId));

  const result = await this.client.sendMessage(peer, {
    text,
    replyTo: options.replyToMessageId,
    topicId: options.topicId,
  });

  return { messageId: result.id };
}

async sendFileMessage(channelId, filePath, options = {}) {
  await this.ensureLogin();
  const peer = await this.client.resolvePeer(normalizeChannelId(channelId));

  const result = await this.client.sendMedia(peer, {
    file: filePath,
    caption: options.caption,
    fileName: options.filename,
    topicId: options.topicId,
  });

  return { messageId: result.id };
}
```

### Media Download

```javascript
async downloadMessageMedia(channelId, messageId, options = {}) {
  await this.ensureLogin();
  const peer = await this.client.resolvePeer(normalizeChannelId(channelId));
  const [message] = await this.client.getMessages(peer, [messageId]);

  if (!message?.media) {
    throw new Error('Message has no media');
  }

  const summary = summarizeMedia(message.media);
  const outputPath = resolveDownloadPath(options.outputPath, {
    channelId,
    messageId,
    summary,
  });

  // Ensure directory exists
  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const buffer = await this.client.downloadMedia(message.media);
  fs.writeFileSync(outputPath, buffer);

  return {
    path: outputPath,
    bytes: buffer.length,
    mimeType: summary?.mimeType,
    downloadedAt: new Date().toISOString(),
  };
}
```

## Update Handling

```javascript
async startUpdates() {
  if (this.updatesRunning) return;

  this.rawUpdateHandler = (update) => {
    this.updateEmitter.emit('update', update);
  };

  this.client.onRawUpdate.add(this.rawUpdateHandler);
  await this.client.startUpdates();
  this.updatesRunning = true;
}

onUpdate(listener) {
  this.updateEmitter.on('update', listener);
}

onChannelTooLong(listener) {
  // Handle gaps in update sequence
  this.updateEmitter.on('channelTooLong', listener);
}
```

## Graceful Shutdown

```javascript
async destroy() {
  try {
    if (this.updatesRunning) {
      await this.client.stopUpdates();
      if (this.rawUpdateHandler) {
        this.client.onRawUpdate.remove(this.rawUpdateHandler);
      }
    }
    await this.client.destroy();
  } catch (error) {
    console.warn('Error during client cleanup:', error);
  }
}
```

## Key Patterns

1. **Flexible IDs**: Accept numbers, bigints, strings, @usernames
2. **Consistent output**: Serialize all messages to standard format
3. **Fail-safe methods**: Return null on auth errors, not exceptions
4. **Event emitters**: For real-time update handling
5. **Media abstraction**: Unified media summary format
6. **Graceful cleanup**: Always destroy client on exit
