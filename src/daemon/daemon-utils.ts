import { DEFAULT_RECONNECT_CONFIG, type ReconnectConfig } from './types'

export function calculateReconnectDelay(
  attemptNumber: number,
  config: ReconnectConfig = DEFAULT_RECONNECT_CONFIG,
): number {
  const delay =
    config.initialDelayMs * config.backoffMultiplier ** (attemptNumber - 1)
  return Math.min(delay, config.maxDelayMs)
}

export function formatError(err: unknown): string {
  if (err instanceof Error) {
    return err.stack ?? err.message
  }
  if (typeof err === 'string') {
    return err
  }
  try {
    return JSON.stringify(err)
  } catch {
    return String(err)
  }
}

export function getErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message
  }
  if (typeof err === 'string') {
    return err
  }
  return String(err)
}
