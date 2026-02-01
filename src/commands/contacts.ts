/**
 * Contact management commands
 */
import { defineCommand } from 'citty'

import { getClientForAccount } from '../services/telegram'
import { success, error } from '../utils/output'
import { ErrorCodes, type Contact, type PaginatedResult } from '../types'

/**
 * List contacts
 */
export const listContactsCommand = defineCommand({
  meta: {
    name: 'list',
    description: 'List contacts with pagination',
  },
  args: {
    limit: {
      type: 'string',
      description: 'Maximum number of contacts to return (default: 50)',
      default: '50',
    },
    offset: {
      type: 'string',
      description: 'Offset for pagination (default: 0)',
      default: '0',
    },
    account: {
      type: 'string',
      description: 'Account ID (uses active account if not specified)',
    },
  },
  async run({ args }) {
    const limit = parseInt(args.limit ?? '50', 10)
    const offset = parseInt(args.offset ?? '0', 10)
    const accountId = args.account ? parseInt(args.account, 10) : undefined

    try {
      const client = getClientForAccount(accountId)

      // Fetch contacts using raw API
      // hash should be bigint (Long) in mtcute
      const result = await client.call({ _: 'contacts.getContacts', hash: BigInt(0) } as any)

      if (result._ === 'contacts.contactsNotModified') {
        success({
          items: [],
          total: 0,
          offset,
          limit,
          hasMore: false,
          message: 'Contacts not modified since last fetch',
        })
        return
      }

      // Map users to our Contact type
      const allContacts: Contact[] = (result.users as any[])
        .filter((u: any) => u._ === 'user')
        .map((user: any) => ({
          id: user.id,
          firstName: user.firstName ?? '',
          lastName: user.lastName ?? null,
          username: user.username ?? null,
          phone: user.phone ?? null,
        }))

      // Apply pagination
      const paginatedContacts = allContacts.slice(offset, offset + limit)

      const response: PaginatedResult<Contact> = {
        items: paginatedContacts,
        total: allContacts.length,
        offset,
        limit,
        hasMore: offset + limit < allContacts.length,
      }

      success(response)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      error(ErrorCodes.TELEGRAM_ERROR, `Failed to fetch contacts: ${message}`)
    }
  },
})

/**
 * Search contacts
 */
export const searchContactsCommand = defineCommand({
  meta: {
    name: 'search',
    description: 'Search contacts by name or username',
  },
  args: {
    query: {
      type: 'string',
      description: 'Search query',
      required: true,
    },
    limit: {
      type: 'string',
      description: 'Maximum number of results (default: 20)',
      default: '20',
    },
    account: {
      type: 'string',
      description: 'Account ID (uses active account if not specified)',
    },
  },
  async run({ args }) {
    const query = args.query
    const limit = parseInt(args.limit ?? '20', 10)
    const accountId = args.account ? parseInt(args.account, 10) : undefined

    try {
      const client = getClientForAccount(accountId)

      // Search using Telegram's search
      const result = await client.call({
        _: 'contacts.search',
        q: query,
        limit,
      } as any)

      // Map users to our Contact type
      const contacts: Contact[] = (result.users as any[])
        .filter((u: any) => u._ === 'user')
        .map((user: any) => ({
          id: user.id,
          firstName: user.firstName ?? '',
          lastName: user.lastName ?? null,
          username: user.username ?? null,
          phone: user.phone ?? null,
        }))

      success({
        query,
        results: contacts,
        total: contacts.length,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      error(ErrorCodes.TELEGRAM_ERROR, `Search failed: ${message}`)
    }
  },
})

/**
 * Get contact by ID
 */
export const getContactCommand = defineCommand({
  meta: {
    name: 'get',
    description: 'Get contact information by user ID',
  },
  args: {
    id: {
      type: 'string',
      description: 'User ID',
      required: true,
    },
    account: {
      type: 'string',
      description: 'Account ID (uses active account if not specified)',
    },
  },
  async run({ args }) {
    const userId = parseInt(args.id, 10)
    const accountId = args.account ? parseInt(args.account, 10) : undefined

    try {
      const client = getClientForAccount(accountId)

      // Get user info - use resolvePeer for better compatibility
      const result = await client.call({
        _: 'users.getUsers',
        id: [{ _: 'inputUser', userId, accessHash: BigInt(0) }],
      } as any)

      const user = (result as any[]).find((u: any) => u._ === 'user')

      if (!user) {
        error(ErrorCodes.TELEGRAM_ERROR, `User with ID ${userId} not found`)
      }

      success({
        id: user.id,
        firstName: user.firstName ?? '',
        lastName: user.lastName ?? null,
        username: user.username ?? null,
        phone: user.phone ?? null,
        bio: user.about ?? null,
        isBot: user.bot ?? false,
        isVerified: user.verified ?? false,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      error(ErrorCodes.TELEGRAM_ERROR, `Failed to get user: ${message}`)
    }
  },
})

/**
 * Contacts subcommand group
 */
export const contactsCommand = defineCommand({
  meta: {
    name: 'contacts',
    description: 'Contact management commands',
  },
  subCommands: {
    list: listContactsCommand,
    search: searchContactsCommand,
    get: getContactCommand,
  },
})
