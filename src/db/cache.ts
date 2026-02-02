/**
 * Cache module - re-exports from specialized cache services
 *
 * The generic CacheService has been removed in favor of specialized
 * cache services (UsersCache, ChatsCache, MessagesCache) which provide
 * type-safe, domain-specific operations.
 *
 * @deprecated This module is kept for backwards compatibility.
 * Import from specialized modules directly:
 * - ./users-cache for UsersCache
 * - ./chats-cache for ChatsCache
 * - ./messages-cache for MessagesCache
 */

// This file is intentionally minimal - all cache functionality
// is provided by specialized cache services.
