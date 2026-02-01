/**
 * PID file management for daemon
 * Prevents multiple daemon instances and enables lifecycle management
 */
import { existsSync, rmSync, writeFileSync } from 'node:fs'

/**
 * Error thrown when PID file operations fail
 */
export class PidFileError extends Error {
  constructor(
    message: string,
    public readonly code: 'ALREADY_RUNNING' | 'NOT_RUNNING' | 'IO_ERROR',
    public readonly pid?: number,
  ) {
    super(message)
    this.name = 'PidFileError'
  }
}

/**
 * PID file interface
 */
export interface PidFile {
  /** Acquire PID file (fails if daemon already running) */
  acquire(): void
  /** Release PID file */
  release(): void
  /** Read PID from file (null if not running) */
  read(): number | null
  /** Check if daemon is running */
  isRunning(): boolean
  /** Send signal to daemon process */
  sendSignal(signal: number | NodeJS.Signals): boolean
  /** Get PID file path */
  getPath(): string
}

/**
 * Check if a process exists
 */
function processExists(pid: number): boolean {
  try {
    // Signal 0 doesn't actually send a signal, just checks if process exists
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Create a PID file manager
 */
export function createPidFile(path: string): PidFile {
  return {
    acquire(): void {
      // Check if PID file exists
      if (existsSync(path)) {
        // Using sync read for simplicity in synchronous context
        const existingPid = parseInt(
          require('node:fs').readFileSync(path, 'utf-8').trim(),
          10,
        )

        if (!Number.isNaN(existingPid) && processExists(existingPid)) {
          throw new PidFileError(
            `Daemon already running with PID ${existingPid}`,
            'ALREADY_RUNNING',
            existingPid,
          )
        }

        // Stale PID file, remove it
        rmSync(path, { force: true })
      }

      // Write current PID
      try {
        writeFileSync(path, process.pid.toString(), { mode: 0o600 })
      } catch (err) {
        throw new PidFileError(`Failed to write PID file: ${err}`, 'IO_ERROR')
      }
    },

    release(): void {
      if (existsSync(path)) {
        rmSync(path, { force: true })
      }
    },

    read(): number | null {
      if (!existsSync(path)) {
        return null
      }

      try {
        const content = require('node:fs').readFileSync(path, 'utf-8').trim()
        const pid = parseInt(content, 10)

        if (Number.isNaN(pid)) {
          return null
        }

        if (!processExists(pid)) {
          return null
        }

        return pid
      } catch {
        return null
      }
    },

    isRunning(): boolean {
      return this.read() !== null
    },

    sendSignal(signal: number | NodeJS.Signals): boolean {
      const pid = this.read()
      if (pid === null) {
        return false
      }

      try {
        process.kill(pid, signal)
        return true
      } catch {
        return false
      }
    },

    getPath(): string {
      return path
    },
  }
}
