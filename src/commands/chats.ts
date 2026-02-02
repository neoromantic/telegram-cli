import { defineCommand } from 'citty'

import { getChatCommand } from './chats/get'
import { listChatsCommand } from './chats/list'
import { searchChatsCommand } from './chats/search'

/**
 * Chats subcommand group
 */
export const chatsCommand = defineCommand({
  meta: {
    name: 'chats',
    description: 'Chat and dialog management commands',
  },
  subCommands: {
    list: listChatsCommand,
    search: searchChatsCommand,
    get: getChatCommand,
  },
})

export { getChatCommand, listChatsCommand, searchChatsCommand }
