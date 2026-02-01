/**
 * Messages cache service
 * Provides typed access to the messages_cache table
 */
import type { Database } from 'bun:sqlite'
import { MessageCacheRow } from './sync-schema'

/**
 * Input for inserting/updating a message
 */
export interface MessageInput {
  chat_id: number
  message_id: number
  from_id?: number | null
  reply_to_id?: number | null
  forward_from_id?: number | null
  text?: string | null
  message_type: string
  has_media?: boolean
  media_path?: string | null
  is_outgoing?: boolean
  is_edited?: boolean
  is_pinned?: boolean
  is_deleted?: boolean
  edit_date?: number | null
  date: number
  raw_json: string
}

/**
 * Options for listing messages
 */
export interface ListMessagesOptions {
  limit: number
  offset?: number
  includeDeleted?: boolean
}

/**
 * Messages cache service interface
 */
export interface MessagesCache {
  /** Insert or update a message */
  upsert(message: MessageInput): void
  /** Insert or update multiple messages in a transaction */
  upsertBatch(messages: MessageInput[]): void
  /** Get a message by chat_id and message_id */
  get(chatId: number, messageId: number): MessageCacheRow | null
  /** List messages for a chat in reverse chronological order */
  listByChatId(chatId: number, options: ListMessagesOptions): MessageCacheRow[]
  /** Mark messages as deleted */
  markDeleted(chatId: number, messageIds: number[]): void
  /** Update message text (for edits) */
  updateText(
    chatId: number,
    messageId: number,
    newText: string,
    editDate: number,
  ): void
  /** Get the latest message ID for a chat */
  getLatestMessageId(chatId: number): number | null
  /** Get the oldest message ID for a chat */
  getOldestMessageId(chatId: number): number | null
  /** Count messages in a chat */
  countByChatId(chatId: number, includeDeleted?: boolean): number
}

/**
 * Create a messages cache service
 */
export function createMessagesCache(db: Database): MessagesCache {
  // Prepare statements for performance
  const stmts = {
    upsert: db.prepare(`
      INSERT OR REPLACE INTO messages_cache (
        chat_id, message_id, from_id, reply_to_id, forward_from_id,
        text, message_type, has_media, media_path,
        is_outgoing, is_edited, is_pinned, is_deleted, edit_date,
        date, fetched_at, raw_json, updated_at
      ) VALUES (
        $chat_id, $message_id, $from_id, $reply_to_id, $forward_from_id,
        $text, $message_type, $has_media, $media_path,
        $is_outgoing, $is_edited, $is_pinned, $is_deleted, $edit_date,
        $date, $fetched_at, $raw_json, $updated_at
      )
    `),

    get: db
      .query(`
      SELECT * FROM messages_cache
      WHERE chat_id = $chat_id AND message_id = $message_id
    `)
      .as(MessageCacheRow),

    listByChatId: db
      .query(`
      SELECT * FROM messages_cache
      WHERE chat_id = $chat_id AND is_deleted = 0
      ORDER BY date DESC
      LIMIT $limit OFFSET $offset
    `)
      .as(MessageCacheRow),

    listByChatIdIncludeDeleted: db
      .query(`
      SELECT * FROM messages_cache
      WHERE chat_id = $chat_id
      ORDER BY date DESC
      LIMIT $limit OFFSET $offset
    `)
      .as(MessageCacheRow),

    markDeleted: db.prepare(`
      UPDATE messages_cache
      SET is_deleted = 1, updated_at = $now
      WHERE chat_id = $chat_id AND message_id = $message_id
    `),

    updateText: db.prepare(`
      UPDATE messages_cache
      SET text = $text, is_edited = 1, edit_date = $edit_date, updated_at = $now
      WHERE chat_id = $chat_id AND message_id = $message_id
    `),

    getLatestMessageId: db.query(`
      SELECT MAX(message_id) as max_id FROM messages_cache
      WHERE chat_id = $chat_id
    `),

    getOldestMessageId: db.query(`
      SELECT MIN(message_id) as min_id FROM messages_cache
      WHERE chat_id = $chat_id
    `),

    countByChatId: db.query(`
      SELECT COUNT(*) as count FROM messages_cache
      WHERE chat_id = $chat_id AND is_deleted = 0
    `),

    countByChatIdAll: db.query(`
      SELECT COUNT(*) as count FROM messages_cache
      WHERE chat_id = $chat_id
    `),
  }

  return {
    upsert(message: MessageInput): void {
      const now = Date.now()
      stmts.upsert.run({
        $chat_id: message.chat_id,
        $message_id: message.message_id,
        $from_id: message.from_id ?? null,
        $reply_to_id: message.reply_to_id ?? null,
        $forward_from_id: message.forward_from_id ?? null,
        $text: message.text ?? null,
        $message_type: message.message_type,
        $has_media: message.has_media ? 1 : 0,
        $media_path: message.media_path ?? null,
        $is_outgoing: message.is_outgoing ? 1 : 0,
        $is_edited: message.is_edited ? 1 : 0,
        $is_pinned: message.is_pinned ? 1 : 0,
        $is_deleted: message.is_deleted ? 1 : 0,
        $edit_date: message.edit_date ?? null,
        $date: message.date,
        $fetched_at: now,
        $raw_json: message.raw_json,
        $updated_at: now,
      })
    },

    upsertBatch(messages: MessageInput[]): void {
      const transaction = db.transaction(() => {
        for (const msg of messages) {
          this.upsert(msg)
        }
      })
      transaction()
    },

    get(chatId: number, messageId: number): MessageCacheRow | null {
      return stmts.get.get({ $chat_id: chatId, $message_id: messageId }) ?? null
    },

    listByChatId(
      chatId: number,
      options: ListMessagesOptions,
    ): MessageCacheRow[] {
      const params = {
        $chat_id: chatId,
        $limit: options.limit,
        $offset: options.offset ?? 0,
      }

      if (options.includeDeleted) {
        return stmts.listByChatIdIncludeDeleted.all(params)
      }
      return stmts.listByChatId.all(params)
    },

    markDeleted(chatId: number, messageIds: number[]): void {
      const now = Date.now()
      const transaction = db.transaction(() => {
        for (const messageId of messageIds) {
          stmts.markDeleted.run({
            $chat_id: chatId,
            $message_id: messageId,
            $now: now,
          })
        }
      })
      transaction()
    },

    updateText(
      chatId: number,
      messageId: number,
      newText: string,
      editDate: number,
    ): void {
      stmts.updateText.run({
        $chat_id: chatId,
        $message_id: messageId,
        $text: newText,
        $edit_date: editDate,
        $now: Date.now(),
      })
    },

    getLatestMessageId(chatId: number): number | null {
      const result = stmts.getLatestMessageId.get({ $chat_id: chatId }) as {
        max_id: number | null
      } | null
      return result?.max_id ?? null
    },

    getOldestMessageId(chatId: number): number | null {
      const result = stmts.getOldestMessageId.get({ $chat_id: chatId }) as {
        min_id: number | null
      } | null
      return result?.min_id ?? null
    },

    countByChatId(chatId: number, includeDeleted = false): number {
      const stmt = includeDeleted ? stmts.countByChatIdAll : stmts.countByChatId
      const result = stmt.get({ $chat_id: chatId }) as { count: number } | null
      return result?.count ?? 0
    },
  }
}
