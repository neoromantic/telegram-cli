import { defineCommand } from 'citty'

import { searchMessagesCommand } from './messages/search'

/**
 * Messages subcommand group
 */
export const messagesCommand = defineCommand({
  meta: {
    name: 'messages',
    description: 'Message search and history commands',
  },
  subCommands: {
    search: searchMessagesCommand,
  },
})

export { searchMessagesCommand }
