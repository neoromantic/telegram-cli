/**
 * Authentication commands
 */
import { defineCommand } from 'citty'
import * as readline from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import * as qrcode from 'qrcode-terminal'

import { accountsDb } from '../db'
import { createClient, getClient, isAuthorized } from '../services/telegram'
import { success, error, info } from '../utils/output'
import { ErrorCodes } from '../types'

/**
 * Prompt user for input
 */
async function prompt(message: string): Promise<string> {
  const rl = readline.createInterface({ input, output })
  try {
    const answer = await rl.question(message)
    return answer.trim()
  } finally {
    rl.close()
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

    // Check if account already exists
    let account = accountsDb.getByPhone(phone)
    if (!account) {
      // Create new account record
      account = accountsDb.create({ phone, is_active: true })
      info(`Created new account record for ${phone}`)
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
          return await prompt('Enter 2FA password: ')
        },
      })

      // Update account with user info
      accountsDb.update(account.id, {
        name: `${user.firstName}${user.lastName ? ' ' + user.lastName : ''}`,
      })

      success({
        message: 'Successfully logged in',
        account: {
          id: account.id,
          phone: account.phone,
          name: user.firstName,
          username: user.username,
        },
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      error(ErrorCodes.TELEGRAM_ERROR, `Login failed: ${message}`, { phone })
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
    // Create a new account record for QR login
    const accountName = args.name || `qr_account_${Date.now()}`
    const account = accountsDb.create({
      phone: `qr:${accountName}`, // QR logins don't have phone until authenticated
      name: accountName,
      is_active: true,
    })

    info(`Created account record: ${account.id}`)
    const client = createClient(account.id)

    try {
      console.log('\n=== QR Code Login ===\n')
      console.log('Scan this QR code with your Telegram mobile app:')
      console.log('(Settings → Devices → Link Desktop Device)\n')

      const user = await client.signInQr({
        onUrlUpdated: (url: string, expires: Date) => {
          // Generate QR code in terminal
          qrcode.generate(url, { small: true }, (qrText: string) => {
            console.log(qrText)
          })
          console.log(`\nExpires: ${expires.toLocaleTimeString()}`)
          console.log('Waiting for scan...\n')
        },
        onQrScanned: () => {
          console.log('✓ QR code scanned! Completing authentication...')
        },
        password: async () => {
          return await prompt('\nEnter 2FA password: ')
        },
        invalidPasswordCallback: () => {
          console.log('Invalid password, please try again.')
        },
      })

      // Update account with user info
      accountsDb.update(account.id, {
        phone: `user:${user.id}`, // QR logins don't expose phone number
        name: `${user.firstName}${user.lastName ? ' ' + user.lastName : ''}`,
      })

      success({
        message: 'Successfully logged in via QR code',
        account: {
          id: account.id,
          name: user.firstName,
          username: user.username,
          userId: user.id,
        },
      })
    } catch (err) {
      // Clean up account on failure
      accountsDb.delete(account.id)
      const message = err instanceof Error ? err.message : 'Unknown error'
      error(ErrorCodes.TELEGRAM_ERROR, `QR login failed: ${message}`)
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
      description: 'Account ID to logout (uses active account if not specified)',
    },
  },
  async run({ args }) {
    const accountId = args.account ? parseInt(args.account, 10) : undefined
    const account = accountId ? accountsDb.getById(accountId) : accountsDb.getActive()

    if (!account) {
      error(ErrorCodes.ACCOUNT_NOT_FOUND, 'No account found to logout')
    }

    const client = getClient(account.id)

    try {
      // Log out from Telegram
      await client.call({ _: 'auth.logOut' })

      // Remove account from database
      accountsDb.delete(account.id)

      success({
        message: 'Successfully logged out',
        accountId: account.id,
        phone: account.phone,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      error(ErrorCodes.TELEGRAM_ERROR, `Logout failed: ${message}`)
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
    const account = accountId ? accountsDb.getById(accountId) : accountsDb.getActive()

    if (!account) {
      success({
        authenticated: false,
        message: 'No account configured',
      })
      return
    }

    const client = getClient(account.id)

    try {
      const authorized = await isAuthorized(client)

      if (authorized) {
        const me = await client.getMe()
        success({
          authenticated: true,
          account: {
            id: account.id,
            phone: account.phone,
            name: me.firstName,
            username: me.username,
            userId: me.id,
          },
        })
      } else {
        success({
          authenticated: false,
          account: {
            id: account.id,
            phone: account.phone,
          },
          message: 'Account exists but not authenticated. Run "tg auth login" to authenticate.',
        })
      }
    } catch (err) {
      success({
        authenticated: false,
        account: {
          id: account.id,
          phone: account.phone,
        },
        message: 'Could not verify authentication status',
      })
    }
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
