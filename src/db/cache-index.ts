/**
 * Cache module index - Re-exports all cache-related types, functions, and services
 * Provides unified access to cache functionality from a single import point
 *
 * Usage:
 * ```typescript
 * import {
 *   UsersCache,
 *   ChatsCache,
 *   RateLimitsService,
 *   isCacheStale,
 *   createTestCacheDatabase,
 * } from './db/cache-index'
 * ```
 */

// =============================================================================
// Types - from types.ts
// =============================================================================

export type {
  ApiActivityEntry,
  CacheConfig,
  CachedChat,
  CachedChatInput,
  CachedMessage,
  CachedMessageInput,
  CachedUser,
  CachedUserInput,
  CacheLookupOptions,
  CacheLookupResult,
  CacheSource,
  CacheStalenessConfig,
  CacheStalenessConfigReadable,
  CacheStats,
  CacheTableStats,
  ChatType,
  DurationString,
  DurationUnit,
  MessageType,
  RateLimitEntry,
  RefreshJob,
  RefreshJobStatus,
  RefreshPeerType,
  SyncEntityType,
  SyncState,
} from './types'

export { getDefaultCacheConfig, isCacheStale, parseDuration } from './types'

// =============================================================================
// Schema - from schema.ts
// =============================================================================

export {
  ApiActivityRow,
  ChatCacheRow,
  createTestCacheDatabase,
  initCacheSchema,
  RateLimitRow,
  UserCacheRow,
} from './schema'

// Note: SyncStateRow is exported from schema.ts (not types.ts) to avoid duplicate

// =============================================================================
// Users Cache - from users-cache.ts
// =============================================================================

export type {
  CachedUser as CachedUserData,
  UserCacheInput,
} from './users-cache'

export { createUsersCache, UsersCache } from './users-cache'

// =============================================================================
// Chats Cache - from chats-cache.ts
// =============================================================================

export type {
  CachedChat as CachedChatData,
  ListChatsOptions,
} from './chats-cache'

export { ChatsCache, createChatsCache } from './chats-cache'

// =============================================================================
// Rate Limits - from rate-limits.ts
// =============================================================================

export type {
  FloodWaitInfo,
  GetActivityOptions,
  RateLimitStatus,
} from './rate-limits'

export { createRateLimitsService, RateLimitsService } from './rate-limits'
