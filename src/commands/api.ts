/**
 * Generic API command - call any Telegram API method
 *
 * This enables full access to Telegram's API without manually
 * mapping every method to a CLI command.
 */
import { defineCommand } from 'citty'

import { getClientForAccount } from '../services/telegram'
import { success, error } from '../utils/output'
import { mergeArgs } from '../utils/args'
import { ErrorCodes } from '../types'

/**
 * Generic API command
 *
 * Usage:
 *   tg api account.checkUsername --username myuser
 *   tg api messages.getHistory --peer @username --limit 10
 *   tg api contacts.getContacts
 *   tg api messages.sendMessage --json '{"peer": "@user", "message": "Hello"}'
 */
export const apiCommand = defineCommand({
  meta: {
    name: 'api',
    description: 'Call any Telegram API method directly',
  },
  args: {
    method: {
      type: 'positional',
      description: 'Telegram API method name (e.g., account.checkUsername)',
      required: true,
    },
    json: {
      type: 'string',
      alias: 'j',
      description: 'JSON string with method arguments',
    },
    account: {
      type: 'string',
      alias: 'a',
      description: 'Account ID (uses active account if not specified)',
    },
    raw: {
      type: 'boolean',
      alias: 'r',
      description: 'Output raw response without wrapping',
      default: false,
    },
  },
  async run({ args }) {
    const method = args.method as string
    const accountId = args.account ? parseInt(args.account, 10) : undefined

    // Validate method name format
    if (!method.includes('.')) {
      error(
        ErrorCodes.INVALID_ARGS,
        `Invalid method name: "${method}". Expected format: namespace.methodName (e.g., account.checkUsername)`,
      )
    }

    try {
      const client = getClientForAccount(accountId)

      // Build request parameters
      // Remove known CLI args, keep the rest as API params
      const cliOnlyArgs = ['method', 'json', 'account', 'raw', '_', '--']
      const apiArgs: Record<string, unknown> = {}

      for (const [key, value] of Object.entries(args)) {
        if (!cliOnlyArgs.includes(key)) {
          apiArgs[key] = value
        }
      }

      // Merge with JSON input if provided
      const params = mergeArgs(apiArgs, args.json as string | undefined)

      // Make the API call
      const result = await client.call({ _: method, ...params } as any)

      // Output result
      if (args.raw) {
        console.log(JSON.stringify(result, replacer, 2))
      } else {
        success({
          method,
          result,
        })
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'

      // Try to extract Telegram error code
      let code = ErrorCodes.TELEGRAM_ERROR
      let details: Record<string, unknown> = { method }

      if (err instanceof Error && 'code' in err) {
        details.telegramErrorCode = (err as any).code
      }

      error(code, `API call failed: ${message}`, details)
    }
  },
})

/**
 * Custom JSON replacer to handle BigInt values
 */
function replacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') {
    return value.toString()
  }
  return value
}
