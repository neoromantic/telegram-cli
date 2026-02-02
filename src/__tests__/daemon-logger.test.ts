/**
 * Tests for daemon logger verbosity
 */
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { createLogger } from '../daemon/daemon-logger'

const originalConsole = {
  log: console.log,
  warn: console.warn,
  error: console.error,
}

function stubConsole() {
  const log = mock(() => {})
  const warn = mock(() => {})
  const error = mock(() => {})

  console.log = log as unknown as typeof console.log
  console.warn = warn as unknown as typeof console.warn
  console.error = error as unknown as typeof console.error

  return { log, warn, error }
}

afterEach(() => {
  console.log = originalConsole.log
  console.warn = originalConsole.warn
  console.error = originalConsole.error
})

describe('createLogger', () => {
  it('suppresses info/debug in quiet mode', () => {
    const { log, warn, error } = stubConsole()

    const logger = createLogger('quiet')
    logger.info('info')
    logger.debug('debug')
    logger.warn('warn')
    logger.error('error')

    expect(log).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalled()
    expect(error).toHaveBeenCalled()
  })

  it('logs info but not debug in normal mode', () => {
    const { log } = stubConsole()

    const logger = createLogger('normal')
    logger.info('info')
    logger.debug('debug')

    expect(log).toHaveBeenCalledTimes(1)
  })

  it('logs debug in verbose mode', () => {
    const { log } = stubConsole()

    const logger = createLogger('verbose')
    logger.debug('debug')

    expect(log).toHaveBeenCalledTimes(1)
  })
})
