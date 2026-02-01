# Group Operations

> **Note:** This document contains inspiration from telegram-mcp-server, not finalized decisions.

## Supported Operations

| Operation | Method | Description |
|-----------|--------|-------------|
| List groups | `listGroups()` | List all groups/supergroups |
| Get info | `getGroupInfo()` | Detailed group metadata |
| Rename | `renameGroup()` | Change group title |
| Add members | `addGroupMembers()` | Add users to group |
| Remove members | `removeGroupMembers()` | Remove users from group |
| Get invite link | `getGroupInviteLink()` | Get primary invite link |
| Revoke invite link | `revokeGroupInviteLink()` | Revoke and regenerate |
| Join group | `joinGroup()` | Join via invite link |
| Leave group | `leaveGroup()` | Leave group/channel |

## Implementation Patterns

### List Groups

```javascript
async listGroups(options = {}) {
  await this.ensureLogin();
  const groups = [];

  for await (const dialog of this.client.iterDialogs()) {
    if (!isGroupPeer(dialog)) continue;

    groups.push({
      id: dialog.id,
      title: dialog.title ?? dialog.displayName,
      username: dialog.username ?? null,
      chatType: dialog.chatType ?? null,
      isForum: dialog.isForum ?? false,
      membersCount: dialog.membersCount ?? null,
    });

    if (options.limit && groups.length >= options.limit) break;
  }

  return groups;
}

function isGroupPeer(peer) {
  if (peer.isGroup === true) return true;
  if (peer.type === 'chat') return true;
  if (peer.type === 'channel' && peer.chatType !== 'channel') return true;
  return false;
}
```

### Get Group Info

```javascript
async getGroupInfo(channelId) {
  await this.ensureLogin();
  const peer = await this.client.resolvePeer(normalizeChannelId(channelId));

  // Get full chat info
  const fullChat = await this.client.getFullChat(peer);

  return {
    id: peer.id,
    title: peer.title ?? peer.displayName,
    username: peer.username ?? null,
    chatType: peer.chatType ?? null,
    isForum: peer.isForum ?? false,
    membersCount: fullChat.membersCount ?? peer.membersCount ?? null,
    about: fullChat.about ?? fullChat.bio ?? null,
    linkedChatId: fullChat.linkedChatId ?? null,
    slowModeSeconds: fullChat.slowModeSeconds ?? null,
  };
}
```

### Rename Group

```javascript
async renameGroup(channelId, title) {
  await this.ensureLogin();
  const peer = await this.client.resolvePeer(normalizeChannelId(channelId));

  await this.client.editTitle(peer, title);

  return { success: true, newTitle: title };
}
```

### Add Members

```javascript
async addGroupMembers(channelId, userIds) {
  await this.ensureLogin();
  const peer = await this.client.resolvePeer(normalizeChannelId(channelId));

  const failed = [];

  for (const userId of userIds) {
    try {
      const userPeer = await this.client.resolvePeer(normalizeChannelId(userId));
      await this.client.addChatMembers(peer, [userPeer]);
    } catch (error) {
      failed.push({ userId, error: error.message });
    }
  }

  return {
    added: userIds.length - failed.length,
    failed
  };
}
```

### Remove Members

```javascript
async removeGroupMembers(channelId, userIds) {
  await this.ensureLogin();
  const peer = await this.client.resolvePeer(normalizeChannelId(channelId));

  const removed = [];
  const failed = [];

  for (const userId of userIds) {
    try {
      const userPeer = await this.client.resolvePeer(normalizeChannelId(userId));
      await this.client.banChatMember(peer, userPeer);
      // Optionally unban immediately to just remove without ban
      await this.client.unbanChatMember(peer, userPeer);
      removed.push(userId);
    } catch (error) {
      failed.push({ userId, error: error.message });
    }
  }

  return { removed, failed };
}
```

### Invite Links

```javascript
async getGroupInviteLink(channelId) {
  await this.ensureLogin();
  const peer = await this.client.resolvePeer(normalizeChannelId(channelId));

  const result = await this.client.exportInviteLink(peer);

  return {
    link: result.link,
    isPrimary: true,
    isRevoked: false,
  };
}

async revokeGroupInviteLink(channelId, link) {
  await this.ensureLogin();
  const peer = await this.client.resolvePeer(normalizeChannelId(channelId));

  // Revoke specific link or primary
  if (link) {
    await this.client.revokeInviteLink(peer, link);
  }

  // Generate new primary link
  const newLink = await this.client.exportInviteLink(peer);

  return {
    oldLink: link,
    newLink: newLink.link,
  };
}
```

### Join/Leave

```javascript
async joinGroup(invite) {
  await this.ensureLogin();

  // Parse invite link or hash
  const hash = invite.includes('t.me/')
    ? invite.split('/').pop().replace('+', '')
    : invite;

  const result = await this.client.joinChat(hash);

  return {
    id: result.id,
    title: result.title,
    joined: true,
  };
}

async leaveGroup(channelId) {
  await this.ensureLogin();
  const peer = await this.client.resolvePeer(normalizeChannelId(channelId));

  await this.client.leaveChat(peer);

  return { left: true };
}
```

## CLI Commands

```bash
# List groups
tg groups list
tg groups list --limit 20

# Show group info
tg groups info @groupname
tg groups info -1001234567890

# Rename group
tg groups rename @groupname "New Group Name"

# Manage members
tg groups members add @groupname @user1 @user2
tg groups members remove @groupname @user1

# Invite links
tg groups invite-link get @groupname
tg groups invite-link revoke @groupname

# Join/leave
tg groups join "https://t.me/+abcdefg"
tg groups leave @groupname
```

## Citty Commands

```typescript
export const groupsCommand = defineCommand({
  meta: { name: 'groups', description: 'Group management' },
  subCommands: {
    list: defineCommand({
      meta: { name: 'list', description: 'List groups' },
      args: {
        limit: { type: 'string', default: '50' },
      },
      async run({ args }) {
        const groups = await listGroups({ limit: parseInt(args.limit, 10) });
        console.log(JSON.stringify(groups, null, 2));
      },
    }),

    info: defineCommand({
      meta: { name: 'info', description: 'Show group info' },
      args: {
        group: { type: 'positional', required: true },
      },
      async run({ args }) {
        const info = await getGroupInfo(args.group);
        console.log(JSON.stringify(info, null, 2));
      },
    }),

    rename: defineCommand({
      meta: { name: 'rename', description: 'Rename group' },
      args: {
        group: { type: 'positional', required: true },
        title: { type: 'positional', required: true },
      },
      async run({ args }) {
        const result = await renameGroup(args.group, args.title);
        console.log(JSON.stringify(result, null, 2));
      },
    }),
  },
});
```

## Error Handling

```javascript
// Common group operation errors
try {
  await addGroupMembers(channelId, userIds);
} catch (error) {
  if (error.message.includes('CHAT_ADMIN_REQUIRED')) {
    throw new Error('You need admin rights to add members');
  }
  if (error.message.includes('USER_PRIVACY_RESTRICTED')) {
    throw new Error('User privacy settings prevent adding them');
  }
  if (error.message.includes('PEER_FLOOD')) {
    throw new Error('Too many requests, try again later');
  }
  throw error;
}
```

## Key Patterns

1. **Flexible IDs**: Accept numeric IDs or @usernames
2. **Batch operations**: Add/remove multiple members at once
3. **Error collection**: Return list of failed operations, not throw
4. **Invite link management**: Get/revoke/regenerate
5. **Privacy awareness**: Handle user privacy restrictions gracefully
