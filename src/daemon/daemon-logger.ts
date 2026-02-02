import type { DaemonLogger, DaemonVerbosity } from './types'

export function createLogger(verbosity: DaemonVerbosity): DaemonLogger {
  const shouldLog = {
    info: verbosity !== 'quiet',
    debug: verbosity === 'verbose',
    warn: true,
    error: true,
  }

  const timestamp = () => new Date().toISOString()

  return {
    info(message: string) {
      if (shouldLog.info) console.log(`[${timestamp()}] [INFO] ${message}`)
    },
    debug(message: string) {
      if (shouldLog.debug) console.log(`[${timestamp()}] [DEBUG] ${message}`)
    },
    warn(message: string) {
      if (shouldLog.warn) console.warn(`[${timestamp()}] [WARN] ${message}`)
    },
    error(message: string) {
      if (shouldLog.error) console.error(`[${timestamp()}] [ERROR] ${message}`)
    },
  }
}
