import { defineCommand } from 'citty'

import { getCacheDb } from '../../db'
import { getDefaultCacheConfig, isCacheStale } from '../../db/types'
import { createUsersCache } from '../../db/users-cache'
import { getClientForAccount } from '../../services/telegram'
import { ErrorCodes } from '../../types'
import { error, success, verbose } from '../../utils/output'
import { apiUserToCacheInput } from '../../utils/telegram-mappers'
import {
  apiUserToUserInfo,
  cachedUserToUserInfo,
  findCachedUser,
  parseUserIdentifier,
} from './helpers'

async function resolveUserByUsername(
  client: any,
  username: string,
): Promise<any> {
  const resolved = (await client.call({
    _: 'contacts.resolveUsername',
    username,
  } as any)) as any

  return resolved.users?.[0]
}

async function resolveUserByPhone(client: any, phone: string): Promise<any> {
  const resolved = (await client.call({
    _: 'contacts.resolvePhone',
    phone,
  } as any)) as any

  return resolved.users?.[0]
}

async function resolveUserById(client: any, identifier: string): Promise<any> {
  const userId = Number.parseInt(identifier, 10)
  const result = (await client.call({
    _: 'users.getUsers',
    id: [{ _: 'inputUser', userId, accessHash: BigInt(0) }],
  } as any)) as any[]

  return result.find((u: any) => u._ === 'user')
}

async function resolveUserFromApi(
  client: any,
  parsed: ReturnType<typeof parseUserIdentifier>,
): Promise<any> {
  if (parsed.kind === 'username') {
    verbose(`Resolving username: ${parsed.value}`)
    return resolveUserByUsername(client, parsed.value)
  }

  if (parsed.kind === 'phone') {
    verbose(`Resolving phone: ${parsed.value}`)
    return resolveUserByPhone(client, parsed.value)
  }

  verbose(`Fetching user ID: ${parsed.value}`)
  return resolveUserById(client, parsed.value)
}

function handleUserLookupError(err: any, _identifier: string): never {
  const errMsg = err?.message ?? String(err)
  if (errMsg.includes('USERNAME_NOT_OCCUPIED')) {
    error(ErrorCodes.TELEGRAM_ERROR, 'Username not found')
  }
  if (errMsg.includes('PHONE_NOT_OCCUPIED')) {
    error(ErrorCodes.TELEGRAM_ERROR, 'Phone number not found')
  }
  error(ErrorCodes.TELEGRAM_ERROR, `Failed to get user: ${errMsg}`)
}

export const userCommand = defineCommand({
  meta: {
    name: 'user',
    description: 'Look up a user by ID, @username, or phone number',
  },
  args: {
    identifier: {
      type: 'positional',
      description: 'User ID, @username, or phone number',
      required: true,
    },
    account: {
      type: 'string',
      description: 'Account ID (uses active account if not specified)',
    },
    fresh: {
      type: 'boolean',
      description: 'Bypass cache and fetch from API',
      default: false,
    },
  },
  async run({ args }) {
    try {
      const identifier = args.identifier as string
      const accountId = args.account
        ? Number.parseInt(args.account, 10)
        : undefined
      const fresh = args.fresh ?? false

      const parsed = parseUserIdentifier(identifier)

      const cacheDb = getCacheDb()
      const usersCache = createUsersCache(cacheDb)
      const cacheConfig = getDefaultCacheConfig()

      if (!fresh) {
        const cached = findCachedUser(usersCache, parsed)
        if (cached) {
          const stale = isCacheStale(
            cached.fetched_at,
            cacheConfig.staleness.peers,
          )

          verbose(`Returning cached user (stale: ${stale})`)
          success({
            user: cachedUserToUserInfo(cached),
            source: 'cache' as const,
            stale,
          })
          return
        }
      }

      verbose('Fetching user from API...')
      const client = getClientForAccount(accountId)

      const user = await resolveUserFromApi(client, parsed)

      if (!user || user._ !== 'user') {
        error(ErrorCodes.TELEGRAM_ERROR, `User not found: ${identifier}`)
      }

      usersCache.upsert(apiUserToCacheInput(user))

      success({
        user: apiUserToUserInfo(user),
        source: 'api' as const,
        stale: false,
      })
    } catch (err: any) {
      handleUserLookupError(err, args.identifier as string)
    }
  },
})
