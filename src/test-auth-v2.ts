/**
 * Test script v2 - Try different phone formats and inspect responses closely
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { TelegramClient } from '@mtcute/bun'

const API_ID = parseInt(process.env.TELEGRAM_API_ID ?? '0', 10)
const API_HASH = process.env.TELEGRAM_API_HASH ?? ''

// Try WITH the + sign this time
const PHONE = '+79261408252'

if (!API_ID || !API_HASH) {
  console.error('Missing TELEGRAM_API_ID or TELEGRAM_API_HASH')
  process.exit(1)
}

const DATA_DIR = join(homedir(), '.telegram-cli')
const SESSION_PATH = join(DATA_DIR, 'test_session_v2.db')

console.log('=== Test Auth v2 ===')
console.log(`API ID: ${API_ID}`)
console.log(`Phone (with +): ${PHONE}`)
console.log(`Session: ${SESSION_PATH}`)
console.log('')

const client = new TelegramClient({
  apiId: API_ID,
  apiHash: API_HASH,
  storage: SESSION_PATH,
  logLevel: 3, // Info level - less verbose
})

console.log('Sending code request with FULL international format...')

try {
  // Try the high-level sendCode method from mtcute
  const result = await client.sendCode({ phone: PHONE })

  console.log('\n=== RESPONSE ===')
  console.log('Type:', result)
  console.log(
    JSON.stringify(
      result,
      (_key, value) => (typeof value === 'bigint' ? value.toString() : value),
      2,
    ),
  )
} catch (error: unknown) {
  console.error('\n=== ERROR ===')
  const name = error instanceof Error ? error.name : 'UnknownError'
  const message = error instanceof Error ? error.message : String(error)
  const code =
    error && typeof error === 'object' && 'code' in error
      ? (error as { code?: unknown }).code
      : undefined
  console.error('Name:', name)
  console.error('Message:', message)
  console.error('Code:', code)

  if (message.includes('PHONE_NUMBER_INVALID')) {
    console.log('\n> Phone number format issue')
  }
  if (message.includes('FLOOD_WAIT')) {
    console.log('\n> Rate limited - wait before trying again')
  }
  if (message.includes('SESSION_PASSWORD_NEEDED')) {
    console.log('\n> 2FA is enabled - password required')
  }
}

// Keep process alive briefly to see any delayed messages
await new Promise((r) => setTimeout(r, 2000))
process.exit(0)
