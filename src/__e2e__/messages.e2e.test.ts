/**
 * E2E tests for messages search command
 */

import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { join } from 'node:path'

import { createChatsCache } from '../db/chats-cache'
import { createMessagesCache } from '../db/messages-cache'
import { initCacheSchema } from '../db/schema'
import { initSyncSchema } from '../db/sync-schema'
import { createUsersCache } from '../db/users-cache'
import { runCliSuccess } from './helpers/cli'
import { createTestEnvironment, type TestEnvironment } from './helpers/setup'

describe('E2E: Messages Search', () => {
  let env: TestEnvironment
  let cacheDb: Database | null = null

  beforeEach(() => {
    env = createTestEnvironment('messages-search')
    env.initDatabase()
    env.seedAccounts([
      { phone: '+1111111111', name: 'Test Account', is_active: true },
    ])

    const cacheDbPath = join(env.dataDir, 'cache.db')
    cacheDb = new Database(cacheDbPath)
    initCacheSchema(cacheDb)
    initSyncSchema(cacheDb)

    seedCacheData(cacheDb)
  })

  afterEach(() => {
    if (cacheDb) {
      cacheDb.close()
      cacheDb = null
    }
    env.cleanup()
  })

  it('filters by chat and sender', async () => {
    const result = await runCliSuccess(
      [
        'messages',
        'search',
        '--query',
        'hello',
        '--chat',
        '@teamchat',
        '--sender',
        '@alice',
      ],
      env.getCliOptions(),
    )

    const response = result.json as {
      success: boolean
      data: {
        results: Array<{
          messageId: number
          chat: { username: string | null }
          sender: { username: string | null }
        }>
        total: number
      }
    }

    expect(response.success).toBe(true)
    expect(response.data.total).toBe(1)
    expect(response.data.results[0]?.messageId).toBe(1)
    expect(response.data.results[0]?.chat.username).toBe('teamchat')
    expect(response.data.results[0]?.sender.username).toBe('alice')
  })

  it('includes deleted messages when requested', async () => {
    const result = await runCliSuccess(
      [
        'messages',
        'search',
        '--query',
        'hello',
        '--chat',
        '@teamchat',
        '--includeDeleted',
      ],
      env.getCliOptions(),
    )

    const response = result.json as {
      success: boolean
      data: {
        results: Array<{ messageId: number; isDeleted: boolean }>
        total: number
        filters: { includeDeleted: boolean }
      }
    }

    const messageIds = response.data.results.map((row) => row.messageId).sort()

    expect(response.success).toBe(true)
    expect(response.data.filters.includeDeleted).toBe(true)
    expect(response.data.total).toBe(2)
    expect(messageIds).toEqual([1, 2])
  })
})

function seedCacheData(db: Database): void {
  const now = Date.now()
  const usersCache = createUsersCache(db)
  const chatsCache = createChatsCache(db)
  const messagesCache = createMessagesCache(db)

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
    chat_id: -100,
    message_id: 2,
    from_id: 11,
    text: 'hello deleted',
    message_type: 'text',
    is_deleted: true,
    date: now - 900,
    raw_json: '{}',
  })

  messagesCache.upsert({
    chat_id: -200,
    message_id: 3,
    from_id: 11,
    text: 'hello random',
    message_type: 'text',
    date: now - 500,
    raw_json: '{}',
  })
}
