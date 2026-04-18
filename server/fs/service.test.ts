import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Redirect DATA_DIR to a test-local tmp dir *before* importing the service so
// workspaceDir resolves under it.
let tmpRoot: string

describe('fs service', () => {
  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'fs-svc-'))
    process.env.DATA_DIR = tmpRoot
    vi.resetModules()
  })
  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true })
  })

  async function mkSandbox(id: string): Promise<string> {
    const dir = path.join(tmpRoot, 'sandboxes', id, 'workspace')
    await fs.mkdir(dir, { recursive: true })
    return dir
  }

  it('resolves inside the workspace', async () => {
    const id = 'sb1'
    const ws = await mkSandbox(id)
    const { resolveWorkspacePath } = await import('./service.js')
    expect(resolveWorkspacePath(id, '/')).toBe(path.resolve(ws))
    expect(resolveWorkspacePath(id, '/foo/bar.txt')).toBe(
      path.resolve(path.join(ws, 'foo/bar.txt')),
    )
  })

  it('rejects path traversal', async () => {
    const id = 'sb1'
    await mkSandbox(id)
    const { resolveWorkspacePath, FsError } = await import('./service.js')
    expect(() => resolveWorkspacePath(id, '../../etc/passwd')).toThrow(FsError)
    expect(() => resolveWorkspacePath(id, '/../../../etc/passwd')).toThrow(FsError)
  })

  it('round-trips utf8 content byte-for-byte', async () => {
    const id = 'sb2'
    await mkSandbox(id)
    const { readFile, writeFile } = await import('./service.js')
    const content = 'hello\nworld\nχαίρε 🌍'
    await writeFile(id, '/dir/hello.txt', content)
    const r = await readFile(id, '/dir/hello.txt')
    expect(r.binary).toBe(false)
    expect(r.tooLarge).toBe(false)
    expect(r.content).toBe(content)
  })

  it('returns tooLarge for files over 5MB', async () => {
    const id = 'sb3'
    const ws = await mkSandbox(id)
    const big = path.join(ws, 'big.bin')
    // 5MB + 1 byte
    await fs.writeFile(big, Buffer.alloc(5 * 1024 * 1024 + 1, 0x41))
    const { readFile } = await import('./service.js')
    const r = await readFile(id, '/big.bin')
    expect(r.tooLarge).toBe(true)
    expect(r.content).toBeNull()
  })

  it('flags binary files', async () => {
    const id = 'sb4'
    const ws = await mkSandbox(id)
    // Write something with a null byte.
    await fs.writeFile(path.join(ws, 'bin'), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x02, 0x01, 0x00]))
    const { readFile } = await import('./service.js')
    const r = await readFile(id, '/bin')
    expect(r.binary).toBe(true)
    expect(r.content).toBeNull()
  })

  it('lists directories with directories first', async () => {
    const id = 'sb5'
    const ws = await mkSandbox(id)
    await fs.mkdir(path.join(ws, 'b-dir'))
    await fs.writeFile(path.join(ws, 'a-file.txt'), 'hi')
    const { listDirectory } = await import('./service.js')
    const entries = await listDirectory(id, '/')
    expect(entries.map((e) => e.name)).toEqual(['b-dir', 'a-file.txt'])
  })
})
