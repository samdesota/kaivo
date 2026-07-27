import fs from 'node:fs'
import path from 'node:path'

export type BufferedFileLogger = {
  write: (line: string) => void
  flush: () => Promise<void>
  close: () => Promise<void>
}

export function createBufferedFileLogger(
  logPath: string | undefined,
  options: { flushIntervalMs?: number; onError?: (error: unknown) => void } = {},
): BufferedFileLogger {
  const flushIntervalMs = options.flushIntervalMs ?? 250
  const onError = options.onError ?? ((error) => console.error('desktop log write failed', error))
  let pending: string[] = []
  let flushTimer: NodeJS.Timeout | undefined
  let directoryReady: Promise<void> | undefined
  let writeChain = Promise.resolve()
  let closed = false

  function ensureDirectory(): Promise<void> {
    if (!logPath) return Promise.resolve()
    if (!directoryReady) {
      directoryReady = fs.promises.mkdir(path.dirname(logPath), { recursive: true }).then(() => undefined)
    }
    return directoryReady
  }

  function scheduleFlush(): void {
    if (flushTimer || closed) return
    flushTimer = setTimeout(() => {
      flushTimer = undefined
      void flush().catch(() => undefined)
    }, flushIntervalMs)
    flushTimer.unref()
  }

  function write(line: string): void {
    if (!logPath || closed) return
    pending.push(line)
    scheduleFlush()
  }

  function flush(): Promise<void> {
    if (flushTimer) {
      clearTimeout(flushTimer)
      flushTimer = undefined
    }
    if (!logPath || pending.length === 0) return writeChain

    const chunk = pending.join('')
    pending = []
    const operation = writeChain.then(async () => {
      await ensureDirectory()
      await fs.promises.appendFile(logPath, chunk)
    })
    writeChain = operation.catch(onError)
    return operation
  }

  async function close(): Promise<void> {
    closed = true
    await flush()
  }

  return { write, flush, close }
}
