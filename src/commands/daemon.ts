/**
 * Daemon command - manage background sync daemon
 *
 * Usage:
 *   tg daemon start [--verbose|--quiet]  Start daemon in foreground
 *   tg daemon stop                       Stop running daemon
 *   tg daemon status                     Show daemon status
 */
import { defineCommand } from 'citty'
import { join } from 'node:path'
import {
  DaemonExitCode,
  createDaemon,
  createPidFile,
  type DaemonConfig,
} from '../daemon'
import { getCacheDb, getDataDir } from '../db'
import { createDaemonStatusService } from '../db/daemon-status'
import { ErrorCodes } from '../types'
import { error, success } from '../utils/output'

/**
 * Format duration in human-readable form
 */
function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)

  if (days > 0) {
    return `${days}d ${hours % 24}h ${minutes % 60}m`
  }
  if (hours > 0) {
    return `${hours}h ${minutes % 60}m ${seconds % 60}s`
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`
  }
  return `${seconds}s`
}

/**
 * Start subcommand - starts daemon in foreground
 */
const startCommand = defineCommand({
  meta: {
    name: 'start',
    description: 'Start the daemon in foreground',
  },
  args: {
    verbose: {
      type: 'boolean',
      description: 'Enable verbose logging',
      alias: 'v',
      default: false,
    },
    quiet: {
      type: 'boolean',
      description: 'Minimal output (errors only)',
      alias: 'q',
      default: false,
    },
  },
  async run({ args }) {
    const verbosity = args.quiet
      ? 'quiet'
      : args.verbose
        ? 'verbose'
        : 'normal'

    const config: Partial<DaemonConfig> = {
      verbosity,
    }

    const daemon = createDaemon(config)
    const exitCode = await daemon.start()

    process.exit(exitCode)
  },
})

/**
 * Stop subcommand - sends SIGTERM to running daemon
 */
const stopCommand = defineCommand({
  meta: {
    name: 'stop',
    description: 'Stop the running daemon',
  },
  args: {
    timeout: {
      type: 'string',
      description: 'Timeout in seconds to wait for graceful shutdown',
      default: '10',
    },
    force: {
      type: 'boolean',
      description: 'Force kill if graceful shutdown fails',
      alias: 'f',
      default: false,
    },
  },
  async run({ args }) {
    const dataDir = getDataDir()
    const pidPath = join(dataDir, 'daemon.pid')
    const pidFile = createPidFile(pidPath)

    const pid = pidFile.read()
    if (pid === null) {
      return error(ErrorCodes.DAEMON_NOT_RUNNING, 'Daemon is not running')
    }

    const timeoutMs = parseInt(args.timeout, 10) * 1000

    // Send SIGTERM
    console.log(`Stopping daemon (PID ${pid})...`)
    if (!pidFile.sendSignal('SIGTERM')) {
      return error(
        ErrorCodes.DAEMON_SIGNAL_FAILED,
        'Failed to send stop signal to daemon',
      )
    }

    // Wait for process to exit
    const startTime = Date.now()
    while (Date.now() - startTime < timeoutMs) {
      if (!pidFile.isRunning()) {
        return success({ message: 'Daemon stopped successfully' })
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }

    // Graceful shutdown timed out
    if (args.force) {
      console.log('Graceful shutdown timed out, forcing kill...')
      if (pidFile.sendSignal('SIGKILL')) {
        // Wait a moment for the process to die
        await new Promise((resolve) => setTimeout(resolve, 500))
        if (!pidFile.isRunning()) {
          return success({ message: 'Daemon forcefully stopped' })
        }
      }
      return error(
        ErrorCodes.DAEMON_FORCE_KILL_FAILED,
        'Failed to forcefully stop daemon',
      )
    }
    return error(
      ErrorCodes.DAEMON_SHUTDOWN_TIMEOUT,
      `Daemon did not stop within ${args.timeout} seconds. Use --force to forcefully kill.`,
    )
  },
})

/**
 * Status subcommand - shows daemon status
 */
const statusCommand = defineCommand({
  meta: {
    name: 'status',
    description: 'Show daemon status',
  },
  args: {},
  async run() {
    const dataDir = getDataDir()
    const pidPath = join(dataDir, 'daemon.pid')
    const pidFile = createPidFile(pidPath)

    const pid = pidFile.read()

    if (pid === null) {
      success({
        status: 'stopped',
        pid: null,
        message: 'Daemon is not running',
      })
      return
    }

    // Read status from database
    try {
      const cacheDb = getCacheDb()
      const statusService = createDaemonStatusService(cacheDb)
      const info = statusService.getDaemonInfo()

      const uptime = info.startedAt
        ? formatDuration(Date.now() - info.startedAt)
        : null

      success({
        status: 'running',
        pid,
        uptime,
        connectedAccounts: info.connectedAccounts,
        totalAccounts: info.totalAccounts,
        messagesSynced: info.messagesSynced,
        lastUpdate: info.lastUpdate
          ? new Date(info.lastUpdate).toISOString()
          : null,
      })
    } catch (err) {
      // Database might not be initialized yet
      success({
        status: 'running',
        pid,
        message: 'Daemon is running (status details unavailable)',
      })
    }
  },
})

/**
 * Main daemon command
 */
export const daemonCommand = defineCommand({
  meta: {
    name: 'daemon',
    description: 'Manage the background sync daemon',
  },
  subCommands: {
    start: startCommand,
    stop: stopCommand,
    status: statusCommand,
  },
})

export { DaemonExitCode }
