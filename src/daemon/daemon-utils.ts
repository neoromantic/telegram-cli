import { DEFAULT_RECONNECT_CONFIG, type ReconnectConfig } from './types'

export function calculateReconnectDelay(
  attemptNumber: number,
  config: ReconnectConfig = DEFAULT_RECONNECT_CONFIG,
): number {
  const delay =
    config.initialDelayMs * config.backoffMultiplier ** (attemptNumber - 1)
  return Math.min(delay, config.maxDelayMs)
}
