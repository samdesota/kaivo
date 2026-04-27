import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

describe('active client routes', () => {
  it('does not register the legacy sandbox route', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'src/router.tsx'), 'utf8')

    expect(source).not.toContain('/sandbox/$id')
    expect(source).not.toContain('SandboxDetailPage')
  })
})
