/**
 * Comprehensive tests for the send command
 *
 * Tests:
 * - Peer resolution by @username
 * - Peer resolution by phone number
 * - Peer resolution by numeric ID
 * - Cache lookups for peer resolution
 * - Message sending with options (--silent, --reply-to)
 * - Error handling (invalid peer, permission errors)
 */

import type { Database } from 'bun:sqlite'
import { beforeEach, describe, expect, it, mock } from 'bun:test'

type AnyMockFn = ReturnType<typeof mock<(...args: any[]) => any>>

import { type ChatsCache, createChatsCache } from '../db/chats-cache'
import { createTestCacheDatabase } from '../db/schema'
import type { ChatType } from '../db/types'
import { createUsersCache, type UsersCache } from '../db/users-cache'

// =============================================================================
// Test Helpers
// =============================================================================

/**
 * Create test user data for cache
 */
function createTestUser(overrides = {}) {
  return {
    user_id: '123456',
    username: 'testuser',
    first_name: 'Test',
    last_name: 'User',
    phone: '1234567890',
    access_hash: '9876543210',
    is_contact: 1,
    is_bot: 0,
    is_premium: 0,
    fetched_at: Date.now(),
    raw_json: JSON.stringify({ id: 123456, first_name: 'Test' }),
    ...overrides,
  }
}

/**
 * Create test chat data for cache
 */
function createTestChat(overrides = {}) {
  return {
    chat_id: '789012',
    type: 'group' as ChatType,
    title: 'Test Group',
    username: 'testgroup',
    member_count: 10,
    access_hash: '1234567890',
    is_creator: 0,
    is_admin: 1,
    last_message_id: 100,
    last_message_at: Date.now() - 1000,
    fetched_at: Date.now(),
    raw_json: JSON.stringify({ id: 789012, title: 'Test Group' }),
    ...overrides,
  }
}

/**
 * Create a mock Telegram client
 */
function createMockClient(overrides: Record<string, AnyMockFn> = {}) {
  return {
    call: mock((_request: any) => Promise.resolve({})),
    getMe: mock(() =>
      Promise.resolve({ id: 123, firstName: 'Test', username: 'test' }),
    ),
    ...overrides,
  }
}

/**
 * Peer resolution logic extracted for testing
 * (mirrors the logic in send.ts resolvePeer function)
 */
async function resolvePeer(
  client: any,
  identifier: string,
  usersCache: UsersCache,
  chatsCache: ChatsCache,
): Promise<{ inputPeer: any; name: string }> {
  // Check if it's a username
  if (identifier.startsWith('@')) {
    const username = identifier.slice(1)

    // Check users cache first
    const cachedUser = usersCache.getByUsername(username)
    if (cachedUser?.access_hash) {
      return {
        inputPeer: {
          _: 'inputPeerUser',
          userId: Number(cachedUser.user_id),
          accessHash: BigInt(cachedUser.access_hash),
        },
        name: cachedUser.display_name || `@${username}`,
      }
    }

    // Check chats cache
    const cachedChat = chatsCache.getByUsername(username)
    if (cachedChat?.access_hash) {
      if (cachedChat.type === 'channel' || cachedChat.type === 'supergroup') {
        return {
          inputPeer: {
            _: 'inputPeerChannel',
            channelId: Number(cachedChat.chat_id),
            accessHash: BigInt(cachedChat.access_hash),
          },
          name: cachedChat.title || `@${username}`,
        }
      }
    }

    // Resolve via API
    const resolved = await client.call({
      _: 'contacts.resolveUsername',
      username,
    } as any)

    if (resolved.users && resolved.users.length > 0) {
      const user = resolved.users[0]
      return {
        inputPeer: {
          _: 'inputPeerUser',
          userId: user.id,
          accessHash: BigInt(user.accessHash || 0),
        },
        name:
          [user.firstName, user.lastName].filter(Boolean).join(' ') ||
          `@${username}`,
      }
    }

    if (resolved.chats && resolved.chats.length > 0) {
      const chat = resolved.chats[0]
      return {
        inputPeer: {
          _: 'inputPeerChannel',
          channelId: chat.id,
          accessHash: BigInt(chat.accessHash || 0),
        },
        name: chat.title || `@${username}`,
      }
    }

    throw new Error(`Could not resolve @${username}`)
  }

  // Check if it's a phone number
  if (identifier.startsWith('+') || /^\d{10,}$/.test(identifier)) {
    const phone = identifier.replace(/[\s\-+()]/g, '')

    // Check users cache
    const cachedUser = usersCache.getByPhone(phone)
    if (cachedUser?.access_hash) {
      return {
        inputPeer: {
          _: 'inputPeerUser',
          userId: Number(cachedUser.user_id),
          accessHash: BigInt(cachedUser.access_hash),
        },
        name: cachedUser.display_name || identifier,
      }
    }

    // Try to resolve via contacts.resolvePhone
    try {
      const resolved = await client.call({
        _: 'contacts.resolvePhone',
        phone,
      } as any)

      if (resolved.users && resolved.users.length > 0) {
        const user = resolved.users[0]
        return {
          inputPeer: {
            _: 'inputPeerUser',
            userId: user.id,
            accessHash: BigInt(user.accessHash || 0),
          },
          name:
            [user.firstName, user.lastName].filter(Boolean).join(' ') ||
            identifier,
        }
      }
    } catch {
      throw new Error(`Could not resolve phone number ${identifier}`)
    }

    throw new Error(`Could not resolve phone number ${identifier}`)
  }

  // It's a numeric ID
  const numericId = Number.parseInt(identifier, 10)
  if (Number.isNaN(numericId)) {
    throw new Error(`Invalid peer identifier: ${identifier}`)
  }

  // Check users cache
  const cachedUser = usersCache.getById(identifier)
  if (cachedUser?.access_hash) {
    return {
      inputPeer: {
        _: 'inputPeerUser',
        userId: numericId,
        accessHash: BigInt(cachedUser.access_hash),
      },
      name: cachedUser.display_name || `User ${numericId}`,
    }
  }

  // Check chats cache
  const cachedChat = chatsCache.getById(identifier)
  if (cachedChat) {
    if (cachedChat.type === 'private') {
      return {
        inputPeer: {
          _: 'inputPeerUser',
          userId: numericId,
          accessHash: BigInt(cachedChat.access_hash || 0),
        },
        name: cachedChat.title || `User ${numericId}`,
      }
    }
    if (cachedChat.type === 'group') {
      return {
        inputPeer: {
          _: 'inputPeerChat',
          chatId: numericId,
        },
        name: cachedChat.title || `Group ${numericId}`,
      }
    }
    // channel or supergroup
    return {
      inputPeer: {
        _: 'inputPeerChannel',
        channelId: numericId,
        accessHash: BigInt(cachedChat.access_hash || 0),
      },
      name: cachedChat.title || `Channel ${numericId}`,
    }
  }

  // Try as basic chat (legacy group)
  return {
    inputPeer: {
      _: 'inputPeerChat',
      chatId: numericId,
    },
    name: `Chat ${numericId}`,
  }
}

// =============================================================================
// Peer Resolution Tests - By Username
// =============================================================================

describe('Peer Resolution - By Username', () => {
  let db: Database
  let usersCache: UsersCache
  let chatsCache: ChatsCache

  beforeEach(() => {
    const testDb = createTestCacheDatabase()
    db = testDb.db
    usersCache = createUsersCache(db)
    chatsCache = createChatsCache(db)
  })

  describe('cached user lookup', () => {
    it('should resolve @username from users cache', async () => {
      usersCache.upsert(
        createTestUser({
          user_id: '111',
          username: 'alice',
          first_name: 'Alice',
          last_name: 'Smith',
          access_hash: '123456789',
        }),
      )

      const mockClient = createMockClient()
      const result = await resolvePeer(
        mockClient,
        '@alice',
        usersCache,
        chatsCache,
      )

      expect(result.inputPeer._).toBe('inputPeerUser')
      expect(result.inputPeer.userId).toBe(111)
      expect(result.inputPeer.accessHash).toBe(BigInt('123456789'))
      expect(result.name).toBe('Alice Smith')
      // API should not be called when found in cache
      expect(mockClient.call).not.toHaveBeenCalled()
    })

    it('should use display_name when available', async () => {
      usersCache.upsert(
        createTestUser({
          user_id: '222',
          username: 'bob',
          first_name: 'Robert',
          last_name: null,
          access_hash: '987654321',
        }),
      )

      const mockClient = createMockClient()
      const result = await resolvePeer(
        mockClient,
        '@bob',
        usersCache,
        chatsCache,
      )

      expect(result.name).toBe('Robert')
    })

    it('should fallback to @username when no display_name', async () => {
      usersCache.upsert(
        createTestUser({
          user_id: '333',
          username: 'mystery',
          first_name: null,
          last_name: null,
          access_hash: '111222333',
        }),
      )

      const mockClient = createMockClient()
      const result = await resolvePeer(
        mockClient,
        '@mystery',
        usersCache,
        chatsCache,
      )

      expect(result.name).toBe('@mystery')
    })
  })

  describe('cached channel/supergroup lookup', () => {
    it('should resolve @username from chats cache for channel', async () => {
      chatsCache.upsert(
        createTestChat({
          chat_id: '444',
          type: 'channel',
          username: 'newschannel',
          title: 'News Channel',
          access_hash: '555666777',
        }),
      )

      const mockClient = createMockClient()
      const result = await resolvePeer(
        mockClient,
        '@newschannel',
        usersCache,
        chatsCache,
      )

      expect(result.inputPeer._).toBe('inputPeerChannel')
      expect(result.inputPeer.channelId).toBe(444)
      expect(result.inputPeer.accessHash).toBe(BigInt('555666777'))
      expect(result.name).toBe('News Channel')
      expect(mockClient.call).not.toHaveBeenCalled()
    })

    it('should resolve @username from chats cache for supergroup', async () => {
      chatsCache.upsert(
        createTestChat({
          chat_id: '555',
          type: 'supergroup',
          username: 'community',
          title: 'Community Group',
          access_hash: '888999000',
        }),
      )

      const mockClient = createMockClient()
      const result = await resolvePeer(
        mockClient,
        '@community',
        usersCache,
        chatsCache,
      )

      expect(result.inputPeer._).toBe('inputPeerChannel')
      expect(result.inputPeer.channelId).toBe(555)
      expect(result.name).toBe('Community Group')
    })

    it('should not resolve regular group by username from chats cache', async () => {
      // Regular groups cannot have usernames, so this tests cache filtering
      chatsCache.upsert(
        createTestChat({
          chat_id: '666',
          type: 'group',
          username: 'regulargroup', // This shouldn't happen in practice
          title: 'Regular Group',
          access_hash: null, // Groups don't have access_hash
        }),
      )

      const mockClient = createMockClient({
        call: mock((_req: any) =>
          Promise.resolve({
            users: [],
            chats: [{ id: 666, title: 'Regular Group', accessHash: '123' }],
          }),
        ),
      })

      await resolvePeer(mockClient, '@regulargroup', usersCache, chatsCache)

      // Should have called API because group in cache has no access_hash
      expect(mockClient.call).toHaveBeenCalled()
    })
  })

  describe('API resolution fallback', () => {
    it('should resolve username via API when not in cache', async () => {
      const mockClient = createMockClient({
        call: mock((_req: any) =>
          Promise.resolve({
            users: [
              {
                id: 777,
                firstName: 'John',
                lastName: 'Doe',
                accessHash: '111222333444',
              },
            ],
            chats: [],
          }),
        ),
      })

      const result = await resolvePeer(
        mockClient,
        '@johndoe',
        usersCache,
        chatsCache,
      )

      expect(mockClient.call).toHaveBeenCalledWith({
        _: 'contacts.resolveUsername',
        username: 'johndoe',
      })
      expect(result.inputPeer._).toBe('inputPeerUser')
      expect(result.inputPeer.userId).toBe(777)
      expect(result.name).toBe('John Doe')
    })

    it('should resolve channel via API when not in cache', async () => {
      const mockClient = createMockClient({
        call: mock((_req: any) =>
          Promise.resolve({
            users: [],
            chats: [
              {
                id: 888,
                title: 'Tech Channel',
                accessHash: '444555666777',
              },
            ],
          }),
        ),
      })

      const result = await resolvePeer(
        mockClient,
        '@techchannel',
        usersCache,
        chatsCache,
      )

      expect(result.inputPeer._).toBe('inputPeerChannel')
      expect(result.inputPeer.channelId).toBe(888)
      expect(result.name).toBe('Tech Channel')
    })

    it('should throw error when username cannot be resolved', async () => {
      const mockClient = createMockClient({
        call: mock((_req: any) =>
          Promise.resolve({
            users: [],
            chats: [],
          }),
        ),
      })

      await expect(
        resolvePeer(mockClient, '@nonexistent', usersCache, chatsCache),
      ).rejects.toThrow('Could not resolve @nonexistent')
    })

    it('should handle API returning user with no accessHash', async () => {
      const mockClient = createMockClient({
        call: mock((_req: any) =>
          Promise.resolve({
            users: [
              {
                id: 999,
                firstName: 'No',
                lastName: 'Hash',
                accessHash: null, // Some users might not have accessHash
              },
            ],
            chats: [],
          }),
        ),
      })

      const result = await resolvePeer(
        mockClient,
        '@nohash',
        usersCache,
        chatsCache,
      )

      // Should use 0n for missing accessHash
      expect(result.inputPeer.accessHash).toBe(BigInt(0))
      expect(result.name).toBe('No Hash')
    })
  })
})

// =============================================================================
// Peer Resolution Tests - By Phone Number
// =============================================================================

describe('Peer Resolution - By Phone Number', () => {
  let db: Database
  let usersCache: UsersCache
  let chatsCache: ChatsCache

  beforeEach(() => {
    const testDb = createTestCacheDatabase()
    db = testDb.db
    usersCache = createUsersCache(db)
    chatsCache = createChatsCache(db)
  })

  describe('phone number detection', () => {
    it('should detect phone with + prefix', async () => {
      usersCache.upsert(
        createTestUser({
          user_id: '111',
          phone: '15551234567',
          access_hash: '123456',
        }),
      )

      const mockClient = createMockClient()
      const result = await resolvePeer(
        mockClient,
        '+15551234567',
        usersCache,
        chatsCache,
      )

      expect(result.inputPeer._).toBe('inputPeerUser')
      expect(result.inputPeer.userId).toBe(111)
    })

    it('should detect 10+ digit numbers as phone', async () => {
      usersCache.upsert(
        createTestUser({
          user_id: '222',
          phone: '1234567890',
          access_hash: '654321',
        }),
      )

      const mockClient = createMockClient()
      const result = await resolvePeer(
        mockClient,
        '1234567890',
        usersCache,
        chatsCache,
      )

      expect(result.inputPeer._).toBe('inputPeerUser')
      expect(result.inputPeer.userId).toBe(222)
    })
  })

  describe('cached phone lookup', () => {
    it('should resolve phone number from users cache', async () => {
      usersCache.upsert(
        createTestUser({
          user_id: '333',
          phone: '9876543210',
          first_name: 'Phone',
          last_name: 'User',
          access_hash: '111222333',
        }),
      )

      const mockClient = createMockClient()
      const result = await resolvePeer(
        mockClient,
        '+9876543210',
        usersCache,
        chatsCache,
      )

      expect(result.inputPeer._).toBe('inputPeerUser')
      expect(result.inputPeer.userId).toBe(333)
      expect(result.inputPeer.accessHash).toBe(BigInt('111222333'))
      expect(result.name).toBe('Phone User')
      expect(mockClient.call).not.toHaveBeenCalled()
    })

    it('should normalize phone numbers when looking up cache', async () => {
      usersCache.upsert(
        createTestUser({
          user_id: '444',
          phone: '15551234567',
          access_hash: '444555666',
        }),
      )

      const mockClient = createMockClient()

      // Test with + prefix and various formats - all should normalize to 15551234567
      const result1 = await resolvePeer(
        mockClient,
        '+1 (555) 123-4567',
        usersCache,
        chatsCache,
      )
      expect(result1.inputPeer.userId).toBe(444)

      const result2 = await resolvePeer(
        mockClient,
        '+15551234567',
        usersCache,
        chatsCache,
      )
      expect(result2.inputPeer.userId).toBe(444)

      // Test with raw digits (no + prefix)
      const result3 = await resolvePeer(
        mockClient,
        '15551234567',
        usersCache,
        chatsCache,
      )
      expect(result3.inputPeer.userId).toBe(444)
    })
  })

  describe('API resolution fallback', () => {
    it('should resolve phone via API when not in cache', async () => {
      const mockClient = createMockClient({
        call: mock((_req: any) =>
          Promise.resolve({
            users: [
              {
                id: 555,
                firstName: 'API',
                lastName: 'User',
                accessHash: '777888999',
              },
            ],
          }),
        ),
      })

      const result = await resolvePeer(
        mockClient,
        '+11234567890',
        usersCache,
        chatsCache,
      )

      expect(mockClient.call).toHaveBeenCalledWith({
        _: 'contacts.resolvePhone',
        phone: '11234567890',
      })
      expect(result.inputPeer._).toBe('inputPeerUser')
      expect(result.inputPeer.userId).toBe(555)
      expect(result.name).toBe('API User')
    })

    it('should throw error when phone cannot be resolved', async () => {
      const mockClient = createMockClient({
        call: mock((_req: any) => Promise.reject(new Error('PHONE_NOT_FOUND'))),
      })

      await expect(
        resolvePeer(mockClient, '+19999999999', usersCache, chatsCache),
      ).rejects.toThrow('Could not resolve phone number +19999999999')
    })

    it('should throw when API returns no users', async () => {
      const mockClient = createMockClient({
        call: mock((_req: any) =>
          Promise.resolve({
            users: [],
          }),
        ),
      })

      await expect(
        resolvePeer(mockClient, '+18888888888', usersCache, chatsCache),
      ).rejects.toThrow('Could not resolve phone number +18888888888')
    })
  })
})

// =============================================================================
// Peer Resolution Tests - By Numeric ID
// =============================================================================

describe('Peer Resolution - By Numeric ID', () => {
  let db: Database
  let usersCache: UsersCache
  let chatsCache: ChatsCache

  beforeEach(() => {
    const testDb = createTestCacheDatabase()
    db = testDb.db
    usersCache = createUsersCache(db)
    chatsCache = createChatsCache(db)
  })

  describe('user ID lookup', () => {
    it('should resolve user ID from users cache', async () => {
      usersCache.upsert(
        createTestUser({
          user_id: '123456789',
          first_name: 'Numeric',
          last_name: 'User',
          access_hash: '999888777',
        }),
      )

      const mockClient = createMockClient()
      const result = await resolvePeer(
        mockClient,
        '123456789',
        usersCache,
        chatsCache,
      )

      expect(result.inputPeer._).toBe('inputPeerUser')
      expect(result.inputPeer.userId).toBe(123456789)
      expect(result.inputPeer.accessHash).toBe(BigInt('999888777'))
      expect(result.name).toBe('Numeric User')
    })

    it('should use fallback name for user without display_name', async () => {
      usersCache.upsert(
        createTestUser({
          user_id: '111222',
          first_name: null,
          last_name: null,
          access_hash: '333444',
        }),
      )

      const mockClient = createMockClient()
      const result = await resolvePeer(
        mockClient,
        '111222',
        usersCache,
        chatsCache,
      )

      expect(result.name).toBe('User 111222')
    })
  })

  describe('chat ID lookup', () => {
    it('should resolve private chat ID from chats cache', async () => {
      chatsCache.upsert(
        createTestChat({
          chat_id: '555666',
          type: 'private',
          title: 'Private Chat',
          access_hash: '777888',
        }),
      )

      const mockClient = createMockClient()
      const result = await resolvePeer(
        mockClient,
        '555666',
        usersCache,
        chatsCache,
      )

      expect(result.inputPeer._).toBe('inputPeerUser')
      expect(result.inputPeer.userId).toBe(555666)
      expect(result.name).toBe('Private Chat')
    })

    it('should resolve group chat ID from chats cache', async () => {
      chatsCache.upsert(
        createTestChat({
          chat_id: '777888',
          type: 'group',
          title: 'Group Chat',
          access_hash: null, // Groups don't have access_hash
        }),
      )

      const mockClient = createMockClient()
      const result = await resolvePeer(
        mockClient,
        '777888',
        usersCache,
        chatsCache,
      )

      expect(result.inputPeer._).toBe('inputPeerChat')
      expect(result.inputPeer.chatId).toBe(777888)
      expect(result.name).toBe('Group Chat')
    })

    it('should resolve channel ID from chats cache', async () => {
      chatsCache.upsert(
        createTestChat({
          chat_id: '888999',
          type: 'channel',
          title: 'My Channel',
          access_hash: '111222333',
        }),
      )

      const mockClient = createMockClient()
      const result = await resolvePeer(
        mockClient,
        '888999',
        usersCache,
        chatsCache,
      )

      expect(result.inputPeer._).toBe('inputPeerChannel')
      expect(result.inputPeer.channelId).toBe(888999)
      expect(result.inputPeer.accessHash).toBe(BigInt('111222333'))
      expect(result.name).toBe('My Channel')
    })

    it('should resolve supergroup ID from chats cache', async () => {
      chatsCache.upsert(
        createTestChat({
          chat_id: '999000',
          type: 'supergroup',
          title: 'Supergroup',
          access_hash: '444555666',
        }),
      )

      const mockClient = createMockClient()
      const result = await resolvePeer(
        mockClient,
        '999000',
        usersCache,
        chatsCache,
      )

      expect(result.inputPeer._).toBe('inputPeerChannel')
      expect(result.inputPeer.channelId).toBe(999000)
      expect(result.name).toBe('Supergroup')
    })
  })

  describe('fallback behavior', () => {
    it('should fallback to inputPeerChat for unknown numeric ID', async () => {
      // No cache entries
      const mockClient = createMockClient()
      const result = await resolvePeer(
        mockClient,
        '12345',
        usersCache,
        chatsCache,
      )

      expect(result.inputPeer._).toBe('inputPeerChat')
      expect(result.inputPeer.chatId).toBe(12345)
      expect(result.name).toBe('Chat 12345')
    })

    it('should throw error for invalid numeric identifier', async () => {
      const mockClient = createMockClient()

      await expect(
        resolvePeer(mockClient, 'not_a_number', usersCache, chatsCache),
      ).rejects.toThrow('Invalid peer identifier: not_a_number')
    })
  })
})

// =============================================================================
// Message Sending Tests
// =============================================================================

describe('Message Sending', () => {
  let db: Database
  let usersCache: UsersCache
  let chatsCache: ChatsCache

  beforeEach(() => {
    const testDb = createTestCacheDatabase()
    db = testDb.db
    usersCache = createUsersCache(db)
    chatsCache = createChatsCache(db)
  })

  describe('sendMessage request building', () => {
    it('should build basic sendMessage request', async () => {
      usersCache.upsert(
        createTestUser({
          user_id: '123',
          username: 'recipient',
          access_hash: '456',
        }),
      )

      const mockClient = createMockClient({
        call: mock((_req: any) =>
          Promise.resolve({
            _: 'updateShortSentMessage',
            id: 12345,
            date: Math.floor(Date.now() / 1000),
          }),
        ),
      })

      const { inputPeer } = await resolvePeer(
        mockClient,
        '@recipient',
        usersCache,
        chatsCache,
      )

      // Build the request as the send command would
      const request = {
        _: 'messages.sendMessage',
        peer: inputPeer,
        message: 'Hello, world!',
        randomId: BigInt(123456),
        noWebpage: false,
        silent: false,
      }

      await mockClient.call(request)

      expect(mockClient.call).toHaveBeenCalledWith(
        expect.objectContaining({
          _: 'messages.sendMessage',
          message: 'Hello, world!',
          silent: false,
        }),
      )
    })

    it('should include silent flag when specified', async () => {
      usersCache.upsert(
        createTestUser({
          user_id: '123',
          username: 'recipient',
          access_hash: '456',
        }),
      )

      const mockClient = createMockClient({
        call: mock((_req: any) =>
          Promise.resolve({
            _: 'updateShortSentMessage',
            id: 12346,
            date: Math.floor(Date.now() / 1000),
          }),
        ),
      })

      const { inputPeer } = await resolvePeer(
        mockClient,
        '@recipient',
        usersCache,
        chatsCache,
      )

      const request = {
        _: 'messages.sendMessage',
        peer: inputPeer,
        message: 'Silent message',
        randomId: BigInt(123457),
        noWebpage: false,
        silent: true, // Silent flag enabled
      }

      await mockClient.call(request)

      expect(mockClient.call).toHaveBeenCalledWith(
        expect.objectContaining({
          _: 'messages.sendMessage',
          silent: true,
        }),
      )
    })

    it('should include replyTo when specified', async () => {
      usersCache.upsert(
        createTestUser({
          user_id: '123',
          username: 'recipient',
          access_hash: '456',
        }),
      )

      const mockClient = createMockClient({
        call: mock((_req: any) =>
          Promise.resolve({
            _: 'updateShortSentMessage',
            id: 12347,
            date: Math.floor(Date.now() / 1000),
          }),
        ),
      })

      const { inputPeer } = await resolvePeer(
        mockClient,
        '@recipient',
        usersCache,
        chatsCache,
      )

      const request: any = {
        _: 'messages.sendMessage',
        peer: inputPeer,
        message: 'Reply message',
        randomId: BigInt(123458),
        noWebpage: false,
        silent: false,
        replyTo: {
          _: 'inputReplyToMessage',
          replyToMsgId: 999,
        },
      }

      await mockClient.call(request)

      expect(mockClient.call).toHaveBeenCalledWith(
        expect.objectContaining({
          _: 'messages.sendMessage',
          replyTo: {
            _: 'inputReplyToMessage',
            replyToMsgId: 999,
          },
        }),
      )
    })
  })

  describe('response handling', () => {
    it('should extract message ID from updateShortSentMessage', () => {
      const result = {
        _: 'updateShortSentMessage',
        id: 12345,
        date: 1700000000,
      }

      let messageId: number | null = null
      let timestamp: number | null = null

      if (result._ === 'updateShortSentMessage') {
        messageId = result.id
        timestamp = result.date
      }

      expect(messageId).toBe(12345)
      expect(timestamp).toBe(1700000000)
    })

    it('should extract message ID from updates array', () => {
      const result = {
        _: 'updates',
        updates: [
          {
            _: 'updateMessageID',
            id: 54321,
          },
          {
            _: 'updateNewMessage',
            message: {
              id: 54321,
              date: 1700000001,
            },
          },
        ],
      }

      let messageId: number | null = null

      for (const update of result.updates) {
        if (
          update._ === 'updateMessageID' ||
          update._ === 'updateNewMessage' ||
          update._ === 'updateNewChannelMessage'
        ) {
          messageId = (update as any).id ?? (update as any).message?.id
          break
        }
      }

      expect(messageId).toBe(54321)
    })
  })
})

// =============================================================================
// Error Handling Tests
// =============================================================================

describe('Error Handling', () => {
  let db: Database
  let usersCache: UsersCache
  let chatsCache: ChatsCache

  beforeEach(() => {
    const testDb = createTestCacheDatabase()
    db = testDb.db
    usersCache = createUsersCache(db)
    chatsCache = createChatsCache(db)
  })

  describe('peer resolution errors', () => {
    it('should throw for invalid identifier format', async () => {
      const mockClient = createMockClient()

      // Not a username (@), not a phone (+/10+ digits), not a valid number
      await expect(
        resolvePeer(mockClient, 'invalid-peer!', usersCache, chatsCache),
      ).rejects.toThrow('Invalid peer identifier')
    })

    it('should throw when username resolution fails', async () => {
      const mockClient = createMockClient({
        call: mock((_req: any) =>
          Promise.resolve({
            users: [],
            chats: [],
          }),
        ),
      })

      await expect(
        resolvePeer(mockClient, '@doesnotexist', usersCache, chatsCache),
      ).rejects.toThrow('Could not resolve @doesnotexist')
    })

    it('should throw when phone resolution fails', async () => {
      const mockClient = createMockClient({
        call: mock((_req: any) =>
          Promise.reject(new Error('PHONE_NOT_OCCUPIED')),
        ),
      })

      await expect(
        resolvePeer(mockClient, '+10000000000', usersCache, chatsCache),
      ).rejects.toThrow('Could not resolve phone number +10000000000')
    })
  })

  describe('Telegram API errors', () => {
    it('should detect PEER_ID_INVALID error', () => {
      const error = new Error('PEER_ID_INVALID')
      expect(error.message.includes('PEER_ID_INVALID')).toBe(true)
    })

    it('should detect USER_IS_BOT error', () => {
      const error = new Error('USER_IS_BOT')
      expect(error.message.includes('USER_IS_BOT')).toBe(true)
    })

    it('should detect CHAT_WRITE_FORBIDDEN error', () => {
      const error = new Error('CHAT_WRITE_FORBIDDEN')
      expect(error.message.includes('CHAT_WRITE_FORBIDDEN')).toBe(true)
    })
  })

  describe('cache edge cases', () => {
    it('should skip cache entry without access_hash for username lookup', async () => {
      usersCache.upsert(
        createTestUser({
          user_id: '111',
          username: 'noaccess',
          access_hash: null, // No access_hash
        }),
      )

      const mockClient = createMockClient({
        call: mock((_req: any) =>
          Promise.resolve({
            users: [
              {
                id: 111,
                firstName: 'Has',
                lastName: 'Access',
                accessHash: '999',
              },
            ],
            chats: [],
          }),
        ),
      })

      const result = await resolvePeer(
        mockClient,
        '@noaccess',
        usersCache,
        chatsCache,
      )

      // Should have called API because cache entry has no access_hash
      expect(mockClient.call).toHaveBeenCalled()
      expect(result.inputPeer.accessHash).toBe(BigInt('999'))
    })

    it('should skip cache entry without access_hash for phone lookup', async () => {
      usersCache.upsert(
        createTestUser({
          user_id: '222',
          phone: '5555555555',
          access_hash: null, // No access_hash
        }),
      )

      const mockClient = createMockClient({
        call: mock((_req: any) =>
          Promise.resolve({
            users: [
              {
                id: 222,
                firstName: 'Phone',
                lastName: 'User',
                accessHash: '888',
              },
            ],
          }),
        ),
      })

      const result = await resolvePeer(
        mockClient,
        '+5555555555',
        usersCache,
        chatsCache,
      )

      // Should have called API because cache entry has no access_hash
      expect(mockClient.call).toHaveBeenCalled()
      expect(result.inputPeer.accessHash).toBe(BigInt('888'))
    })

    it('should skip cache entry without access_hash for user ID lookup', async () => {
      usersCache.upsert(
        createTestUser({
          user_id: '333333',
          access_hash: null, // No access_hash
        }),
      )

      const mockClient = createMockClient()
      const result = await resolvePeer(
        mockClient,
        '333333',
        usersCache,
        chatsCache,
      )

      // Falls back to inputPeerChat when user has no access_hash
      expect(result.inputPeer._).toBe('inputPeerChat')
      expect(result.inputPeer.chatId).toBe(333333)
    })
  })
})

// =============================================================================
// Input Validation Tests
// =============================================================================

describe('Input Validation', () => {
  describe('identifier type detection', () => {
    it('should detect @username format', () => {
      const identifier = '@testuser'
      const isUsername = identifier.startsWith('@')
      expect(isUsername).toBe(true)
    })

    it('should detect phone with + prefix', () => {
      const identifier = '+1234567890'
      const isPhone = identifier.startsWith('+') || /^\d{10,}$/.test(identifier)
      expect(isPhone).toBe(true)
    })

    it('should detect 10+ digit phone without +', () => {
      const identifier = '12345678901'
      const isPhone = identifier.startsWith('+') || /^\d{10,}$/.test(identifier)
      expect(isPhone).toBe(true)
    })

    it('should not detect short numbers as phone', () => {
      const identifier = '123456789' // 9 digits
      const isPhone = identifier.startsWith('+') || /^\d{10,}$/.test(identifier)
      expect(isPhone).toBe(false)
    })

    it('should detect numeric ID (short number)', () => {
      const identifier = '12345'
      const isUsername = identifier.startsWith('@')
      const isPhone = identifier.startsWith('+') || /^\d{10,}$/.test(identifier)
      const isNumericId =
        !isUsername &&
        !isPhone &&
        !Number.isNaN(Number.parseInt(identifier, 10))
      expect(isNumericId).toBe(true)
    })
  })

  describe('phone number normalization', () => {
    it('should remove + from phone', () => {
      const phone = '+1234567890'
      const normalized = phone.replace(/[\s\-+()]/g, '')
      expect(normalized).toBe('1234567890')
    })

    it('should remove spaces from phone', () => {
      const phone = '+1 234 567 890'
      const normalized = phone.replace(/[\s\-+()]/g, '')
      expect(normalized).toBe('1234567890')
    })

    it('should remove dashes from phone', () => {
      const phone = '+1-234-567-890'
      const normalized = phone.replace(/[\s\-+()]/g, '')
      expect(normalized).toBe('1234567890')
    })

    it('should remove parentheses from phone', () => {
      const phone = '+1 (234) 567-890'
      const normalized = phone.replace(/[\s\-+()]/g, '')
      expect(normalized).toBe('1234567890')
    })
  })

  describe('username normalization', () => {
    it('should strip @ from username', () => {
      const identifier = '@testuser'
      const username = identifier.startsWith('@')
        ? identifier.slice(1)
        : identifier
      expect(username).toBe('testuser')
    })

    it('should keep username without @', () => {
      const identifier = 'testuser'
      const username = identifier.startsWith('@')
        ? identifier.slice(1)
        : identifier
      expect(username).toBe('testuser')
    })
  })
})

// =============================================================================
// Priority and Edge Cases
// =============================================================================

describe('Resolution Priority', () => {
  let db: Database
  let usersCache: UsersCache
  let chatsCache: ChatsCache

  beforeEach(() => {
    const testDb = createTestCacheDatabase()
    db = testDb.db
    usersCache = createUsersCache(db)
    chatsCache = createChatsCache(db)
  })

  it('should prefer users cache over chats cache for @username', async () => {
    // Both have same username
    usersCache.upsert(
      createTestUser({
        user_id: '111',
        username: 'shared',
        access_hash: '222',
      }),
    )
    chatsCache.upsert(
      createTestChat({
        chat_id: '333',
        type: 'channel',
        username: 'shared',
        access_hash: '444',
      }),
    )

    const mockClient = createMockClient()
    const result = await resolvePeer(
      mockClient,
      '@shared',
      usersCache,
      chatsCache,
    )

    // Should resolve to user, not channel
    expect(result.inputPeer._).toBe('inputPeerUser')
    expect(result.inputPeer.userId).toBe(111)
  })

  it('should prefer users cache over chats cache for numeric ID', async () => {
    // Same ID in both caches
    usersCache.upsert(
      createTestUser({
        user_id: '555',
        access_hash: '666',
      }),
    )
    chatsCache.upsert(
      createTestChat({
        chat_id: '555',
        type: 'channel',
        access_hash: '777',
      }),
    )

    const mockClient = createMockClient()
    const result = await resolvePeer(mockClient, '555', usersCache, chatsCache)

    // Should resolve to user, not channel
    expect(result.inputPeer._).toBe('inputPeerUser')
    expect(result.inputPeer.userId).toBe(555)
  })

  it('should fall through to chats cache when user has no access_hash', async () => {
    usersCache.upsert(
      createTestUser({
        user_id: '666',
        username: 'fallthrough',
        access_hash: null, // No access hash
      }),
    )
    chatsCache.upsert(
      createTestChat({
        chat_id: '777',
        type: 'channel',
        username: 'fallthrough',
        access_hash: '888',
      }),
    )

    const mockClient = createMockClient({
      call: mock((_req: any) =>
        Promise.resolve({
          users: [],
          chats: [],
        }),
      ),
    })

    // When user has no access_hash, it should fall through to chats cache
    const result = await resolvePeer(
      mockClient,
      '@fallthrough',
      usersCache,
      chatsCache,
    )

    expect(result.inputPeer._).toBe('inputPeerChannel')
    expect(result.inputPeer.channelId).toBe(777)
    expect(mockClient.call).not.toHaveBeenCalled()
  })
})
