/**
 * Test QR login using client.start() with qrCodeHandler
 * This might handle 2FA better than signInQr
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
const SESSION_PATH = join(DATA_DIR, 'qr_start_session.db')

console.log('=== QR Login via client.start() ===')
console.log(`Session: ${SESSION_PATH}`)
console.log('')

const client = new TelegramClient({
  apiId: API_ID,
  apiHash: API_HASH,
  storage: SESSION_PATH,
  logLevel: 4,
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

console.log('Starting login flow with QR handler...')
console.log('Scan the QR code OR wait for phone prompt\n')

try {
  const user = await client.start({
    // Don't provide phone - this enables QR login mode
    qrCodeHandler: (url: string, expires: Date) => {
      console.log('\n--- QR Code Available ---')
      console.log('Scan with: Settings → Devices → Link Desktop Device\n')

      qrcode.generate(url, { small: true }, (qrText: string) => {
        console.log(qrText)
      })

      console.log(`Expires: ${expires.toLocaleTimeString()}`)
      console.log(
        'Waiting for scan (or press Enter to switch to phone login)...\n',
      )
    },
    phone: async () => {
      // Called if QR not scanned and phone needed
      console.log('\nQR not scanned. Switching to phone login...')
      return await prompt('Enter phone number: ')
    },
    code: async () => {
      return await prompt('Enter verification code: ')
    },
    password: async () => {
      return await prompt('Enter 2FA password: ')
    },
    invalidCodeCallback: async (type) => {
      console.log(`\nInvalid ${type}! Please try again.`)
    },
    codeSentCallback: async (sentCode) => {
      console.log('\nCode sent!')
      console.log('Type:', sentCode.type)
      console.log('Length:', sentCode.length, 'digits')
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
  const message = error instanceof Error ? error.message : String(error)
  console.error('Message:', message)

  if (message.includes('key is not registered')) {
    console.log('\n> Auth key issue - try again from fresh session')
  }
}

await new Promise((r) => setTimeout(r, 500))
process.exit(0)
