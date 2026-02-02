/**
 * Tests for messages search service (FTS5)
 */
import { Database } from 'bun:sqlite'
import { beforeEach, describe, expect, it } from 'bun:test'
import { createChatsCache } from '../db/chats-cache'
import { createMessagesCache } from '../db/messages-cache'
import { createMessagesSearch } from '../db/messages-search'
import { initCacheSchema } from '../db/schema'
import { initSyncSchema } from '../db/sync-schema'
import { createUsersCache } from '../db/users-cache'

describe('MessagesSearch', () => {
  let db: Database
  let messagesCache: ReturnType<typeof createMessagesCache>
  let usersCache: ReturnType<typeof createUsersCache>
  let chatsCache: ReturnType<typeof createChatsCache>

  beforeEach(() => {
    db = new Database(':memory:')
    initCacheSchema(db)
    initSyncSchema(db)
    messagesCache = createMessagesCache(db)
    usersCache = createUsersCache(db)
    chatsCache = createChatsCache(db)
  })

  function seedBaseData(): void {
    const now = Date.now()

    usersCache.upsert({
      user_id: '10',
      username: 'alice',
      first_name: 'Alice',
      last_name: 'Able',
      fetched_at: now,
      raw_json: '{}',
    })

    usersCache.upsert({
      user_id: '11',
      username: 'bob',
      first_name: 'Bob',
      last_name: 'Baker',
      fetched_at: now,
      raw_json: '{}',
    })

    chatsCache.upsert({
      chat_id: '-100',
      type: 'supergroup',
      title: 'Team Chat',
      username: 'teamchat',
      member_count: 3,
      access_hash: null,
      is_creator: 0,
      is_admin: 0,
      last_message_id: null,
      last_message_at: null,
      fetched_at: now,
      raw_json: '{}',
    })

    chatsCache.upsert({
      chat_id: '-200',
      type: 'group',
      title: 'Random',
      username: 'randomchat',
      member_count: 2,
      access_hash: null,
      is_creator: 0,
      is_admin: 0,
      last_message_id: null,
      last_message_at: null,
      fetched_at: now,
      raw_json: '{}',
    })

    messagesCache.upsert({
      chat_id: -100,
      message_id: 1,
      from_id: 10,
      text: 'hello team',
      message_type: 'text',
      date: now - 1000,
      raw_json: '{}',
    })

    messagesCache.upsert({
      chat_id: -200,
      message_id: 2,
      from_id: 11,
      text: 'hello random',
      message_type: 'text',
      date: now - 500,
      raw_json: '{}',
    })

    messagesCache.upsert({
      chat_id: -100,
      message_id: 3,
      from_id: 11,
      text: 'hello deleted',
      message_type: 'text',
      is_deleted: true,
      date: now - 200,
      raw_json: '{}',
    })
  }

  it('searches text and orders results by date desc', () => {
    seedBaseData()

    const search = createMessagesSearch(db)
    const results = search.search('hello')

    expect(results).toHaveLength(2)
    expect(results[0]!.message_id).toBe(2)
    expect(results[1]!.message_id).toBe(1)
  })

  it('filters by chat, sender, and includeDeleted', () => {
    seedBaseData()

    const search = createMessagesSearch(db)

    const filtered = search.search('hello', {
      chatUsername: 'teamchat',
      senderUsername: 'alice',
    })

    expect(filtered).toHaveLength(1)
    expect(filtered[0]!.chat_username).toBe('teamchat')
    expect(filtered[0]!.sender_username).toBe('alice')

    const includeDeleted = search.search('hello', {
      chatUsername: 'teamchat',
      includeDeleted: true,
    })

    expect(includeDeleted).toHaveLength(2)
    expect(includeDeleted.map((row) => row.message_id).sort()).toEqual([1, 3])
  })
})
