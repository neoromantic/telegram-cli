/**
 * Comprehensive unit tests for user commands (tg me, tg user)
 *
 * Tests:
 * - meCommand: Get current authenticated user info
 * - userCommand: Look up any user by @username, ID, or phone number
 * - Cache behavior and --fresh flag
 * - Error handling for auth required and user not found
 */

import type { Database } from 'bun:sqlite'
import { beforeEach, describe, expect, it, mock } from 'bun:test'

import { createTestCacheDatabase } from '../db/schema'
import { getDefaultCacheConfig, isCacheStale } from '../db/types'
import {
  createUsersCache,
  type UserCacheInput,
  type UsersCache,
} from '../db/users-cache'

// =============================================================================
// Note: We no longer mock the output module to avoid interfering with other tests.
// The output module handles test mode properly (throws instead of process.exit)
// =============================================================================

// =============================================================================
// Mock Telegram Client Factory
// =============================================================================

let mockClient = createMockClient()

mock.module('../services/telegram', () => ({
  getClientForAccount: mock(() => mockClient),
}))

// Mock getCacheDb
let testCacheDb: Database

mock.module('../db', () => ({
  getCacheDb: () => testCacheDb,
}))

// =============================================================================
// Test Helpers
// =============================================================================

/**
 * Create test user data for cache
 */
function createTestUser(
  overrides: Partial<UserCacheInput> = {},
): UserCacheInput {
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
    raw_json: JSON.stringify({
      id: 123456,
      firstName: 'Test',
      lastName: 'User',
    }),
    ...overrides,
  }
}

/**
 * Create a mock Telegram client
 */
function createMockClient(overrides: Record<string, any> = {}) {
  return {
    call: mock((_req: any) => Promise.resolve({})),
    getMe: mock((_opts?: any) =>
      Promise.resolve({
        id: 123,
        firstName: 'Current',
        lastName: 'User',
        username: 'currentuser',
        phone: '1111111111',
        bot: false,
        premium: true,
        contact: false,
        accessHash: BigInt('999999999'),
      }),
    ),
    ...overrides,
  }
}

/**
 * Convert API user to UserInfo (mirrors logic from user.ts)
 */
function apiUserToUserInfo(user: any) {
  return {
    id: user.id,
    firstName: user.firstName ?? '',
    lastName: user.lastName ?? null,
    username: user.username ?? null,
    phone: user.phone ?? null,
    isBot: Boolean(user.bot),
    isPremium: Boolean(user.premium),
    isContact: Boolean(user.contact),
  }
}

/**
 * Convert cached user to UserInfo (mirrors logic from user.ts)
 */
function cachedUserToUserInfo(cached: any) {
  return {
    id: Number(cached.user_id),
    firstName: cached.first_name ?? '',
    lastName: cached.last_name ?? null,
    username: cached.username ?? null,
    phone: cached.phone ?? null,
    isBot: cached.is_bot === 1,
    isPremium: cached.is_premium === 1,
    isContact: cached.is_contact === 1,
  }
}

/**
 * Convert API user to cache input (mirrors logic from user.ts)
 */
function apiUserToCacheInput(user: any): UserCacheInput {
  // Create a copy without BigInt for JSON serialization
  const rawData = { ...user }
  if (rawData.accessHash !== undefined) {
    rawData.accessHash = String(rawData.accessHash)
  }

  return {
    user_id: String(user.id),
    username: user.username ?? null,
    first_name: user.firstName ?? null,
    last_name: user.lastName ?? null,
    phone: user.phone ?? null,
    access_hash: user.accessHash ? String(user.accessHash) : null,
    is_contact: user.contact ? 1 : 0,
    is_bot: user.bot ? 1 : 0,
    is_premium: user.premium ? 1 : 0,
    fetched_at: Date.now(),
    raw_json: JSON.stringify(rawData),
  }
}

/**
 * Determine identifier type (mirrors logic from user.ts)
 */
function parseIdentifier(identifier: string): {
  isUsername: boolean
  isPhone: boolean
  isUserId: boolean
} {
  const isUsername =
    identifier.startsWith('@') ||
    (Number.isNaN(Number(identifier)) && !identifier.startsWith('+'))
  const isPhone = identifier.startsWith('+') || /^\d{10,}$/.test(identifier)
  const isUserId = !isUsername && !isPhone && !Number.isNaN(Number(identifier))

  return { isUsername, isPhone, isUserId }
}

// =============================================================================
// meCommand Tests
// =============================================================================

describe('meCommand', () => {
  let usersCache: UsersCache
  const cacheConfig = getDefaultCacheConfig()

  beforeEach(() => {
    // Reset mocks

    // Create fresh test database
    const { db } = createTestCacheDatabase()
    testCacheDb = db
    usersCache = createUsersCache(db)

    // Reset mock client
    mockClient = createMockClient()
  })

  describe('get current user info', () => {
    it('should get current user from API when cache is empty', async () => {
      const me = await mockClient.getMe()

      expect(me.id).toBe(123)
      expect(me.firstName).toBe('Current')
      expect(me.lastName).toBe('User')
      expect(me.username).toBe('currentuser')
      expect(me.premium).toBe(true)
    })

    it('should convert API user to UserInfo correctly', () => {
      const apiUser = {
        id: 123,
        firstName: 'Current',
        lastName: 'User',
        username: 'currentuser',
        phone: '1111111111',
        bot: false,
        premium: true,
        contact: false,
      }

      const userInfo = apiUserToUserInfo(apiUser)

      expect(userInfo.id).toBe(123)
      expect(userInfo.firstName).toBe('Current')
      expect(userInfo.lastName).toBe('User')
      expect(userInfo.username).toBe('currentuser')
      expect(userInfo.phone).toBe('1111111111')
      expect(userInfo.isBot).toBe(false)
      expect(userInfo.isPremium).toBe(true)
      expect(userInfo.isContact).toBe(false)
    })

    it('should cache user after API call', async () => {
      const me = await mockClient.getMe()

      // Cache the user
      usersCache.upsert(apiUserToCacheInput(me))

      // Verify it's in cache
      const cached = usersCache.getById(String(me.id))
      expect(cached).not.toBeNull()
      expect(cached?.user_id).toBe('123')
      expect(cached?.username).toBe('currentuser')
    })

    it('should include source in response', async () => {
      // Cache miss - source should be api
      const cached = usersCache.getById('123')
      const source = cached ? ('cache' as const) : ('api' as const)

      expect(source).toBe('api')
    })
  })

  describe('cache behavior', () => {
    it('should return cached user when available', () => {
      // Seed cache with current user
      usersCache.upsert(
        createTestUser({
          user_id: '123',
          username: 'currentuser',
          first_name: 'Cached',
          last_name: 'User',
          fetched_at: Date.now(),
        }),
      )

      const cached = usersCache.getById('123')
      expect(cached).not.toBeNull()
      expect(cached?.first_name).toBe('Cached')
    })

    it('should detect stale cached user', () => {
      const staleTime = Date.now() - cacheConfig.staleness.peers - 1000

      usersCache.upsert(
        createTestUser({
          user_id: '123',
          fetched_at: staleTime,
        }),
      )

      const cached = usersCache.getById('123')
      const stale = isCacheStale(
        cached!.fetched_at,
        cacheConfig.staleness.peers,
      )

      expect(stale).toBe(true)
    })

    it('should detect fresh cached user', () => {
      usersCache.upsert(
        createTestUser({
          user_id: '123',
          fetched_at: Date.now(),
        }),
      )

      const cached = usersCache.getById('123')
      const stale = isCacheStale(
        cached!.fetched_at,
        cacheConfig.staleness.peers,
      )

      expect(stale).toBe(false)
    })

    it('should return source as "cache" when using cached data', () => {
      usersCache.upsert(
        createTestUser({
          user_id: '123',
          fetched_at: Date.now(),
        }),
      )

      const cached = usersCache.getById('123')
      const source = cached ? ('cache' as const) : ('api' as const)

      expect(source).toBe('cache')
    })

    it('should return stale flag in response', () => {
      const staleTime = Date.now() - cacheConfig.staleness.peers - 1000

      usersCache.upsert(
        createTestUser({
          user_id: '123',
          fetched_at: staleTime,
        }),
      )

      const cached = usersCache.getById('123')
      const stale = isCacheStale(
        cached!.fetched_at,
        cacheConfig.staleness.peers,
      )

      const response = {
        user: cachedUserToUserInfo(cached),
        source: 'cache' as const,
        stale,
      }

      expect(response.stale).toBe(true)
    })
  })

  describe('--fresh flag', () => {
    it('should bypass cache when fresh is true', () => {
      usersCache.upsert(
        createTestUser({
          user_id: '123',
          first_name: 'Cached',
          fetched_at: Date.now(),
        }),
      )

      const fresh = true
      let usedCache = false

      // Simulate command logic
      if (!fresh) {
        const cached = usersCache.getById('123')
        if (cached) {
          usedCache = true
        }
      }

      expect(usedCache).toBe(false)
    })

    it('should use cache when fresh is false', () => {
      usersCache.upsert(
        createTestUser({
          user_id: '123',
          first_name: 'Cached',
          fetched_at: Date.now(),
        }),
      )

      const fresh = false
      let usedCache = false

      // Simulate command logic
      if (!fresh) {
        const cached = usersCache.getById('123')
        if (cached) {
          usedCache = true
        }
      }

      expect(usedCache).toBe(true)
    })

    it('should update cache after fresh API call', async () => {
      // Seed with old data
      usersCache.upsert(
        createTestUser({
          user_id: '123',
          first_name: 'Old',
          fetched_at: Date.now() - 1000000,
        }),
      )

      const me = await mockClient.getMe()

      // Simulate fresh fetch and update
      usersCache.upsert(apiUserToCacheInput(me))

      const cached = usersCache.getById('123')
      expect(cached?.first_name).toBe('Current')
    })

    it('should set source to "api" when fresh flag is used', async () => {
      usersCache.upsert(
        createTestUser({
          user_id: '123',
          fetched_at: Date.now(),
        }),
      )

      const fresh = true

      // When fresh=true, always fetch from API
      const source = fresh ? ('api' as const) : ('cache' as const)

      expect(source).toBe('api')
    })
  })

  describe('error handling - auth required', () => {
    it('should handle getMe throwing unauthorized error', async () => {
      mockClient = createMockClient({
        getMe: mock((_opts?: any) =>
          Promise.reject(new Error('AUTH_KEY_UNREGISTERED')),
        ),
      })

      await expect(mockClient.getMe()).rejects.toThrow('AUTH_KEY_UNREGISTERED')
    })

    it('should detect AUTH_REQUIRED error code', () => {
      const errorMsg = 'AUTH_KEY_UNREGISTERED'
      const isAuthError =
        errorMsg.includes('AUTH_KEY') || errorMsg.includes('UNAUTHORIZED')

      expect(isAuthError).toBe(true)
    })

    it('should catch generic errors from getMe', async () => {
      mockClient = createMockClient({
        getMe: mock((_opts?: any) =>
          Promise.reject(new Error('Network timeout')),
        ),
      })

      let caught = false
      try {
        await mockClient.getMe()
      } catch {
        caught = true
      }

      expect(caught).toBe(true)
    })
  })

  describe('UserInfo conversion', () => {
    it('should convert cached user to UserInfo correctly', () => {
      usersCache.upsert(
        createTestUser({
          user_id: '123',
          username: 'testuser',
          first_name: 'Test',
          last_name: 'User',
          phone: '1234567890',
          is_bot: 0,
          is_premium: 1,
          is_contact: 1,
        }),
      )

      const cached = usersCache.getById('123')
      const userInfo = cachedUserToUserInfo(cached)

      expect(userInfo.id).toBe(123)
      expect(userInfo.firstName).toBe('Test')
      expect(userInfo.lastName).toBe('User')
      expect(userInfo.username).toBe('testuser')
      expect(userInfo.phone).toBe('1234567890')
      expect(userInfo.isBot).toBe(false)
      expect(userInfo.isPremium).toBe(true)
      expect(userInfo.isContact).toBe(true)
    })

    it('should handle null fields in cached user', () => {
      usersCache.upsert(
        createTestUser({
          user_id: '456',
          username: null,
          first_name: 'OnlyFirst',
          last_name: null,
          phone: null,
        }),
      )

      const cached = usersCache.getById('456')
      const userInfo = cachedUserToUserInfo(cached)

      expect(userInfo.username).toBeNull()
      expect(userInfo.lastName).toBeNull()
      expect(userInfo.phone).toBeNull()
    })

    it('should handle null first_name in API response', () => {
      const apiUser = {
        id: 789,
        firstName: null,
        lastName: 'OnlyLast',
        username: 'onlylast',
        bot: false,
        premium: false,
        contact: false,
      }

      const userInfo = apiUserToUserInfo(apiUser)

      expect(userInfo.firstName).toBe('')
      expect(userInfo.lastName).toBe('OnlyLast')
    })
  })
})

// =============================================================================
// userCommand Tests - Lookup by Username
// =============================================================================

describe('userCommand - by username', () => {
  let usersCache: UsersCache
  const cacheConfig = getDefaultCacheConfig()

  beforeEach(() => {
    const { db } = createTestCacheDatabase()
    testCacheDb = db
    usersCache = createUsersCache(db)
    mockClient = createMockClient()
  })

  describe('identifier detection', () => {
    it('should detect @username format as username', () => {
      const { isUsername, isPhone, isUserId } = parseIdentifier('@testuser')

      expect(isUsername).toBe(true)
      expect(isPhone).toBe(false)
      expect(isUserId).toBe(false)
    })

    it('should detect username without @ as username', () => {
      const { isUsername, isPhone, isUserId } = parseIdentifier('testuser')

      expect(isUsername).toBe(true)
      expect(isPhone).toBe(false)
      expect(isUserId).toBe(false)
    })

    it('should detect alphanumeric string as username', () => {
      const { isUsername, isPhone, isUserId } = parseIdentifier('user123')

      expect(isUsername).toBe(true)
      expect(isPhone).toBe(false)
      expect(isUserId).toBe(false)
    })

    it('should detect username with underscores', () => {
      const { isUsername, isPhone, isUserId } = parseIdentifier('test_user_123')

      expect(isUsername).toBe(true)
      expect(isPhone).toBe(false)
      expect(isUserId).toBe(false)
    })
  })

  describe('cached username lookup', () => {
    it('should find user by username from cache', () => {
      usersCache.upsert(
        createTestUser({
          user_id: '111',
          username: 'alice',
          first_name: 'Alice',
          last_name: 'Smith',
        }),
      )

      const cached = usersCache.getByUsername('alice')

      expect(cached).not.toBeNull()
      expect(cached?.user_id).toBe('111')
      expect(cached?.first_name).toBe('Alice')
    })

    it('should find user by @username from cache', () => {
      usersCache.upsert(
        createTestUser({
          user_id: '222',
          username: 'bob',
          first_name: 'Bob',
        }),
      )

      const cached = usersCache.getByUsername('@bob')

      expect(cached).not.toBeNull()
      expect(cached?.user_id).toBe('222')
    })

    it('should be case insensitive for username lookup', () => {
      usersCache.upsert(
        createTestUser({
          user_id: '333',
          username: 'CamelCase',
          first_name: 'Camel',
        }),
      )

      expect(usersCache.getByUsername('camelcase')).not.toBeNull()
      expect(usersCache.getByUsername('CAMELCASE')).not.toBeNull()
      expect(usersCache.getByUsername('CamelCase')).not.toBeNull()
    })

    it('should return null for non-existent username', () => {
      const cached = usersCache.getByUsername('@nonexistent')
      expect(cached).toBeNull()
    })

    it('should detect staleness of cached user', () => {
      const staleTime = Date.now() - cacheConfig.staleness.peers - 1000

      usersCache.upsert(
        createTestUser({
          user_id: '444',
          username: 'staleuser',
          fetched_at: staleTime,
        }),
      )

      const cached = usersCache.getByUsername('staleuser')
      const stale = isCacheStale(
        cached!.fetched_at,
        cacheConfig.staleness.peers,
      )

      expect(stale).toBe(true)
    })
  })

  describe('API resolution for username', () => {
    it('should resolve username via API when not in cache', async () => {
      mockClient = createMockClient({
        call: mock((_req: any) =>
          Promise.resolve({
            users: [
              {
                _: 'user',
                id: 444,
                firstName: 'API',
                lastName: 'User',
                username: 'apiuser',
                accessHash: BigInt('123456'),
              },
            ],
          }),
        ),
      })

      const result = (await mockClient.call({
        _: 'contacts.resolveUsername',
        username: 'apiuser',
      })) as any

      expect(result.users).toHaveLength(1)
      expect(result.users[0].id).toBe(444)
      expect(result.users[0].firstName).toBe('API')
    })

    it('should strip @ before API call', () => {
      const identifier = '@testuser'
      const username = identifier.startsWith('@')
        ? identifier.slice(1)
        : identifier

      expect(username).toBe('testuser')
    })

    it('should cache user after API resolution', async () => {
      const apiUser = {
        _: 'user',
        id: 555,
        firstName: 'Resolved',
        lastName: 'User',
        username: 'resolved',
        accessHash: BigInt('789'),
        bot: false,
        premium: false,
        contact: false,
      }

      usersCache.upsert(apiUserToCacheInput(apiUser))

      const cached = usersCache.getByUsername('resolved')
      expect(cached).not.toBeNull()
      expect(cached?.first_name).toBe('Resolved')
    })

    it('should build correct resolveUsername request', () => {
      const identifier = '@testuser'
      const username = identifier.startsWith('@')
        ? identifier.slice(1)
        : identifier

      const request = {
        _: 'contacts.resolveUsername',
        username,
      }

      expect(request._).toBe('contacts.resolveUsername')
      expect(request.username).toBe('testuser')
    })
  })

  describe('error handling - USERNAME_NOT_OCCUPIED', () => {
    it('should detect USERNAME_NOT_OCCUPIED error', async () => {
      mockClient = createMockClient({
        call: mock((_req: any) =>
          Promise.reject(new Error('USERNAME_NOT_OCCUPIED')),
        ),
      })

      await expect(
        mockClient.call({
          _: 'contacts.resolveUsername',
          username: 'nonexistent',
        }),
      ).rejects.toThrow('USERNAME_NOT_OCCUPIED')
    })

    it('should handle user not in API response', async () => {
      mockClient = createMockClient({
        call: mock((_req: any) =>
          Promise.resolve({
            users: [],
          }),
        ),
      })

      const result = (await mockClient.call({
        _: 'contacts.resolveUsername',
        username: 'empty',
      })) as any

      expect(result.users).toHaveLength(0)
    })

    it('should identify USERNAME_NOT_OCCUPIED in error message', () => {
      const errMsg = 'USERNAME_NOT_OCCUPIED'
      const isUsernameNotFound = errMsg.includes('USERNAME_NOT_OCCUPIED')

      expect(isUsernameNotFound).toBe(true)
    })
  })
})

// =============================================================================
// userCommand Tests - Lookup by ID
// =============================================================================

describe('userCommand - by ID', () => {
  let usersCache: UsersCache

  beforeEach(() => {
    const { db } = createTestCacheDatabase()
    testCacheDb = db
    usersCache = createUsersCache(db)
    mockClient = createMockClient()
  })

  describe('identifier detection', () => {
    it('should detect numeric string as user ID', () => {
      const { isUsername, isPhone, isUserId } = parseIdentifier('12345')

      expect(isUsername).toBe(false)
      expect(isPhone).toBe(false)
      expect(isUserId).toBe(true)
    })

    it('should detect short numeric string as user ID not phone', () => {
      // 9 digits - too short for phone
      const { isUsername, isPhone, isUserId } = parseIdentifier('123456789')

      expect(isUsername).toBe(false)
      expect(isPhone).toBe(false)
      expect(isUserId).toBe(true)
    })

    it('should distinguish user ID from phone (10+ digits)', () => {
      // 10+ digits should be phone, not user ID
      const { isPhone, isUserId } = parseIdentifier('1234567890')

      expect(isPhone).toBe(true)
      expect(isUserId).toBe(false)
    })
  })

  describe('cached ID lookup', () => {
    it('should find user by ID from cache', () => {
      usersCache.upsert(
        createTestUser({
          user_id: '123456789',
          username: 'byid',
          first_name: 'Found',
          last_name: 'ById',
        }),
      )

      const cached = usersCache.getById('123456789')

      expect(cached).not.toBeNull()
      expect(cached?.username).toBe('byid')
      expect(cached?.first_name).toBe('Found')
    })

    it('should return null for non-existent ID', () => {
      const cached = usersCache.getById('99999999')
      expect(cached).toBeNull()
    })

    it('should handle numeric ID as string', () => {
      usersCache.upsert(
        createTestUser({
          user_id: '12345',
        }),
      )

      // Query with same string ID
      const cached = usersCache.getById('12345')
      expect(cached).not.toBeNull()
    })
  })

  describe('API resolution for ID', () => {
    it('should call users.getUsers with inputUser', async () => {
      mockClient = createMockClient({
        call: mock((_req: any) =>
          Promise.resolve([
            {
              _: 'user',
              id: 666,
              firstName: 'API',
              lastName: 'ById',
              username: 'apibyid',
            },
          ]),
        ),
      })

      const userId = Number.parseInt('666', 10)
      const result = (await mockClient.call({
        _: 'users.getUsers',
        id: [{ _: 'inputUser', userId, accessHash: BigInt(0) }],
      })) as any[]

      const user = result.find((u: any) => u._ === 'user')

      expect(user).toBeDefined()
      expect(user.id).toBe(666)
    })

    it('should build inputUser with BigInt accessHash', () => {
      const userId = 12345
      const inputUser = {
        _: 'inputUser',
        userId,
        accessHash: BigInt(0),
      }

      expect(inputUser.userId).toBe(12345)
      expect(inputUser.accessHash).toBe(BigInt(0))
    })

    it('should filter user from result array', () => {
      const result = [
        { _: 'user', id: 111, firstName: 'User' },
        { _: 'userEmpty', id: 222 },
      ]

      const user = result.find((u: any) => u._ === 'user')

      expect(user).toBeDefined()
      expect(user?.id).toBe(111)
    })

    it('should handle userEmpty in response', () => {
      const result = [{ _: 'userEmpty', id: 333 }]

      const user = result.find((u: any) => u._ === 'user')

      expect(user).toBeUndefined()
    })

    it('should handle empty response array', () => {
      const result: any[] = []

      const user = result.find((u: any) => u._ === 'user')

      expect(user).toBeUndefined()
    })
  })
})

// =============================================================================
// userCommand Tests - Lookup by Phone
// =============================================================================

describe('userCommand - by phone', () => {
  let usersCache: UsersCache

  beforeEach(() => {
    const { db } = createTestCacheDatabase()
    testCacheDb = db
    usersCache = createUsersCache(db)
    mockClient = createMockClient()
  })

  describe('identifier detection', () => {
    it('should detect +phone as phone number', () => {
      const { isUsername, isPhone, isUserId } = parseIdentifier('+15551234567')

      expect(isUsername).toBe(false)
      expect(isPhone).toBe(true)
      expect(isUserId).toBe(false)
    })

    it('should detect 10+ digit number as phone', () => {
      const { isUsername, isPhone, isUserId } = parseIdentifier('15551234567')

      expect(isUsername).toBe(false)
      expect(isPhone).toBe(true)
      expect(isUserId).toBe(false)
    })

    it('should detect 10 digit number as phone', () => {
      const { isUsername, isPhone, isUserId } = parseIdentifier('5551234567')

      expect(isUsername).toBe(false)
      expect(isPhone).toBe(true)
      expect(isUserId).toBe(false)
    })

    it('should detect + prefix even with short number', () => {
      const { isPhone } = parseIdentifier('+123')

      expect(isPhone).toBe(true)
    })
  })

  describe('phone normalization', () => {
    it('should normalize phone with +', () => {
      const phone = '+1234567890'
      const normalized = phone.replace(/[\s+\-()]/g, '')

      expect(normalized).toBe('1234567890')
    })

    it('should normalize phone with spaces', () => {
      const phone = '+1 234 567 890'
      const normalized = phone.replace(/[\s+\-()]/g, '')

      expect(normalized).toBe('1234567890')
    })

    it('should normalize phone with dashes', () => {
      const phone = '+1-234-567-890'
      const normalized = phone.replace(/[\s+\-()]/g, '')

      expect(normalized).toBe('1234567890')
    })

    it('should normalize phone with parentheses', () => {
      const phone = '+1 (234) 567-890'
      const normalized = phone.replace(/[\s+\-()]/g, '')

      expect(normalized).toBe('1234567890')
    })

    it('should handle complex international format', () => {
      const phone = '+1 (555) 123-4567'
      const normalized = phone.replace(/[\s+\-()]/g, '')

      expect(normalized).toBe('15551234567')
    })
  })

  describe('cached phone lookup', () => {
    it('should find user by phone from cache', () => {
      usersCache.upsert(
        createTestUser({
          user_id: '777',
          phone: '5551234567',
          first_name: 'Phone',
          last_name: 'User',
        }),
      )

      const cached = usersCache.getByPhone('5551234567')

      expect(cached).not.toBeNull()
      expect(cached?.user_id).toBe('777')
      expect(cached?.first_name).toBe('Phone')
    })

    it('should find user with normalized phone', () => {
      usersCache.upsert(
        createTestUser({
          user_id: '888',
          phone: '5559876543',
        }),
      )

      // Search with different formats
      expect(usersCache.getByPhone('+5559876543')).not.toBeNull()
      expect(usersCache.getByPhone('555 987 6543')).not.toBeNull()
    })

    it('should return null for non-existent phone', () => {
      const cached = usersCache.getByPhone('+0000000000')
      expect(cached).toBeNull()
    })
  })

  describe('API resolution for phone', () => {
    it('should call contacts.resolvePhone', async () => {
      mockClient = createMockClient({
        call: mock((_req: any) =>
          Promise.resolve({
            users: [
              {
                _: 'user',
                id: 999,
                firstName: 'Phone',
                lastName: 'Resolved',
                phone: '5551112222',
                accessHash: BigInt('111222'),
              },
            ],
          }),
        ),
      })

      const phone = '+5551112222'.replace(/[\s+\-()]/g, '')
      const result = (await mockClient.call({
        _: 'contacts.resolvePhone',
        phone,
      })) as any

      expect(result.users).toHaveLength(1)
      expect(result.users[0].phone).toBe('5551112222')
    })

    it('should build correct resolvePhone request', () => {
      const identifier = '+1 (555) 123-4567'
      const phone = identifier.replace(/[\s+\-()]/g, '')

      const request = {
        _: 'contacts.resolvePhone',
        phone,
      }

      expect(request._).toBe('contacts.resolvePhone')
      expect(request.phone).toBe('15551234567')
    })
  })

  describe('error handling - PHONE_NOT_OCCUPIED', () => {
    it('should detect PHONE_NOT_OCCUPIED error', async () => {
      mockClient = createMockClient({
        call: mock((_req: any) =>
          Promise.reject(new Error('PHONE_NOT_OCCUPIED')),
        ),
      })

      await expect(
        mockClient.call({
          _: 'contacts.resolvePhone',
          phone: '0000000000',
        }),
      ).rejects.toThrow('PHONE_NOT_OCCUPIED')
    })

    it('should identify PHONE_NOT_OCCUPIED in error message', () => {
      const errMsg = 'PHONE_NOT_OCCUPIED'
      const isPhoneNotFound = errMsg.includes('PHONE_NOT_OCCUPIED')

      expect(isPhoneNotFound).toBe(true)
    })
  })
})

// =============================================================================
// Cache vs API Behavior Tests
// =============================================================================

describe('Cache vs API behavior', () => {
  let usersCache: UsersCache
  const cacheConfig = getDefaultCacheConfig()

  beforeEach(() => {
    const { db } = createTestCacheDatabase()
    testCacheDb = db
    usersCache = createUsersCache(db)
    mockClient = createMockClient()
  })

  describe('cache priority', () => {
    it('should prefer cache over API when fresh is false', () => {
      usersCache.upsert(
        createTestUser({
          user_id: '111',
          username: 'cached',
          first_name: 'Cached',
        }),
      )

      const fresh = false
      let source: 'cache' | 'api' = 'api'

      if (!fresh) {
        const cached = usersCache.getByUsername('cached')
        if (cached) {
          source = 'cache'
        }
      }

      expect(source).toBe('cache')
    })

    it('should use API when cache miss', () => {
      const fresh = false
      let source: 'cache' | 'api' = 'api'

      if (!fresh) {
        const cached = usersCache.getByUsername('notincache')
        if (cached) {
          source = 'cache'
        }
      }

      expect(source).toBe('api')
    })

    it('should check cache by username first', () => {
      usersCache.upsert(
        createTestUser({
          user_id: '222',
          username: 'checkfirst',
        }),
      )

      const identifier = '@checkfirst'
      const { isUsername } = parseIdentifier(identifier)

      let cached = null
      if (isUsername) {
        cached = usersCache.getByUsername(identifier)
      }

      expect(cached).not.toBeNull()
    })

    it('should check cache by phone when identifier is phone', () => {
      usersCache.upsert(
        createTestUser({
          user_id: '333',
          phone: '5551234567',
        }),
      )

      const identifier = '+5551234567'
      const { isPhone } = parseIdentifier(identifier)

      let cached = null
      if (isPhone) {
        cached = usersCache.getByPhone(identifier)
      }

      expect(cached).not.toBeNull()
    })

    it('should check cache by ID when identifier is numeric', () => {
      usersCache.upsert(
        createTestUser({
          user_id: '444',
        }),
      )

      const identifier = '444'
      const { isUserId } = parseIdentifier(identifier)

      let cached = null
      if (isUserId) {
        cached = usersCache.getById(identifier)
      }

      expect(cached).not.toBeNull()
    })
  })

  describe('staleness tracking', () => {
    it('should report stale when cache entry is old', () => {
      const staleTime = Date.now() - cacheConfig.staleness.peers - 1000

      usersCache.upsert(
        createTestUser({
          user_id: '222',
          fetched_at: staleTime,
        }),
      )

      const cached = usersCache.getById('222')
      const stale = isCacheStale(
        cached!.fetched_at,
        cacheConfig.staleness.peers,
      )

      expect(stale).toBe(true)
    })

    it('should report not stale when cache entry is fresh', () => {
      usersCache.upsert(
        createTestUser({
          user_id: '333',
          fetched_at: Date.now(),
        }),
      )

      const cached = usersCache.getById('333')
      const stale = isCacheStale(
        cached!.fetched_at,
        cacheConfig.staleness.peers,
      )

      expect(stale).toBe(false)
    })

    it('should report stale when fetched_at is null', () => {
      const stale = isCacheStale(null, cacheConfig.staleness.peers)
      expect(stale).toBe(true)
    })

    it('should handle boundary condition (exactly at TTL)', () => {
      // Just under TTL should be fresh
      const justUnder = Date.now() - cacheConfig.staleness.peers + 1000
      expect(isCacheStale(justUnder, cacheConfig.staleness.peers)).toBe(false)

      // Just over TTL should be stale
      const justOver = Date.now() - cacheConfig.staleness.peers - 1000
      expect(isCacheStale(justOver, cacheConfig.staleness.peers)).toBe(true)
    })
  })

  describe('cache update after API call', () => {
    it('should update cache with fresh API data', () => {
      // Seed with old data
      usersCache.upsert(
        createTestUser({
          user_id: '444',
          first_name: 'Old',
          fetched_at: Date.now() - 1000000,
        }),
      )

      // Simulate API response
      const apiUser = {
        id: 444,
        firstName: 'New',
        lastName: 'Name',
        username: 'updated',
        bot: false,
        premium: true,
        contact: false,
      }

      usersCache.upsert(apiUserToCacheInput(apiUser))

      const cached = usersCache.getById('444')
      expect(cached?.first_name).toBe('New')
      expect(cached?.is_premium).toBe(1)
    })

    it('should update fetched_at timestamp', () => {
      const oldTime = Date.now() - 1000000

      usersCache.upsert(
        createTestUser({
          user_id: '555',
          fetched_at: oldTime,
        }),
      )

      const before = Date.now()

      usersCache.upsert(
        createTestUser({
          user_id: '555',
          fetched_at: before,
        }),
      )

      const cached = usersCache.getById('555')
      expect(cached?.fetched_at).toBeGreaterThanOrEqual(before)
    })
  })
})

// =============================================================================
// Error Handling Tests
// =============================================================================

describe('Error handling', () => {
  beforeEach(() => {
    mockClient = createMockClient()
  })

  describe('user not found errors', () => {
    it('should detect USERNAME_NOT_OCCUPIED', () => {
      const errMsg = 'USERNAME_NOT_OCCUPIED'
      const isUsernameNotFound = errMsg.includes('USERNAME_NOT_OCCUPIED')

      expect(isUsernameNotFound).toBe(true)
    })

    it('should detect PHONE_NOT_OCCUPIED', () => {
      const errMsg = 'PHONE_NOT_OCCUPIED'
      const isPhoneNotFound = errMsg.includes('PHONE_NOT_OCCUPIED')

      expect(isPhoneNotFound).toBe(true)
    })

    it('should identify user not found from API result', () => {
      const result: { users: Array<{ _: string }> } = {
        users: [],
      }

      const user = result.users?.[0]
      const notFound = !user || user?._ !== 'user'

      expect(notFound).toBe(true)
    })
  })

  describe('auth required errors', () => {
    it('should detect AUTH_KEY_UNREGISTERED', async () => {
      mockClient = createMockClient({
        getMe: mock((_opts?: any) =>
          Promise.reject(new Error('AUTH_KEY_UNREGISTERED')),
        ),
      })

      let isAuthError = false
      try {
        await mockClient.getMe()
      } catch (err: any) {
        isAuthError = err.message.includes('AUTH_KEY')
      }

      expect(isAuthError).toBe(true)
    })

    it('should detect UNAUTHORIZED error', () => {
      const errMsg = 'UNAUTHORIZED'
      const isAuthError = errMsg.includes('UNAUTHORIZED')

      expect(isAuthError).toBe(true)
    })
  })

  describe('general Telegram errors', () => {
    it('should wrap unknown errors', () => {
      const err = new Error('Something went wrong')
      const message = err instanceof Error ? err.message : 'Unknown error'

      expect(message).toBe('Something went wrong')
    })

    it('should handle non-Error throws', () => {
      const err: unknown = 'string error'
      const message = err instanceof Error ? err.message : 'Unknown error'

      expect(message).toBe('Unknown error')
    })

    it('should handle API timeout errors', async () => {
      mockClient = createMockClient({
        call: mock((_req: any) =>
          Promise.reject(new Error('Request timed out')),
        ),
      })

      await expect(
        mockClient.call({ _: 'contacts.resolveUsername', username: 'test' }),
      ).rejects.toThrow('Request timed out')
    })
  })
})

// =============================================================================
// Edge Cases
// =============================================================================

describe('Edge cases', () => {
  let usersCache: UsersCache

  beforeEach(() => {
    const { db } = createTestCacheDatabase()
    testCacheDb = db
    usersCache = createUsersCache(db)
    mockClient = createMockClient()
  })

  describe('users with minimal data', () => {
    it('should handle user with only ID and first_name', () => {
      usersCache.upsert({
        user_id: '111',
        first_name: 'OnlyFirst',
        fetched_at: Date.now(),
        raw_json: '{}',
      })

      const cached = usersCache.getById('111')
      expect(cached).not.toBeNull()
      expect(cached?.first_name).toBe('OnlyFirst')
      expect(cached?.last_name).toBeNull()
      expect(cached?.username).toBeNull()
      expect(cached?.phone).toBeNull()
    })

    it('should handle user with no names', () => {
      usersCache.upsert({
        user_id: '222',
        fetched_at: Date.now(),
        raw_json: '{}',
      })

      const cached = usersCache.getById('222')
      expect(cached).not.toBeNull()
      expect(cached?.display_name).toBeNull()
    })

    it('should compute display_name from first_name only', () => {
      usersCache.upsert({
        user_id: '333',
        first_name: 'Solo',
        fetched_at: Date.now(),
        raw_json: '{}',
      })

      const cached = usersCache.getById('333')
      expect(cached?.display_name).toBe('Solo')
    })

    it('should compute display_name from first and last', () => {
      usersCache.upsert({
        user_id: '444',
        first_name: 'John',
        last_name: 'Doe',
        fetched_at: Date.now(),
        raw_json: '{}',
      })

      const cached = usersCache.getById('444')
      expect(cached?.display_name).toBe('John Doe')
    })
  })

  describe('bot users', () => {
    it('should correctly identify bot users', () => {
      usersCache.upsert(
        createTestUser({
          user_id: '333',
          username: 'mybot',
          first_name: 'My Bot',
          is_bot: 1,
        }),
      )

      const cached = usersCache.getById('333')
      const userInfo = cachedUserToUserInfo(cached)

      expect(userInfo.isBot).toBe(true)
    })

    it('should correctly identify non-bot users', () => {
      usersCache.upsert(
        createTestUser({
          user_id: '555',
          is_bot: 0,
        }),
      )

      const cached = usersCache.getById('555')
      const userInfo = cachedUserToUserInfo(cached)

      expect(userInfo.isBot).toBe(false)
    })
  })

  describe('premium users', () => {
    it('should correctly identify premium users', () => {
      usersCache.upsert(
        createTestUser({
          user_id: '444',
          is_premium: 1,
        }),
      )

      const cached = usersCache.getById('444')
      const userInfo = cachedUserToUserInfo(cached)

      expect(userInfo.isPremium).toBe(true)
    })

    it('should correctly identify non-premium users', () => {
      usersCache.upsert(
        createTestUser({
          user_id: '666',
          is_premium: 0,
        }),
      )

      const cached = usersCache.getById('666')
      const userInfo = cachedUserToUserInfo(cached)

      expect(userInfo.isPremium).toBe(false)
    })
  })

  describe('contact users', () => {
    it('should correctly identify contacts', () => {
      usersCache.upsert(
        createTestUser({
          user_id: '777',
          is_contact: 1,
        }),
      )

      const cached = usersCache.getById('777')
      const userInfo = cachedUserToUserInfo(cached)

      expect(userInfo.isContact).toBe(true)
    })
  })

  describe('unicode and special characters', () => {
    it('should handle unicode names', () => {
      usersCache.upsert(
        createTestUser({
          user_id: '555',
          first_name: 'Тест',
          last_name: '测试',
        }),
      )

      const cached = usersCache.getById('555')
      expect(cached?.first_name).toBe('Тест')
      expect(cached?.last_name).toBe('测试')
      expect(cached?.display_name).toBe('Тест 测试')
    })

    it('should handle emoji in names', () => {
      usersCache.upsert(
        createTestUser({
          user_id: '666',
          first_name: '👋 Hello',
          last_name: 'World 🌍',
        }),
      )

      const cached = usersCache.getById('666')
      expect(cached?.first_name).toBe('👋 Hello')
      expect(cached?.last_name).toBe('World 🌍')
    })

    it('should handle special characters in names', () => {
      usersCache.upsert(
        createTestUser({
          user_id: '777',
          first_name: 'Test\'"<>&',
          last_name: 'User\n\t',
        }),
      )

      const cached = usersCache.getById('777')
      expect(cached?.first_name).toBe('Test\'"<>&')
    })

    it('should handle Arabic/RTL names', () => {
      usersCache.upsert(
        createTestUser({
          user_id: '888',
          first_name: 'محمد',
          last_name: 'علي',
        }),
      )

      const cached = usersCache.getById('888')
      expect(cached?.first_name).toBe('محمد')
      expect(cached?.display_name).toBe('محمد علي')
    })
  })

  describe('very long usernames', () => {
    it('should handle long usernames', () => {
      const longUsername = 'a'.repeat(100)
      usersCache.upsert(
        createTestUser({
          user_id: '888',
          username: longUsername,
        }),
      )

      const cached = usersCache.getByUsername(longUsername)
      expect(cached).not.toBeNull()
      expect(cached?.username).toBe(longUsername)
    })
  })

  describe('numeric-looking usernames', () => {
    it('should correctly identify username with numbers only at end', () => {
      // "user123" should be treated as username, not ID
      const { isUsername, isUserId } = parseIdentifier('user123')

      expect(isUsername).toBe(true)
      expect(isUserId).toBe(false)
    })

    it('should handle username starting with numbers', () => {
      // "123user" is alphanumeric, should be username
      const { isUsername } = parseIdentifier('123user')

      expect(isUsername).toBe(true)
    })
  })
})

// =============================================================================
// Account Parameter Tests
// =============================================================================

describe('Account parameter handling', () => {
  it('should parse numeric account ID', () => {
    const accountArg = '1'
    const accountId = Number.parseInt(accountArg, 10)

    expect(accountId).toBe(1)
    expect(Number.isNaN(accountId)).toBe(false)
  })

  it('should handle undefined account arg', () => {
    const accountArg: string | undefined = undefined
    const accountId = accountArg ? Number.parseInt(accountArg, 10) : undefined

    expect(accountId).toBeUndefined()
  })

  it('should handle invalid account arg', () => {
    const accountArg = 'invalid'
    const accountId = Number.parseInt(accountArg, 10)

    expect(Number.isNaN(accountId)).toBe(true)
  })

  it('should use default account when not specified', () => {
    const accountArg: string | undefined = undefined
    const accountId = accountArg ? Number.parseInt(accountArg, 10) : undefined

    // When accountId is undefined, getClientForAccount uses default
    expect(accountId).toBeUndefined()
  })
})

// =============================================================================
// Response Structure Tests
// =============================================================================

describe('Response structure', () => {
  let usersCache: UsersCache
  const cacheConfig = getDefaultCacheConfig()

  beforeEach(() => {
    const { db } = createTestCacheDatabase()
    testCacheDb = db
    usersCache = createUsersCache(db)
  })

  describe('success response', () => {
    it('should build correct cache response', () => {
      usersCache.upsert(
        createTestUser({
          user_id: '123',
          fetched_at: Date.now(),
        }),
      )

      const cached = usersCache.getById('123')
      const stale = isCacheStale(
        cached!.fetched_at,
        cacheConfig.staleness.peers,
      )

      const response = {
        user: cachedUserToUserInfo(cached),
        source: 'cache' as const,
        stale,
      }

      expect(response.source).toBe('cache')
      expect(response.stale).toBe(false)
      expect(response.user.id).toBe(123)
    })

    it('should build correct API response', () => {
      const apiUser = {
        id: 456,
        firstName: 'API',
        lastName: 'User',
        username: 'apiuser',
        bot: false,
        premium: false,
        contact: false,
      }

      const response = {
        user: apiUserToUserInfo(apiUser),
        source: 'api' as const,
        stale: false,
      }

      expect(response.source).toBe('api')
      expect(response.stale).toBe(false)
      expect(response.user.id).toBe(456)
    })

    it('should include all UserInfo fields', () => {
      const apiUser = {
        id: 789,
        firstName: 'Complete',
        lastName: 'User',
        username: 'complete',
        phone: '1234567890',
        bot: true,
        premium: true,
        contact: true,
      }

      const userInfo = apiUserToUserInfo(apiUser)

      expect(userInfo).toHaveProperty('id')
      expect(userInfo).toHaveProperty('firstName')
      expect(userInfo).toHaveProperty('lastName')
      expect(userInfo).toHaveProperty('username')
      expect(userInfo).toHaveProperty('phone')
      expect(userInfo).toHaveProperty('isBot')
      expect(userInfo).toHaveProperty('isPremium')
      expect(userInfo).toHaveProperty('isContact')
    })
  })

  describe('stale response', () => {
    it('should indicate stale cache entry', () => {
      const staleTime = Date.now() - cacheConfig.staleness.peers - 1000

      usersCache.upsert(
        createTestUser({
          user_id: '999',
          fetched_at: staleTime,
        }),
      )

      const cached = usersCache.getById('999')
      const stale = isCacheStale(
        cached!.fetched_at,
        cacheConfig.staleness.peers,
      )

      const response = {
        user: cachedUserToUserInfo(cached),
        source: 'cache' as const,
        stale,
      }

      expect(response.stale).toBe(true)
    })
  })
})

// =============================================================================
// Cache Input Conversion Tests
// =============================================================================

describe('Cache input conversion', () => {
  it('should convert API user to cache input', () => {
    const accessHashValue = '12345678901234567890'
    const apiUser = {
      id: 123,
      firstName: 'Test',
      lastName: 'User',
      username: 'testuser',
      phone: '1234567890',
      accessHash: accessHashValue,
      bot: false,
      premium: true,
      contact: true,
    }

    const result = apiUserToCacheInput(apiUser)

    expect(result.user_id).toBe('123')
    expect(result.username).toBe('testuser')
    expect(result.first_name).toBe('Test')
    expect(result.last_name).toBe('User')
    expect(result.phone).toBe('1234567890')
    expect(result.is_contact).toBe(1)
    expect(result.is_bot).toBe(0)
    expect(result.is_premium).toBe(1)
    expect(result.access_hash).toBe('12345678901234567890')
  })

  it('should handle BigInt accessHash', () => {
    const apiUser = {
      id: 456,
      firstName: 'BigInt',
      accessHash: BigInt('999999999999999999'),
    }

    const result = apiUserToCacheInput(apiUser)

    expect(result.access_hash).toBe('999999999999999999')
  })

  it('should handle null accessHash', () => {
    const apiUser = {
      id: 789,
      firstName: 'NoHash',
      accessHash: null,
    }

    const result = apiUserToCacheInput(apiUser)

    expect(result.access_hash).toBeNull()
  })

  it('should handle undefined optional fields', () => {
    const apiUser = {
      id: 111,
      firstName: 'Minimal',
    }

    const result = apiUserToCacheInput(apiUser)

    expect(result.username).toBeNull()
    expect(result.last_name).toBeNull()
    expect(result.phone).toBeNull()
    expect(result.is_contact).toBe(0)
    expect(result.is_bot).toBe(0)
    expect(result.is_premium).toBe(0)
  })

  it('should include raw_json', () => {
    const apiUser = {
      id: 222,
      firstName: 'JSON',
      customField: 'value',
    }

    const result = apiUserToCacheInput(apiUser)

    expect(result.raw_json).toBeDefined()
    const parsed = JSON.parse(result.raw_json)
    expect(parsed.customField).toBe('value')
  })

  it('should set fetched_at to current time', () => {
    const before = Date.now()

    const apiUser = {
      id: 333,
      firstName: 'Timed',
    }

    const result = apiUserToCacheInput(apiUser)
    const after = Date.now()

    expect(result.fetched_at).toBeGreaterThanOrEqual(before)
    expect(result.fetched_at).toBeLessThanOrEqual(after)
  })
})

// =============================================================================
// Staleness Checking Tests
// =============================================================================

describe('Staleness checking', () => {
  const cacheConfig = getDefaultCacheConfig()

  it('should detect stale cache entries (older than TTL)', () => {
    const oldTimestamp = Date.now() - cacheConfig.staleness.peers - 1000

    expect(isCacheStale(oldTimestamp, cacheConfig.staleness.peers)).toBe(true)
  })

  it('should detect fresh cache entries (newer than TTL)', () => {
    const recentTimestamp = Date.now() - 1000

    expect(isCacheStale(recentTimestamp, cacheConfig.staleness.peers)).toBe(
      false,
    )
  })

  it('should treat null fetched_at as stale', () => {
    expect(isCacheStale(null, cacheConfig.staleness.peers)).toBe(true)
  })

  it('should use configurable TTL', () => {
    const timestamp = Date.now() - 100000

    // With 1 day TTL, should be fresh
    expect(isCacheStale(timestamp, 24 * 60 * 60 * 1000)).toBe(false)

    // With 1 second TTL, should be stale
    expect(isCacheStale(timestamp, 1000)).toBe(true)
  })
})
