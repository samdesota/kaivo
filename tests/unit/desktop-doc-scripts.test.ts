import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

describe('desktop documentation scripts', () => {
  it('documents scripts that exist in package.json', () => {
    const root = path.resolve(__dirname, '../..')
    const rootPkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>
    }
    const desktopPkg = JSON.parse(
      fs.readFileSync(path.join(root, 'packages/cloud-code-desktop/package.json'), 'utf8'),
    ) as { scripts: Record<string, string> }
    const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8')

    for (const script of [
      'dev',
      'dev:web',
      'build:desktop',
      'dev:desktop',
      'dev:desktop:external',
      'test:e2e:desktop',
      'test:e2e:desktop:app',
    ]) {
      expect(rootPkg.scripts[script], script).toBeTypeOf('string')
      expect(readme).toContain(`npm run ${script}`)
    }

    for (const script of ['build', 'dev', 'typecheck']) {
      expect(desktopPkg.scripts[script], script).toBeTypeOf('string')
    }
  })
})
