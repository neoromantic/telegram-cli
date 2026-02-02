import { join } from 'node:path'
import { type DeleteMessageUpdate, TelegramClient } from '@mtcute/bun'
import { getCacheDb } from '../db'
import { createChatSyncStateService } from '../db/chat-sync-state'
import { createMessagesCache } from '../db/messages-cache'
import { getDefaultConfig, validateConfig } from '../services/telegram'
import type { DaemonContext } from './daemon-context'
import {
  calculateReconnectDelay,
  formatError,
  getErrorMessage,
} from './daemon-utils'
import {
  createUpdateHandlers,
  type NewMessageData,
  type UpdateContext,
} from './handlers'
import type { AccountConnectionState, AccountEventHandlers } from './types'

export async function closeClientSafe(
  ctx: DaemonContext,
  client: TelegramClient,
  reason: string,
): Promise<void> {
  const closeFn = (client as unknown as { close?: () => Promise<void> }).close
  if (!closeFn) return
  try {
    await closeFn.call(client)
    ctx.logger.debug(`Closed client (${reason})`)
  } catch (err) {
    ctx.logger.warn(`Failed to close client (${reason}): ${formatError(err)}`)
  }
}

export function setupSignalHandlers(ctx: DaemonContext): void {
  if (ctx.runtime.signalHandlersSetup) return
  ctx.runtime.signalHandlersSetup = true

  const handleShutdown = (signal: string) => {
    ctx.logger.info(`Received ${signal}, initiating graceful shutdown...`)
    ctx.state.shutdownRequested = true
  }

  process.on('SIGTERM', () => handleShutdown('SIGTERM'))
  process.on('SIGINT', () => handleShutdown('SIGINT'))
}

export function setupEventHandlers(
  ctx: DaemonContext,
  accountState: AccountConnectionState,
): void {
  const { client, accountId } = accountState
  if (!client) {
    ctx.logger.warn(`Cannot setup handlers: no client for account ${accountId}`)
    return
  }

  const cacheDb = getCacheDb()
  const messagesCache = createMessagesCache(cacheDb)
  const chatSyncState = createChatSyncStateService(cacheDb)

  const updateHandlers = createUpdateHandlers({
    db: cacheDb,
    messagesCache,
    chatSyncState,
  })

  const createContext = (): UpdateContext => ({
    accountId,
    receivedAt: Date.now(),
  })

  const eventHandlers: AccountEventHandlers = {
    onNewMessage: (msg) => {
      const ctxLocal = createContext()
      const data: NewMessageData = {
        chatId: msg.chat.id,
        messageId: msg.id,
        fromId: msg.sender?.id,
        text: msg.text,
        date: msg.date.getTime() / 1000,
        isOutgoing: msg.isOutgoing,
        replyToId: msg.replyToMessage?.id ?? undefined,
        messageType: msg.media ? 'media' : 'text',
        hasMedia: !!msg.media,
      }

      updateHandlers.handleNewMessage(ctxLocal, data).catch((err) => {
        ctx.logger.error(`Error handling new message: ${formatError(err)}`)
      })

      accountState.lastActivity = Date.now()
      ctx.logger.debug(
        `[Account ${accountId}] New message in chat ${data.chatId}`,
      )
    },

    onEditMessage: (msg) => {
      const ctxLocal = createContext()
      updateHandlers
        .handleEditMessage(ctxLocal, {
          chatId: msg.chat.id,
          messageId: msg.id,
          newText: msg.text,
          editDate: msg.editDate?.getTime()
            ? msg.editDate.getTime() / 1000
            : Date.now() / 1000,
        })
        .catch((err) => {
          ctx.logger.error(`Error handling message edit: ${formatError(err)}`)
        })

      accountState.lastActivity = Date.now()
      ctx.logger.debug(
        `[Account ${accountId}] Message edited in chat ${msg.chat.id}`,
      )
    },

    onDeleteMessage: (update: DeleteMessageUpdate) => {
      const chatId = update.channelId
      if (chatId === null) {
        const ctxLocal = createContext()
        updateHandlers
          .handleDeleteMessagesWithoutChat(ctxLocal, {
            messageIds: update.messageIds,
          })
          .then((deletedCount) => {
            ctx.logger.debug(
              `[Account ${accountId}] Deleted ${deletedCount} message(s) without chat context`,
            )
          })
          .catch((err) => {
            ctx.logger.error(
              `Error handling message deletion: ${formatError(err)}`,
            )
          })

        accountState.lastActivity = Date.now()
        return
      }

      const ctxLocal = createContext()
      updateHandlers
        .handleDeleteMessages(ctxLocal, {
          chatId,
          messageIds: update.messageIds,
        })
        .catch((err) => {
          ctx.logger.error(
            `Error handling message deletion: ${formatError(err)}`,
          )
        })

      accountState.lastActivity = Date.now()
      ctx.logger.debug(
        `[Account ${accountId}] Messages deleted in chat ${chatId}`,
      )
    },
  }

  client.onNewMessage.add(eventHandlers.onNewMessage)
  client.onEditMessage.add(eventHandlers.onEditMessage)
  client.onDeleteMessage.add(eventHandlers.onDeleteMessage)

  accountState.updateHandlers = updateHandlers
  accountState.eventHandlers = eventHandlers

  ctx.logger.debug(`[Account ${accountId}] Event handlers registered`)
}

export function removeEventHandlers(
  ctx: DaemonContext,
  accountState: AccountConnectionState,
): void {
  const { client, eventHandlers, accountId } = accountState

  if (!client || !eventHandlers) {
    return
  }

  client.onNewMessage.remove(eventHandlers.onNewMessage)
  client.onEditMessage.remove(eventHandlers.onEditMessage)
  client.onDeleteMessage.remove(eventHandlers.onDeleteMessage)

  accountState.eventHandlers = undefined
  accountState.updateHandlers = undefined

  ctx.logger.debug(`[Account ${accountId}] Event handlers removed`)
}

export async function connectAccount(
  ctx: DaemonContext,
  accountId: number,
  phone: string,
  name: string | null,
): Promise<boolean> {
  const accountState: AccountConnectionState = {
    accountId,
    phone,
    name,
    status: 'connecting',
  }
  ctx.state.accounts.set(accountId, accountState)

  try {
    const telegramConfig = getDefaultConfig()
    const validation = validateConfig(telegramConfig)
    if (!validation.valid) {
      throw new Error(validation.error)
    }

    const sessionPath = join(ctx.dataDir, `session_${accountId}.db`)
    ctx.logger.debug(`Connecting account ${phone} (session: ${sessionPath})`)

    const client = new TelegramClient({
      apiId: telegramConfig.apiId,
      apiHash: telegramConfig.apiHash,
      storage: sessionPath,
      logLevel: ctx.verbosity === 'verbose' ? 5 : 2,
    })

    await client.start({
      phone: async () => {
        throw new Error('Interactive login not supported in daemon mode')
      },
      code: async () => {
        throw new Error('Interactive login not supported in daemon mode')
      },
      password: async () => {
        throw new Error('Interactive login not supported in daemon mode')
      },
    })

    const me = await client.getMe()
    ctx.logger.info(
      `Connected account ${phone} (${me.firstName ?? ''} ${me.lastName ?? ''})`.trim(),
    )

    const existingByUserId = ctx.accountsDb.getByUserId(me.id)
    if (existingByUserId && existingByUserId.id !== accountId) {
      const currentAccount = ctx.accountsDb.getById(accountId)
      const currentHasRealPhone =
        currentAccount && !currentAccount.phone.startsWith('user:')
      const existingHasRealPhone = !existingByUserId.phone.startsWith('user:')

      if (currentHasRealPhone && !existingHasRealPhone) {
        ctx.logger.info(
          `Merging duplicate account: keeping #${accountId} (${phone}), removing #${existingByUserId.id} (${existingByUserId.phone})`,
        )
        ctx.accountsDb.delete(existingByUserId.id)
        ctx.accountsDb.update(accountId, { user_id: me.id })
      } else {
        ctx.logger.info(
          `Merging duplicate account: keeping #${existingByUserId.id} (${existingByUserId.phone}), removing #${accountId} (${phone})`,
        )
        ctx.accountsDb.setActive(existingByUserId.id)
        ctx.accountsDb.delete(accountId)

        ctx.state.accounts.delete(accountId)
        await closeClientSafe(ctx, client, 'duplicate account merged')
        return false
      }
    } else if (!existingByUserId) {
      const currentAccount = ctx.accountsDb.getById(accountId)
      if (currentAccount && currentAccount.user_id === null) {
        ctx.accountsDb.update(accountId, { user_id: me.id })
        ctx.logger.debug(`Updated user_id for account #${accountId}: ${me.id}`)
      }
    }

    accountState.client = client
    accountState.status = 'connected'
    accountState.lastActivity = Date.now()

    setupEventHandlers(ctx, accountState)

    ctx.logger.debug(`[Account ${accountId}] Starting updates...`)
    await client.startUpdatesLoop()
    ctx.logger.info(`[Account ${accountId}] Real-time updates active`)

    return true
  } catch (err) {
    const errorMessage = getErrorMessage(err)
    ctx.logger.error(`Failed to connect account ${phone}: ${formatError(err)}`)

    accountState.status = 'error'
    accountState.lastError = errorMessage

    return false
  }
}

export function scheduleReconnect(
  ctx: DaemonContext,
  accountState: AccountConnectionState,
): void {
  const attempts = (accountState.reconnectAttempts ?? 0) + 1
  accountState.reconnectAttempts = attempts

  if (attempts > ctx.reconnectConfig.maxAttempts) {
    ctx.logger.error(
      `Account ${accountState.phone} exceeded max reconnection attempts (${ctx.reconnectConfig.maxAttempts}). Giving up.`,
    )
    return
  }

  const delay = calculateReconnectDelay(attempts, ctx.reconnectConfig)
  accountState.nextReconnectAt = Date.now() + delay

  ctx.logger.info(
    `Scheduling reconnection for ${accountState.phone} in ${Math.round(delay / 1000)}s (attempt ${attempts}/${ctx.reconnectConfig.maxAttempts})`,
  )
}

export async function attemptReconnect(
  ctx: DaemonContext,
  accountState: AccountConnectionState,
): Promise<boolean> {
  ctx.logger.info(
    `Attempting reconnection for ${accountState.phone} (attempt ${accountState.reconnectAttempts}/${ctx.reconnectConfig.maxAttempts})`,
  )

  accountState.status = 'reconnecting'
  accountState.nextReconnectAt = undefined

  if (accountState.client) {
    accountState.client = undefined
  }

  try {
    const telegramConfig = getDefaultConfig()
    const validation = validateConfig(telegramConfig)
    if (!validation.valid) {
      throw new Error(validation.error)
    }

    const sessionPath = join(
      ctx.dataDir,
      `session_${accountState.accountId}.db`,
    )
    ctx.logger.debug(
      `Reconnecting account ${accountState.phone} (session: ${sessionPath})`,
    )

    const client = new TelegramClient({
      apiId: telegramConfig.apiId,
      apiHash: telegramConfig.apiHash,
      storage: sessionPath,
      logLevel: ctx.verbosity === 'verbose' ? 5 : 2,
    })

    await client.start({
      phone: async () => {
        throw new Error('Interactive login not supported in daemon mode')
      },
      code: async () => {
        throw new Error('Interactive login not supported in daemon mode')
      },
      password: async () => {
        throw new Error('Interactive login not supported in daemon mode')
      },
    })

    const me = await client.getMe()
    ctx.logger.info(
      `Reconnected account ${accountState.phone} (${me.firstName ?? ''} ${me.lastName ?? ''})`.trim(),
    )

    accountState.client = client
    accountState.status = 'connected'
    accountState.lastActivity = Date.now()
    accountState.reconnectAttempts = 0
    accountState.lastError = undefined

    return true
  } catch (err) {
    const errorMessage = getErrorMessage(err)
    ctx.logger.error(
      `Reconnection failed for ${accountState.phone}: ${formatError(err)}`,
    )

    accountState.status = 'error'
    accountState.lastError = errorMessage

    scheduleReconnect(ctx, accountState)

    return false
  }
}

export async function disconnectAllAccounts(ctx: DaemonContext): Promise<void> {
  ctx.logger.debug('Disconnecting all accounts...')

  for (const [, accountState] of ctx.state.accounts) {
    if (accountState.eventHandlers) {
      try {
        removeEventHandlers(ctx, accountState)
      } catch (err) {
        ctx.logger.warn(
          `Error removing event handlers for ${accountState.phone}: ${formatError(err)}`,
        )
      }
    }

    if (accountState.client) {
      try {
        ctx.logger.debug(`Disconnected account ${accountState.phone}`)
      } catch (err) {
        ctx.logger.warn(
          `Error disconnecting account ${accountState.phone}: ${formatError(err)}`,
        )
      }
    }
    accountState.status = 'disconnected'
    accountState.client = undefined
  }
}
