import type { AccountsDbInterface } from '../db'
import type { PidFile } from './pid-file'
import type { SyncScheduler } from './scheduler'
import type { RealSyncWorker } from './sync-worker'
import type {
  DaemonLogger,
  DaemonState,
  DaemonVerbosity,
  ReconnectConfig,
} from './types'

export interface DaemonRuntime {
  scheduler: SyncScheduler | null
  syncWorkers: Map<number, RealSyncWorker>
  lastJobProcessTime: number
  totalMessagesSynced: number
  signalHandlersSetup: boolean
}

export interface DaemonContext {
  dataDir: string
  pidPath: string
  verbosity: DaemonVerbosity
  reconnectConfig: ReconnectConfig
  shutdownTimeoutMs: number
  logger: DaemonLogger
  pidFile: PidFile
  state: DaemonState
  accountsDb: AccountsDbInterface
  runtime: DaemonRuntime
}

export function createDaemonRuntime(): DaemonRuntime {
  return {
    scheduler: null,
    syncWorkers: new Map(),
    lastJobProcessTime: 0,
    totalMessagesSynced: 0,
    signalHandlersSetup: false,
  }
}
