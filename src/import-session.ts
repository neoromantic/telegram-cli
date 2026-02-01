/**
 * Import the QR session into the main CLI account system
 */
import { TelegramClient } from '@mtcute/bun'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { copyFileSync, existsSync } from 'node:fs'
import { accountsDb } from './db'

const API_ID = parseInt(process.env.TELEGRAM_API_ID ?? '0', 10)
const API_HASH = process.env.TELEGRAM_API_HASH ?? ''

const DATA_DIR = join(homedir(), '.telegram-cli')
const QR_SESSION = join(DATA_DIR, 'qr_session_v2.db')

if (!existsSync(QR_SESSION)) {
  console.error('No QR session found. Run QR login first.')
  process.exit(1)
}

console.log('Importing QR session into CLI account system...')

// Get user info from QR session
const client = new TelegramClient({
  apiId: API_ID,
  apiHash: API_HASH,
  storage: QR_SESSION,
  logLevel: 2,
})

try {
  const me = await client.getMe()
  console.log(`Found user: ${me.firstName} (@${me.username})`)

  // Create account in database
  const phone = `user:${me.id}` // Use user ID since QR login doesn't expose phone

  // Check if account already exists
  let account = accountsDb.getByPhone(phone)
  if (account) {
    console.log(`Account already exists (ID: ${account.id})`)
  } else {
    account = accountsDb.create({
      phone,
      name: `${me.firstName}${me.lastName ? ' ' + me.lastName : ''}`,
      is_active: true,
    })
    console.log(`Created account ID: ${account.id}`)
  }

  // Copy QR session to account session path
  const accountSession = join(DATA_DIR, `session_${account.id}.db`)
  copyFileSync(QR_SESSION, accountSession)

  // Also copy WAL files if they exist
  if (existsSync(QR_SESSION + '-wal')) {
    copyFileSync(QR_SESSION + '-wal', accountSession + '-wal')
  }
  if (existsSync(QR_SESSION + '-shm')) {
    copyFileSync(QR_SESSION + '-shm', accountSession + '-shm')
  }

  console.log(`Session copied to: ${accountSession}`)

  // Verify the copied session works
  const verifyClient = new TelegramClient({
    apiId: API_ID,
    apiHash: API_HASH,
    storage: accountSession,
    logLevel: 2,
  })

  const verifyMe = await verifyClient.getMe()
  console.log(`\nVerified! Account ready: ${verifyMe.firstName} (@${verifyMe.username})`)
  console.log('\nYou can now use:')
  console.log('  tg auth status')
  console.log('  tg contacts list')
  console.log('  tg api <method>')

} catch (error: any) {
  console.error('Error:', error.message)
  process.exit(1)
}

process.exit(0)
