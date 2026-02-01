/**
 * Test script to verify auth code sending
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { TelegramClient } from '@mtcute/bun'

const API_ID = parseInt(process.env.TELEGRAM_API_ID ?? '0', 10)
const API_HASH = process.env.TELEGRAM_API_HASH ?? ''
const PHONE = process.argv[2] ?? '+79261408252'

if (!API_ID || !API_HASH) {
  console.error('Missing TELEGRAM_API_ID or TELEGRAM_API_HASH')
  process.exit(1)
}

const DATA_DIR = join(homedir(), '.telegram-cli')
const SESSION_PATH = join(DATA_DIR, 'test_session.db')

console.log('Creating client...')
console.log(`  API ID: ${API_ID}`)
console.log(`  Phone: ${PHONE}`)
console.log(`  Session: ${SESSION_PATH}`)

const client = new TelegramClient({
  apiId: API_ID,
  apiHash: API_HASH,
  storage: SESSION_PATH,
  logLevel: 5, // Verbose
})

console.log('\nSending code request...')

try {
  // Use raw API call to send code
  const result = await client.call({
    _: 'auth.sendCode',
    phoneNumber: PHONE.replace('+', ''),
    apiId: API_ID,
    apiHash: API_HASH,
    settings: { _: 'codeSettings' },
  } as any)

  console.log('\n=== CODE SENT SUCCESSFULLY ===')
  console.log('Result:', JSON.stringify(result, null, 2))
  console.log('\nCode type:', (result as any).type?._)
  console.log('Code length:', (result as any).type?.length)
  console.log('Phone code hash:', (result as any).phoneCodeHash)
  console.log('\nPlease check your Telegram app for the code!')
} catch (error) {
  console.error('\n=== ERROR ===')
  console.error(error)
}

process.exit(0)
