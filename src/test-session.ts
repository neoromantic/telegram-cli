/**
 * Test that the saved session works
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { TelegramClient } from '@mtcute/bun'

const API_ID = parseInt(process.env.TELEGRAM_API_ID ?? '0', 10)
const API_HASH = process.env.TELEGRAM_API_HASH ?? ''

const SESSION_FILE = join(homedir(), '.telegram-cli', 'qr_session_v2.db')

console.log('Testing saved session...')

const client = new TelegramClient({
  apiId: API_ID,
  apiHash: API_HASH,
  storage: SESSION_FILE,
  logLevel: 2,
})

try {
  const me = await client.getMe()
  console.log('\n=== Session Valid ===')
  console.log(`User: ${me.firstName} ${me.lastName || ''}`.trim())
  console.log(`Username: @${me.username || 'N/A'}`)
  console.log(`User ID: ${me.id}`)

  // Test getting dialogs using iterDialogs
  console.log('\n=== Recent Chats ===')
  let count = 0
  for await (const dialog of client.iterDialogs({ limit: 5 })) {
    // Dialog has a 'peer' accessor that returns the Peer
    const peer = dialog.peer
    const title =
      (peer as any).title ||
      (peer as any).firstName ||
      (peer as any).displayName ||
      'Unknown'
    console.log(`- ${title}`)
    if (++count >= 5) break
  }

  // Test getting contacts via raw API
  console.log('\n=== Contacts (first 5) ===')
  const contactsResult = await client.call({
    _: 'contacts.getContacts',
    hash: 0n, // Use 0n for Long type
  } as any)

  if (contactsResult._ === 'contacts.contacts') {
    const users = contactsResult.users.slice(0, 5)
    for (const user of users) {
      if (user._ === 'user') {
        console.log(
          `- ${user.firstName || ''} ${user.lastName || ''} (@${user.username || 'no username'})`.trim(),
        )
      }
    }
  } else {
    console.log('Contacts not modified (cached)')
  }
} catch (error: any) {
  console.error('Error:', error.message)
}

process.exit(0)
