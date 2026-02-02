/**
 * Test script to resend code via SMS
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { TelegramClient } from '@mtcute/bun'
import type { tl } from '@mtcute/tl'

const API_ID = parseInt(process.env.TELEGRAM_API_ID ?? '0', 10)
const API_HASH = process.env.TELEGRAM_API_HASH ?? ''
const PHONE = '+79261408252'
const PHONE_CODE_HASH = process.argv[2] // Pass the hash from previous sendCode

if (!API_ID || !API_HASH) {
  console.error('Missing TELEGRAM_API_ID or TELEGRAM_API_HASH')
  process.exit(1)
}

if (!PHONE_CODE_HASH) {
  console.error('Usage: bun run src/test-resend.ts <phoneCodeHash>')
  console.error('Get the hash from the previous sendCode response')
  process.exit(1)
}

const DATA_DIR = join(homedir(), '.telegram-cli')
const SESSION_PATH = join(DATA_DIR, 'test_session.db')

console.log('Creating client...')
const client = new TelegramClient({
  apiId: API_ID,
  apiHash: API_HASH,
  storage: SESSION_PATH,
  logLevel: 5,
})

console.log('\nResending code via alternative method (SMS)...')
console.log(`Phone: ${PHONE}`)
console.log(`Hash: ${PHONE_CODE_HASH}`)

try {
  // Use raw API call to resend code
  const request: tl.auth.RawResendCodeRequest = {
    _: 'auth.resendCode',
    phoneNumber: PHONE.replace('+', ''),
    phoneCodeHash: PHONE_CODE_HASH,
  }
  const result = await client.call(request)

  console.log('\n=== CODE RESENT ===')
  console.log('Result:', JSON.stringify(result, null, 2))
  if (result._ === 'auth.sentCode') {
    console.log('\nNew code type:', result.type?._)
    if (result.type && 'length' in result.type) {
      console.log('Code length:', result.type.length)
    } else {
      console.log('Code length: n/a')
    }
  } else if (result._ === 'auth.sentCodePaymentRequired') {
    console.log('\nPayment required for resend.')
  } else if (result._ === 'auth.sentCodeSuccess') {
    console.log('\nAuthorized via future auth tokens.')
  }
  console.log('\nPlease check your phone for SMS!')
} catch (error: unknown) {
  console.error('\n=== ERROR ===')
  const message = error instanceof Error ? error.message : String(error)
  console.error('Error message:', message)
  if (message.includes('PHONE_CODE_EXPIRED')) {
    console.log(
      '\nThe previous code expired. Please run test-auth.ts again to get a new code.',
    )
  }
}

process.exit(0)
