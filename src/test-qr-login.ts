/**
 * Test script for QR code login
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { stdin as input, stdout as output } from 'node:process'
import * as readline from 'node:readline/promises'
import { TelegramClient } from '@mtcute/bun'
import * as qrcode from 'qrcode-terminal'

const API_ID = parseInt(process.env.TELEGRAM_API_ID ?? '0', 10)
const API_HASH = process.env.TELEGRAM_API_HASH ?? ''

if (!API_ID || !API_HASH) {
  console.error('Missing TELEGRAM_API_ID or TELEGRAM_API_HASH')
  process.exit(1)
}

const DATA_DIR = join(homedir(), '.telegram-cli')
const SESSION_PATH = join(DATA_DIR, 'qr_session.db')

console.log('=== QR Code Login Test ===')
console.log(`Session: ${SESSION_PATH}`)
console.log('')

const client = new TelegramClient({
  apiId: API_ID,
  apiHash: API_HASH,
  storage: SESSION_PATH,
  logLevel: 3,
})

async function prompt(message: string): Promise<string> {
  const rl = readline.createInterface({ input, output })
  try {
    const answer = await rl.question(message)
    return answer.trim()
  } finally {
    rl.close()
  }
}

console.log('Starting QR login flow...')
console.log('Scan the QR code with your Telegram mobile app:\n')

try {
  const user = await client.signInQr({
    onUrlUpdated: (url: string, expires: Date) => {
      console.clear()
      console.log('=== QR Code Login ===\n')
      console.log('Scan this QR code with your Telegram mobile app:')
      console.log('(Settings → Devices → Link Desktop Device)\n')

      // Generate QR code in terminal
      qrcode.generate(url, { small: true }, (qrText: string) => {
        console.log(qrText)
      })

      console.log(`\nExpires: ${expires.toLocaleTimeString()}`)
      console.log('\nWaiting for scan...')
    },
    onQrScanned: () => {
      console.log('\n✓ QR code scanned! Completing authentication...')
    },
    password: async () => {
      return await prompt('\nEnter 2FA password: ')
    },
    invalidPasswordCallback: () => {
      console.log('Invalid password, please try again.')
    },
  })

  console.log('\n=== SUCCESS ===')
  console.log(
    `Logged in as: ${user.firstName}${user.lastName ? ` ${user.lastName}` : ''}`,
  )
  console.log(`Username: @${user.username || 'N/A'}`)
  console.log(`User ID: ${user.id}`)
} catch (error: unknown) {
  console.error('\n=== ERROR ===')
  const name = error instanceof Error ? error.name : 'UnknownError'
  const message = error instanceof Error ? error.message : String(error)
  console.error('Name:', name)
  console.error('Message:', message)

  if (message.includes('SESSION_PASSWORD_NEEDED')) {
    console.log('\n> 2FA is enabled - password required')
  }
}

process.exit(0)
