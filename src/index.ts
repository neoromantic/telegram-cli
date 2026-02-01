#!/usr/bin/env bun
/**
 * Telegram CLI - Main Entry Point
 *
 * A comprehensive Telegram CLI client for agent-friendly automation.
 */
import { defineCommand, runMain } from 'citty'
import { accountsCommand } from './commands/accounts'
import { apiCommand } from './commands/api'
import { authCommand } from './commands/auth'
import { chatsCommand } from './commands/chats'
import { contactsCommand } from './commands/contacts'
import { daemonCommand } from './commands/daemon'
import { sendCommand } from './commands/send'
import { sqlCommand } from './commands/sql'
import { statusCommand } from './commands/status'
import { meCommand, userCommand } from './commands/user'
import type { OutputFormat } from './types'
import { setOutputFormat } from './utils/output'

const main = defineCommand({
  meta: {
    name: 'tg',
    version: '0.1.0',
    description: 'Telegram CLI - Agent-friendly Telegram client',
  },
  args: {
    format: {
      type: 'string',
      alias: 'f',
      description: 'Output format: json, pretty, or quiet',
      default: 'json',
    },
    verbose: {
      type: 'boolean',
      alias: 'v',
      description: 'Enable verbose output',
      default: false,
    },
  },
  setup({ args }) {
    // Set output format
    const format = args.format as OutputFormat
    if (format === 'json' || format === 'pretty' || format === 'quiet') {
      setOutputFormat(format)
    }

    // Set verbose flag
    if (args.verbose) {
      process.env.VERBOSE = '1'
    }
  },
  subCommands: {
    auth: authCommand,
    accounts: accountsCommand,
    contacts: contactsCommand,
    chats: chatsCommand,
    send: sendCommand,
    daemon: daemonCommand,
    api: apiCommand,
    me: meCommand,
    user: userCommand,
    status: statusCommand,
    sql: sqlCommand,
  },
})

runMain(main)
