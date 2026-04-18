import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-code-test-'))

process.env.DATA_DIR = tmpDir
process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://test:test@127.0.0.1:5432/test_unused'
process.env.NODE_ENV = 'test'

// Best-effort cleanup after the suite.
process.on('exit', () => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  } catch {
    // ignore
  }
})
