/**
 * Status command - comprehensive system status display
 *
 * Shows daemon status, sync jobs, rate limits, and account info
 * with colorful, easy-to-read output.
 */

import { join } from 'node:path'
import { defineCommand } from 'citty'
import { createPidFile } from '../daemon'
import { accountsDb, getCacheDb, getDataDir } from '../db'
import { createDaemonStatusService } from '../db/daemon-status'
import { createRateLimitsService } from '../db/rate-limits'
import { createSyncJobsService } from '../db/sync-jobs'
import { SyncJobStatus } from '../db/sync-schema'
import { getOutputFormat, success } from '../utils/output'

// ANSI color codes for terminal output
const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',

  // Foreground colors
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  gray: '\x1b[90m',

  // Background colors
  bgRed: '\x1b[41m',
  bgGreen: '\x1b[42m',
  bgYellow: '\x1b[43m',
  bgBlue: '\x1b[44m',
}

// Color helper functions
const c = {
  bold: (s: string) => `${colors.bold}${s}${colors.reset}`,
  dim: (s: string) => `${colors.dim}${s}${colors.reset}`,
  red: (s: string) => `${colors.red}${s}${colors.reset}`,
  green: (s: string) => `${colors.green}${s}${colors.reset}`,
  yellow: (s: string) => `${colors.yellow}${s}${colors.reset}`,
  blue: (s: string) => `${colors.blue}${s}${colors.reset}`,
  cyan: (s: string) => `${colors.cyan}${s}${colors.reset}`,
  magenta: (s: string) => `${colors.magenta}${s}${colors.reset}`,
  gray: (s: string) => `${colors.gray}${s}${colors.reset}`,

  // Status indicators
  success: (s: string) => `${colors.green}${colors.bold}${s}${colors.reset}`,
  warning: (s: string) => `${colors.yellow}${colors.bold}${s}${colors.reset}`,
  error: (s: string) => `${colors.red}${colors.bold}${s}${colors.reset}`,
  info: (s: string) => `${colors.cyan}${s}${colors.reset}`,

  // Special formatting
  header: (s: string) => `${colors.bold}${colors.blue}${s}${colors.reset}`,
  label: (s: string) => `${colors.gray}${s}${colors.reset}`,
  value: (s: string) => `${colors.white}${s}${colors.reset}`,
  number: (s: string | number) =>
    `${colors.cyan}${colors.bold}${s}${colors.reset}`,
}

// Status icons
const icons = {
  running: '●',
  stopped: '○',
  success: '✓',
  error: '✗',
  warning: '⚠',
  pending: '◌',
  arrow: '→',
  bullet: '•',
  line: '─',
}

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
 * Format timestamp to relative time
 */
function formatRelativeTime(timestamp: number): string {
  const now = Date.now()
  const diff = now - timestamp

  if (diff < 1000) return 'just now'
  if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`
  return `${Math.floor(diff / 86400000)}d ago`
}

/**
 * Format bytes to human-readable size
 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

/**
 * Get process memory usage (if available)
 */
async function getProcessMemory(pid: number): Promise<number | null> {
  try {
    // Try to read /proc on Linux
    const procFile = Bun.file(`/proc/${pid}/status`)
    if (await procFile.exists()) {
      const content = await procFile.text()
      const match = content.match(/VmRSS:\s+(\d+)\s+kB/)
      if (match?.[1]) {
        return parseInt(match[1], 10) * 1024 // Convert to bytes
      }
    }
  } catch {
    // /proc not available (macOS, etc.)
  }

  try {
    // Try ps command as fallback
    const proc = Bun.spawn(['ps', '-o', 'rss=', '-p', pid.toString()], {
      stdout: 'pipe',
    })
    const output = await new Response(proc.stdout).text()
    const rss = parseInt(output.trim(), 10)
    if (!Number.isNaN(rss)) {
      return rss * 1024 // ps reports in KB
    }
  } catch {
    // ps failed
  }

  return null
}

/**
 * Print a section header
 */
function printHeader(title: string): void {
  const line = icons.line.repeat(40)
  console.log()
  console.log(c.header(`${icons.bullet} ${title}`))
  console.log(c.dim(line))
}

/**
 * Print a key-value row
 */
function printRow(label: string, value: string, indent = 2): void {
  const padding = ' '.repeat(indent)
  const labelWidth = 20
  const paddedLabel = label.padEnd(labelWidth)
  console.log(`${padding}${c.label(paddedLabel)} ${value}`)
}

/**
 * Status command implementation
 */
export const statusCommand = defineCommand({
  meta: {
    name: 'status',
    description: 'Show comprehensive system status',
  },
  args: {
    json: {
      type: 'boolean',
      description: 'Force JSON output',
      alias: 'j',
      default: false,
    },
  },
  async run({ args }) {
    const dataDir = getDataDir()
    const pidPath = join(dataDir, 'daemon.pid')
    const pidFile = createPidFile(pidPath)

    // Collect all status data
    const statusData = await collectStatus(pidFile, dataDir)

    // Determine output format
    const format = getOutputFormat()
    const useJson = args.json || format === 'json'

    if (useJson) {
      success(statusData)
      return
    }

    // Pretty print with colors
    printPrettyStatus(statusData)
  },
})

/**
 * Collect all status information
 */
async function collectStatus(
  pidFile: ReturnType<typeof createPidFile>,
  _dataDir: string,
) {
  const pid = pidFile.read()
  const isRunning = pid !== null && pidFile.isRunning()

  // Daemon status
  const daemonStatus: {
    status: 'running' | 'stopped'
    pid: number | null
    uptime_seconds: number | null
    memory_bytes: number | null
    started_at: string | null
    last_update: string | null
    connected_accounts: number
    total_accounts: number
    messages_synced: number
  } = {
    status: isRunning ? 'running' : 'stopped',
    pid: isRunning ? pid : null,
    uptime_seconds: null,
    memory_bytes: null,
    started_at: null,
    last_update: null,
    connected_accounts: 0,
    total_accounts: 0,
    messages_synced: 0,
  }

  // Sync status
  const syncStatus: {
    pending_jobs: number
    running_jobs: number
    failed_jobs: number
    jobs: Array<{
      id: number
      chat_id: number
      type: string
      status: string
      messages_fetched: number
    }>
  } = {
    pending_jobs: 0,
    running_jobs: 0,
    failed_jobs: 0,
    jobs: [],
  }

  // Rate limits status
  const rateLimitsStatus: {
    api_calls_last_minute: number
    calls_by_method: Record<string, number>
    active_flood_waits: Array<{
      method: string
      blocked_until: string
      wait_seconds: number
      remaining_seconds: number
    }>
  } = {
    api_calls_last_minute: 0,
    calls_by_method: {},
    active_flood_waits: [],
  }

  // Try to read from database
  try {
    const cacheDb = getCacheDb()

    // Daemon info
    const daemonService = createDaemonStatusService(cacheDb)
    const daemonInfo = daemonService.getDaemonInfo()

    if (isRunning && daemonInfo.startedAt) {
      daemonStatus.uptime_seconds = Math.floor(
        (Date.now() - daemonInfo.startedAt) / 1000,
      )
      daemonStatus.started_at = new Date(daemonInfo.startedAt).toISOString()
    }
    if (daemonInfo.lastUpdate) {
      daemonStatus.last_update = new Date(daemonInfo.lastUpdate).toISOString()
    }
    daemonStatus.connected_accounts = daemonInfo.connectedAccounts
    daemonStatus.total_accounts = daemonInfo.totalAccounts
    daemonStatus.messages_synced = daemonInfo.messagesSynced

    // Get memory usage
    if (isRunning && pid) {
      const memory = await getProcessMemory(pid)
      if (memory) {
        daemonStatus.memory_bytes = memory
      }
    }

    // Sync jobs
    const syncService = createSyncJobsService(cacheDb)
    const pendingJobs = syncService.getPendingJobs()
    const runningJobs = syncService.getRunningJobs()

    syncStatus.pending_jobs = pendingJobs.length
    syncStatus.running_jobs = runningJobs.length

    // Get recent jobs for display
    const recentJobs = [...runningJobs, ...pendingJobs.slice(0, 5)]
    syncStatus.jobs = recentJobs.map((job) => ({
      id: job.id,
      chat_id: job.chat_id,
      type: job.job_type,
      status: job.status,
      messages_fetched: job.messages_fetched,
    }))

    // Rate limits
    const rateLimitsService = createRateLimitsService(cacheDb)
    const rlStatus = rateLimitsService.getStatus()

    rateLimitsStatus.api_calls_last_minute = rlStatus.totalCalls
    rateLimitsStatus.calls_by_method = rlStatus.callsByMethod

    const now = Math.floor(Date.now() / 1000)
    rateLimitsStatus.active_flood_waits = rlStatus.activeFloodWaits.map(
      (fw) => ({
        method: fw.method,
        blocked_until: new Date(fw.blockedUntil * 1000).toISOString(),
        wait_seconds: fw.waitSeconds,
        remaining_seconds: Math.max(0, fw.blockedUntil - now),
      }),
    )
  } catch {
    // Database might not be initialized
  }

  // Account info
  const accounts = accountsDb.getAll()
  const activeAccount = accountsDb.getActive()

  const accountsStatus = {
    total: accounts.length,
    active_id: activeAccount?.id ?? null,
    active_phone: activeAccount?.phone ?? null,
    active_name: activeAccount?.name ?? null,
    accounts: accounts.map((a) => ({
      id: a.id,
      phone: a.phone,
      name: a.name,
      is_active: a.is_active === 1,
    })),
  }

  return {
    daemon: daemonStatus,
    sync: syncStatus,
    rate_limits: rateLimitsStatus,
    accounts: accountsStatus,
    timestamp: new Date().toISOString(),
  }
}

/**
 * Print status in a pretty, colored format
 */
function printPrettyStatus(status: Awaited<ReturnType<typeof collectStatus>>) {
  console.log()
  console.log(c.bold('  Telegram CLI Status'))
  console.log(c.dim(`  ${status.timestamp}`))

  // === DAEMON ===
  printHeader('Daemon')

  const daemonIcon =
    status.daemon.status === 'running' ? icons.running : icons.stopped
  const daemonColor = status.daemon.status === 'running' ? c.success : c.error
  printRow(
    'Status',
    daemonColor(`${daemonIcon} ${status.daemon.status.toUpperCase()}`),
  )

  if (status.daemon.pid) {
    printRow('PID', c.number(status.daemon.pid))
  }

  if (status.daemon.uptime_seconds !== null) {
    printRow(
      'Uptime',
      c.value(formatDuration(status.daemon.uptime_seconds * 1000)),
    )
  }

  if (status.daemon.memory_bytes !== null) {
    printRow('Memory', c.value(formatBytes(status.daemon.memory_bytes)))
  }

  if (
    status.daemon.connected_accounts > 0 ||
    status.daemon.total_accounts > 0
  ) {
    printRow(
      'Connections',
      `${c.number(status.daemon.connected_accounts)} ${c.dim('/')} ${c.number(status.daemon.total_accounts)} accounts`,
    )
  }

  if (status.daemon.messages_synced > 0) {
    printRow(
      'Messages Synced',
      c.number(status.daemon.messages_synced.toLocaleString()),
    )
  }

  if (status.daemon.last_update) {
    const lastUpdate = new Date(status.daemon.last_update).getTime()
    printRow('Last Update', c.dim(formatRelativeTime(lastUpdate)))
  }

  // === SYNC JOBS ===
  printHeader('Sync Jobs')

  const totalJobs = status.sync.pending_jobs + status.sync.running_jobs
  if (totalJobs === 0) {
    printRow('Queue', c.dim('Empty'))
  } else {
    if (status.sync.running_jobs > 0) {
      printRow('Running', c.success(`${status.sync.running_jobs} jobs`))
    }
    if (status.sync.pending_jobs > 0) {
      printRow('Pending', c.warning(`${status.sync.pending_jobs} jobs`))
    }

    // Show job details
    if (status.sync.jobs.length > 0) {
      console.log()
      for (const job of status.sync.jobs) {
        const statusIcon =
          job.status === SyncJobStatus.Running
            ? c.success(icons.running)
            : c.yellow(icons.pending)
        const fetched =
          job.messages_fetched > 0
            ? c.dim(` (${job.messages_fetched} msgs)`)
            : ''
        console.log(
          `    ${statusIcon} ${c.cyan(`#${job.id}`)} ${c.value(job.type)} ${c.dim(`chat:${job.chat_id}`)}${fetched}`,
        )
      }
    }
  }

  // === RATE LIMITS ===
  printHeader('Rate Limits')

  printRow('API Calls (1m)', c.number(status.rate_limits.api_calls_last_minute))

  // Show top methods by call count
  const methodEntries = Object.entries(status.rate_limits.calls_by_method)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)

  if (methodEntries.length > 0) {
    console.log()
    console.log(c.label('  Top Methods:'))
    for (const [method, count] of methodEntries) {
      const shortMethod = method.split('.').pop() ?? method
      console.log(
        `    ${c.dim(icons.bullet)} ${c.value(shortMethod)} ${c.number(count)}`,
      )
    }
  }

  // Show active flood waits
  if (status.rate_limits.active_flood_waits.length > 0) {
    console.log()
    console.log(c.error(`  ${icons.warning} Active Flood Waits:`))
    for (const fw of status.rate_limits.active_flood_waits) {
      const remaining = fw.remaining_seconds
      const remainingStr =
        remaining > 0 ? `${remaining}s remaining` : 'expiring soon'
      console.log(
        `    ${c.red(icons.bullet)} ${c.value(fw.method)} ${c.dim(icons.arrow)} ${c.warning(remainingStr)}`,
      )
    }
  } else {
    printRow('Flood Waits', c.success('None'))
  }

  // === ACCOUNTS ===
  printHeader('Accounts')

  printRow('Total', c.number(status.accounts.total))

  if (status.accounts.active_phone) {
    const activeName = status.accounts.active_name
      ? ` (${status.accounts.active_name})`
      : ''
    printRow(
      'Active',
      `${c.success(status.accounts.active_phone)}${c.dim(activeName)}`,
    )
  } else {
    printRow('Active', c.warning('None'))
  }

  // Show account list if multiple
  if (status.accounts.accounts.length > 1) {
    console.log()
    for (const acc of status.accounts.accounts) {
      const activeMarker = acc.is_active ? c.success(icons.success) : c.dim(' ')
      const name = acc.name ? c.dim(` ${acc.name}`) : ''
      console.log(
        `    ${activeMarker} ${c.cyan(`#${acc.id}`)} ${c.value(acc.phone)}${name}`,
      )
    }
  }

  console.log()
}
