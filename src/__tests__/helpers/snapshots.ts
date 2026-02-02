/**
 * Snapshot helpers for consistent output comparisons.
 */

export function normalizeSnapshotText(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .trimEnd()
}

export function snapshotLines(lines: string[]): string {
  return normalizeSnapshotText(lines.join('\n'))
}
