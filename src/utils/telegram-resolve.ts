import { normalizeUsername } from './identifiers'

export async function resolveUsername(
  client: any,
  identifier: string,
): Promise<any> {
  const username = normalizeUsername(identifier)
  return client.call({
    _: 'contacts.resolveUsername',
    username,
  } as any)
}
