import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-code-test-'))

process.env.DATA_DIR = tmpDir
process.env.APP_SQLITE_PATH = process.env.APP_SQLITE_PATH ?? path.join(tmpDir, 'app.db')
process.env.NODE_ENV = 'test'
process.env.CC_SERVICE_CREDENTIAL =
  process.env.CC_SERVICE_CREDENTIAL ?? 'test-service-credential-min-16-chars'

// Best-effort cleanup after the suite.
process.on('exit', () => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  } catch {
    // ignore
  }
})
