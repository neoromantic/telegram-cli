/**
 * Test script for QR code login - v2 with better debugging
 */
import { TelegramClient } from '@mtcute/bun'
import { join } from 'node:path'
import { homedir } from 'node:os'
import * as qrcode from 'qrcode-terminal'
import * as readline from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'

const API_ID = parseInt(process.env.TELEGRAM_API_ID ?? '0', 10)
const API_HASH = process.env.TELEGRAM_API_HASH ?? ''

if (!API_ID || !API_HASH) {
  console.error('Missing TELEGRAM_API_ID or TELEGRAM_API_HASH')
  process.exit(1)
}

const DATA_DIR = join(homedir(), '.telegram-cli')
const SESSION_PATH = join(DATA_DIR, 'qr_session_v2.db')

console.log('=== QR Code Login Test v2 ===')
console.log(`API ID: ${API_ID}`)
console.log(`Session: ${SESSION_PATH}`)
console.log('')

const client = new TelegramClient({
  apiId: API_ID,
  apiHash: API_HASH,
  storage: SESSION_PATH,
  logLevel: 4, // Debug level
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

// Store password so we can retry if needed
let storedPassword: string | null = null

console.log('Starting QR login flow...')
console.log('Scan the QR code with your Telegram mobile app:\n')

try {
  const user = await client.signInQr({
    onUrlUpdated: (url: string, expires: Date) => {
      console.log('\n--- New QR Code ---')
      console.log('URL:', url.substring(0, 50) + '...')
      console.log('Scan with: Settings → Devices → Link Desktop Device\n')

      // Generate QR code in terminal
      qrcode.generate(url, { small: true }, (qrText: string) => {
        console.log(qrText)
      })

      console.log(`Expires: ${expires.toLocaleTimeString()}`)
      console.log('Waiting for scan...\n')
    },
    onQrScanned: () => {
      console.log('\n✓ QR code scanned!')
      console.log('Completing authentication...\n')
    },
    password: async () => {
      // If we already have a password stored (retry case), use it
      if (storedPassword) {
        console.log('Retrying with stored password...')
        return storedPassword
      }

      console.log('\n2FA is enabled on this account.')
      const pwd = await prompt('Enter your 2FA password: ')
      storedPassword = pwd
      return pwd
    },
    invalidPasswordCallback: () => {
      console.log('\n✗ Invalid password! Please try again.')
      storedPassword = null // Clear for retry
    },
  })

  console.log('\n=== SUCCESS ===')
  console.log(`Logged in as: ${user.firstName}${user.lastName ? ' ' + user.lastName : ''}`)
  console.log(`Username: @${user.username || 'N/A'}`)
  console.log(`User ID: ${user.id}`)
  console.log(`\nSession saved to: ${SESSION_PATH}`)

} catch (error: any) {
  console.error('\n=== ERROR ===')
  console.error('Type:', error.constructor.name)
  console.error('Message:', error.message)

  if (error.code) {
    console.error('Code:', error.code)
  }

  // Check for specific errors
  if (error.message?.includes('SESSION_PASSWORD_NEEDED')) {
    console.log('\n> 2FA is enabled - the password prompt should have appeared')
  } else if (error.message?.includes('key is not registered')) {
    console.log('\n> Auth key issue - this can happen if:')
    console.log('  - The QR code expired before password entry')
    console.log('  - Network connectivity issue')
    console.log('  - Try scanning the QR code again more quickly')
  } else if (error.message?.includes('AUTH_TOKEN_EXPIRED')) {
    console.log('\n> QR code expired - please try again')
  }

  console.error('\nFull error:', error)
}

// Give time for any cleanup
await new Promise(r => setTimeout(r, 1000))
process.exit(0)
