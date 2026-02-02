/**
 * Clean QR login test with explicit SqliteStorage
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { stdin as input, stdout as output } from 'node:process'
import * as readline from 'node:readline/promises'
import { SqliteStorage, TelegramClient } from '@mtcute/bun'
import * as qrcode from 'qrcode-terminal'

const API_ID = parseInt(process.env.TELEGRAM_API_ID ?? '0', 10)
const API_HASH = process.env.TELEGRAM_API_HASH ?? ''

if (!API_ID || !API_HASH) {
  console.error('Missing TELEGRAM_API_ID or TELEGRAM_API_HASH')
  process.exit(1)
}

const SESSION_FILE = join(homedir(), '.telegram-cli', 'clean_session.db')

console.log('=== Clean QR Login Test ===')
console.log(`Using SqliteStorage: ${SESSION_FILE}`)
console.log('')

// Explicitly create SqliteStorage
const storage = new SqliteStorage(SESSION_FILE)

const client = new TelegramClient({
  apiId: API_ID,
  apiHash: API_HASH,
  storage: storage,
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

console.log('Starting QR login...')
console.log(
  'Scan with Telegram app: Settings → Devices → Link Desktop Device\n',
)

try {
  const user = await client.signInQr({
    onUrlUpdated: (url: string, expires: Date) => {
      qrcode.generate(url, { small: true })
      console.log(`\nExpires: ${expires.toLocaleTimeString()}`)
      console.log('Waiting for scan...\n')
    },
    onQrScanned: () => {
      console.log('✓ Scanned! Completing auth...\n')
    },
    password: async () => {
      return await prompt('Enter 2FA password: ')
    },
    invalidPasswordCallback: () => {
      console.log('Wrong password, try again.')
    },
  })

  console.log('\n=== SUCCESS ===')
  console.log(`User: ${user.firstName} (@${user.username || 'no username'})`)
  console.log(`ID: ${user.id}`)

  // Verify session was saved
  console.log('\nVerifying session...')
  const me = await client.getMe()
  console.log(`Session works! Logged in as: ${me.firstName}`)
} catch (error: unknown) {
  console.error('\n=== ERROR ===')
  const message = error instanceof Error ? error.message : String(error)
  console.error(message)

  if (message.includes('key is not registered')) {
    console.log(
      '\nThis error means the auth key was lost between QR scan and 2FA.',
    )
    console.log('This might be a timing issue or mtcute bug with QR+2FA.')
  }
}

process.exit(0)
