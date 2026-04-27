import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

describe('active tRPC router surface', () => {
  it('does not register the legacy sandbox router', () => {
    const source = readRepoFile('server/trpc/router.ts')

    expect(source).not.toContain('sandboxRouter')
    expect(source).not.toMatch(/\bsandbox\s*:/)
  })

  it('does not expose container env creation', () => {
    const source = readRepoFile('server/trpc/routers/env.ts')

    const publicSurface = source.slice(source.indexOf('export const envRouter'))

    expect(publicSurface).not.toContain('createContainer')
  })
})

function readRepoFile(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8')
}
