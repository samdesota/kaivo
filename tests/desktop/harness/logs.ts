import fs from 'node:fs'

export type DesktopLogKind =
  | 'main'
  | 'chrome-renderer'
  | 'tab-renderer'
  | 'crash'
  | 'exception'

export type DesktopLogRecord = {
  ts: string
  kind: DesktopLogKind
  level: 'debug' | 'info' | 'warn' | 'error'
  msg: string
  ctx?: Record<string, unknown>
}

export function parseDesktopLogLine(line: string): DesktopLogRecord | undefined {
  if (!line.trim()) return undefined
  const parsed = JSON.parse(line) as Partial<DesktopLogRecord>
  if (!parsed.kind || !parsed.level || !parsed.msg) return undefined
  if (!isDesktopLogKind(parsed.kind)) return undefined
  return {
    ts: typeof parsed.ts === 'string' ? parsed.ts : new Date(0).toISOString(),
    kind: parsed.kind,
    level: parsed.level,
    msg: parsed.msg,
    ctx: parsed.ctx,
  }
}

export function parseDesktopLogFile(logPath: string): DesktopLogRecord[] {
  if (!fs.existsSync(logPath)) return []
  return fs
    .readFileSync(logPath, 'utf8')
    .split('\n')
    .map((line) => parseDesktopLogLine(line))
    .filter((record): record is DesktopLogRecord => !!record)
}

export function hasUnhandledDesktopError(records: DesktopLogRecord[]): boolean {
  return records.some((record) => record.kind === 'exception' || record.kind === 'crash')
}

export function recentDesktopLogLines(logPath: string, limit = 20): string[] {
  if (!fs.existsSync(logPath)) return []
  const lines = fs.readFileSync(logPath, 'utf8').trimEnd().split('\n')
  return lines.slice(Math.max(0, lines.length - limit))
}

function isDesktopLogKind(value: string): value is DesktopLogKind {
  return (
    value === 'main' ||
    value === 'chrome-renderer' ||
    value === 'tab-renderer' ||
    value === 'crash' ||
    value === 'exception'
  )
}
