import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const tmpDir = typeof os.tmpdir === 'function' && typeof fs.mkdtempSync === 'function'
  ? fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-code-test-'))
  : `/tmp/cloud-code-test-${Date.now()}-${Math.random().toString(36).slice(2)}`

process.env.DATA_DIR = tmpDir
process.env.APP_SQLITE_PATH = process.env.APP_SQLITE_PATH ?? (
  typeof path.join === 'function' ? path.join(tmpDir, 'app.db') : `${tmpDir}/app.db`
)
process.env.CC_INSTANCE_ID = 'default'
process.env.NODE_ENV = 'test'
process.env.CC_SERVICE_CREDENTIAL =
  process.env.CC_SERVICE_CREDENTIAL ?? 'test-service-credential-min-16-chars'

// Best-effort cleanup after the suite.
process.on('exit', () => {
  try {
    if (typeof fs.rmSync === 'function') fs.rmSync(tmpDir, { recursive: true, force: true })
  } catch {
    // ignore
  }
})
