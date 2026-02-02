import type { TelegramClient } from '@mtcute/bun'
import type { tl } from '@mtcute/tl'

import { normalizeUsername } from './identifiers'

type TelegramClientLike = Pick<TelegramClient, 'call'>

export async function resolveUsername(
  client: TelegramClientLike,
  identifier: string,
): Promise<tl.contacts.TypeResolvedPeer> {
  const username = normalizeUsername(identifier)
  const request: tl.contacts.RawResolveUsernameRequest = {
    _: 'contacts.resolveUsername',
    username,
  }
  return client.call(request)
}
