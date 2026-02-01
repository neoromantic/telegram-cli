/**
 * Authentication commands
 */

import { stdin as input, stdout as output } from 'node:process'
import * as readline from 'node:readline/promises'
import type { TelegramClient } from '@mtcute/bun'
import { defineCommand } from 'citty'

import {
  type AccountsDbInterface,
  accountsDb as defaultAccountsDb,
} from '../db'
import { createClient, getClient, isAuthorized } from '../services/telegram'
import { ErrorCodes } from '../types'
import { error, info, success } from '../utils/output'

/**
 * QR code generator interface for dependency injection
 */
export interface QrCodeGenerator {
  generate(
    url: string,
    options: { small: boolean },
    callback: (qr: string) => void,
  ): void
}

/**
 * Default QR code generator using qrcode-terminal
 */
let defaultQrGenerator: QrCodeGenerator | null = null

async function getQrGenerator(): Promise<QrCodeGenerator> {
  if (!defaultQrGenerator) {
    const qrcode = await import('qrcode-terminal')
    defaultQrGenerator = qrcode
  }
  return defaultQrGenerator
}

/**
 * Prompt user for input
 */
export async function prompt(message: string): Promise<string> {
  const rl = readline.createInterface({ input, output })
  try {
    const answer = await rl.question(message)
    return answer.trim()
  } finally {
    rl.close()
  }
}

/**
 * Prompt user for password input (hidden for privacy)
 * Falls back to regular prompt for non-TTY environments
 */
export async function promptPassword(message: string): Promise<string> {
  // Fall back to regular prompt for non-TTY environments
  if (!process.stdin.isTTY) {
    return prompt(message)
  }

  // Use sync readline API for output hijacking (promises API doesn't expose _writeToOutput)
  const syncReadline = await import('node:readline')

  const rl = syncReadline.createInterface({
    input,
    output,
    terminal: true,
  })

  // Hijack output to hide typed characters
  let stdoutMuted = false
  const originalWriteToOutput = (rl as any)._writeToOutput
  ;(rl as any)._writeToOutput = (stringToWrite: string) => {
    if (!stdoutMuted) {
      originalWriteToOutput.call(rl, stringToWrite)
    }
  }

  return new Promise((resolve) => {
    rl.question(message, (answer) => {
      output.write('\n')
      rl.close()
      resolve(answer.trim())
    })
    stdoutMuted = true
  })
}

/**
 * Authentication dependencies for dependency injection
 */
export interface AuthDependencies {
  accountsDb: AccountsDbInterface
  createClient: (accountId: number) => TelegramClient
  getClient: (accountId: number) => TelegramClient
  isAuthorized: (client: TelegramClient) => Promise<boolean>
  prompt: (message: string) => Promise<string>
  promptPassword: (message: string) => Promise<string>
  qrGenerator?: QrCodeGenerator
}

/**
 * Get default auth dependencies
 */
export function getDefaultDependencies(): AuthDependencies {
  return {
    accountsDb: defaultAccountsDb,
    createClient,
    getClient,
    isAuthorized,
    prompt,
    promptPassword,
  }
}

/**
 * Login with phone number - core logic
 */
export async function loginWithPhone(
  phone: string,
  deps: AuthDependencies,
): Promise<{
  success: boolean
  account?: { id: number; phone: string; name?: string; username?: string }
  error?: string
}> {
  const { accountsDb, createClient, prompt, promptPassword } = deps

  // Check if account already exists
  let account = accountsDb.getByPhone(phone)
  if (!account) {
    // Create new account record
    account = accountsDb.create({ phone, is_active: true })
  } else {
    // Set as active
    accountsDb.setActive(account.id)
  }

  const client = createClient(account.id)

  try {
    // Start authentication flow
    const user = await client.start({
      phone: () => Promise.resolve(phone),
      code: async () => {
        return await prompt('Enter the verification code: ')
      },
      password: async () => {
        return await promptPassword('Enter 2FA password: ')
      },
    })

    // Check if an account with this user_id already exists (to handle duplicates)
    const existingAccount = accountsDb.getByUserId(user.id)
    let finalAccount = account

    if (existingAccount && existingAccount.id !== account.id) {
      // Duplicate found! Merge: keep the existing account, delete the new one
      // Update existing account with the new phone number and name
      accountsDb.update(existingAccount.id, {
        phone,
        name: `${user.firstName}${user.lastName ? ` ${user.lastName}` : ''}`,
      })
      accountsDb.setActive(existingAccount.id)

      // Delete the newly created account
      accountsDb.delete(account.id)
      finalAccount = existingAccount
    } else {
      // No duplicate, update the current account with user_id and name
      accountsDb.update(account.id, {
        user_id: user.id,
        name: `${user.firstName}${user.lastName ? ` ${user.lastName}` : ''}`,
      })
    }

    // Close client to allow process to exit
    await (client as any).close()

    return {
      success: true,
      account: {
        id: finalAccount.id,
        phone: phone,
        name: user.firstName,
        username: user.username ?? undefined,
      },
    }
  } catch (err) {
    // Close client even on error
    await (client as any).close().catch(() => {})
    const message = err instanceof Error ? err.message : 'Unknown error'
    return { success: false, error: message }
  }
}

/**
 * Login via QR code - core logic
 */
export async function loginWithQr(
  accountName: string | undefined,
  deps: AuthDependencies,
): Promise<{
  success: boolean
  account?: { id: number; name?: string; username?: string; userId?: number }
  error?: string
}> {
  const { accountsDb, createClient, qrGenerator } = deps

  // Create a new account record for QR login
  const name = accountName || `qr_account_${Date.now()}`
  const account = accountsDb.create({
    phone: `qr:${name}`, // QR logins don't have phone until authenticated
    name,
    is_active: true,
  })

  const client = createClient(account.id)

  try {
    const qr = qrGenerator || (await getQrGenerator())

    const user = await client.signInQr({
      onUrlUpdated: (url: string, expires: Date) => {
        // Generate QR code in terminal
        qr.generate(url, { small: true }, (qrText: string) => {
          console.log(qrText)
        })
        console.log(`\nExpires: ${expires.toLocaleTimeString()}`)
        console.log('Waiting for scan...\n')
      },
      onQrScanned: () => {
        console.log('✓ QR code scanned! Completing authentication...')
      },
      password: async () => {
        return await deps.promptPassword('\nEnter 2FA password: ')
      },
      invalidPasswordCallback: () => {
        console.log('Invalid password, please try again.')
      },
    })

    // Check if an account with this user_id already exists (to handle duplicates)
    const existingAccount = accountsDb.getByUserId(user.id)
    let finalAccount = account

    if (existingAccount && existingAccount.id !== account.id) {
      // Duplicate found! Merge: keep the existing account, delete the new one
      // Update existing account with user info
      accountsDb.update(existingAccount.id, {
        user_id: user.id,
        name: `${user.firstName}${user.lastName ? ` ${user.lastName}` : ''}`,
      })
      accountsDb.setActive(existingAccount.id)

      // Delete the newly created account
      accountsDb.delete(account.id)
      finalAccount = existingAccount
    } else {
      // No duplicate, update the current account with user_id and name
      accountsDb.update(account.id, {
        phone: `user:${user.id}`, // QR logins don't expose phone number
        user_id: user.id,
        name: `${user.firstName}${user.lastName ? ` ${user.lastName}` : ''}`,
      })
    }

    // Close client to allow process to exit
    await (client as any).close()

    return {
      success: true,
      account: {
        id: finalAccount.id,
        name: user.firstName,
        username: user.username ?? undefined,
        userId: user.id,
      },
    }
  } catch (err) {
    // Close client even on error
    await (client as any).close().catch(() => {})
    // Clean up account on failure
    accountsDb.delete(account.id)
    const message = err instanceof Error ? err.message : 'Unknown error'
    return { success: false, error: message }
  }
}

/**
 * Logout from account - core logic
 */
export async function logout(
  accountId: number | undefined,
  deps: AuthDependencies,
): Promise<{
  success: boolean
  accountId?: number
  phone?: string
  error?: string
}> {
  const { accountsDb, getClient } = deps

  const account = accountId
    ? accountsDb.getById(accountId)
    : accountsDb.getActive()

  if (!account) {
    return { success: false, error: 'No account found to logout' }
  }

  const client = getClient(account.id)

  try {
    // Log out from Telegram
    await client.call({ _: 'auth.logOut' })

    // Close client to allow process to exit
    await (client as any).close()

    // Remove account from database
    accountsDb.delete(account.id)

    return {
      success: true,
      accountId: account.id,
      phone: account.phone,
    }
  } catch (err) {
    // Close client even on error
    await (client as any).close().catch(() => {})
    const message = err instanceof Error ? err.message : 'Unknown error'
    return { success: false, error: message }
  }
}

/**
 * Get authentication status - core logic
 */
export async function getAuthStatus(
  accountId: number | undefined,
  deps: AuthDependencies,
): Promise<{
  authenticated: boolean
  account?: {
    id: number
    phone: string
    name?: string
    username?: string
    userId?: number
  }
  message?: string
}> {
  const { accountsDb, getClient, isAuthorized } = deps

  const account = accountId
    ? accountsDb.getById(accountId)
    : accountsDb.getActive()

  if (!account) {
    return {
      authenticated: false,
      message: 'No account configured',
    }
  }

  const client = getClient(account.id)

  try {
    const authorized = await isAuthorized(client)

    if (authorized) {
      const me = await client.getMe()
      // Close client to allow process to exit
      await (client as any).close()
      return {
        authenticated: true,
        account: {
          id: account.id,
          phone: account.phone,
          name: me.firstName,
          username: me.username ?? undefined,
          userId: me.id,
        },
      }
    }

    // Close client to allow process to exit
    await (client as any).close()
    return {
      authenticated: false,
      account: {
        id: account.id,
        phone: account.phone,
      },
      message:
        'Account exists but not authenticated. Run "tg auth login" to authenticate.',
    }
  } catch {
    // Close client even on error
    await (client as any).close().catch(() => {})
    return {
      authenticated: false,
      account: {
        id: account.id,
        phone: account.phone,
      },
      message: 'Could not verify authentication status',
    }
  }
}

/**
 * Login command - authenticate a new or existing account
 */
export const loginCommand = defineCommand({
  meta: {
    name: 'login',
    description: 'Login to a Telegram account',
  },
  args: {
    phone: {
      type: 'string',
      description: 'Phone number in international format (e.g., +79261408252)',
      required: true,
    },
  },
  async run({ args }) {
    const phone = args.phone

    info(`Logging in with phone: ${phone}`)
    const result = await loginWithPhone(phone, getDefaultDependencies())

    if (result.success && result.account) {
      success({
        message: 'Successfully logged in',
        account: result.account,
      })
    } else {
      error(ErrorCodes.TELEGRAM_ERROR, `Login failed: ${result.error}`, {
        phone,
      })
    }
  },
})

/**
 * Login via QR code - scan with Telegram mobile app
 */
export const loginQrCommand = defineCommand({
  meta: {
    name: 'login-qr',
    description: 'Login via QR code (scan with Telegram mobile app)',
  },
  args: {
    name: {
      type: 'string',
      description: 'Account name/label for this session',
    },
  },
  async run({ args }) {
    console.log('\n=== QR Code Login ===\n')
    console.log('Scan this QR code with your Telegram mobile app:')
    console.log('(Settings → Devices → Link Desktop Device)\n')

    const result = await loginWithQr(args.name, getDefaultDependencies())

    if (result.success && result.account) {
      success({
        message: 'Successfully logged in via QR code',
        account: result.account,
      })
    } else {
      error(ErrorCodes.TELEGRAM_ERROR, `QR login failed: ${result.error}`)
    }
  },
})

/**
 * Logout command - sign out from an account
 */
export const logoutCommand = defineCommand({
  meta: {
    name: 'logout',
    description: 'Logout from a Telegram account',
  },
  args: {
    account: {
      type: 'string',
      description:
        'Account ID to logout (uses active account if not specified)',
    },
  },
  async run({ args }) {
    const accountId = args.account ? parseInt(args.account, 10) : undefined

    const result = await logout(accountId, getDefaultDependencies())

    if (result.success) {
      success({
        message: 'Successfully logged out',
        accountId: result.accountId,
        phone: result.phone,
      })
    } else {
      if (result.error === 'No account found to logout') {
        error(ErrorCodes.ACCOUNT_NOT_FOUND, result.error)
      } else {
        error(ErrorCodes.TELEGRAM_ERROR, `Logout failed: ${result.error}`)
      }
    }
  },
})

/**
 * Status command - check authentication status
 */
export const statusCommand = defineCommand({
  meta: {
    name: 'status',
    description: 'Check authentication status',
  },
  args: {
    account: {
      type: 'string',
      description: 'Account ID to check (uses active account if not specified)',
    },
  },
  async run({ args }) {
    const accountId = args.account ? parseInt(args.account, 10) : undefined

    const result = await getAuthStatus(accountId, getDefaultDependencies())

    success(result)
  },
})

/**
 * Auth subcommand group
 */
export const authCommand = defineCommand({
  meta: {
    name: 'auth',
    description: 'Authentication commands',
  },
  subCommands: {
    login: loginCommand,
    'login-qr': loginQrCommand,
    logout: logoutCommand,
    status: statusCommand,
  },
})
