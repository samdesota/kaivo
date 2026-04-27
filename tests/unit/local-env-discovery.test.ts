import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

describe('local env discovery defaults', () => {
  it('does not hardcode fixed-port probing in the desktop path', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'src/lib/local-env-discovery.ts'), 'utf8')

    expect(source).toContain('manualLocalDiscoveryEnabled')
    expect(source).toContain('DEFAULT_LOCAL_ENV_URL')
  })
})
