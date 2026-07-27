import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBufferedFileLogger } from './desktop-logger'

const tempDirs: string[] = []

afterEach(() => {
  vi.useRealTimers()
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function tempLogPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaivo-desktop-log-test-'))
  tempDirs.push(dir)
  return path.join(dir, 'nested', 'desktop.log')
}

describe('createBufferedFileLogger', () => {
  it('buffers lines until an asynchronous flush', async () => {
    const logPath = tempLogPath()
    const logger = createBufferedFileLogger(logPath, { flushIntervalMs: 60_000 })

    logger.write('first\n')
    logger.write('second\n')
    expect(fs.existsSync(logPath)).toBe(false)

    await logger.flush()
    expect(fs.readFileSync(logPath, 'utf8')).toBe('first\nsecond\n')
  })

  it('flushes buffered lines on the configured interval', async () => {
    vi.useFakeTimers()
    const logPath = tempLogPath()
    const logger = createBufferedFileLogger(logPath, { flushIntervalMs: 100 })

    logger.write('line\n')
    await vi.advanceTimersByTimeAsync(100)
    await logger.flush()

    expect(fs.readFileSync(logPath, 'utf8')).toBe('line\n')
  })
})
