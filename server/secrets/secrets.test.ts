import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect, beforeAll } from 'vitest'
import {
  loadMasterKey,
  encrypt,
  decrypt,
  decryptString,
  __resetMasterKeyForTests,
} from './index.js'

describe('secrets', () => {
  beforeAll(() => {
    __resetMasterKeyForTests()
  })

  it('creates secrets.key on first load with mode 0600', async () => {
    const key = await loadMasterKey()
    expect(key.length).toBe(32)

    const keyPath = path.join(process.env.DATA_DIR!, 'secrets.key')
    const stat = fs.statSync(keyPath)
    // Check lower 9 bits (owner/group/other). On non-POSIX this may differ.
    if (process.platform !== 'win32') {
      const mode = stat.mode & 0o777
      expect(mode).toBe(0o600)
    }
  })

  it('encrypt/decrypt round-trip preserves utf-8 data', async () => {
    const plaintext = 'hello world — 秘密 🗝️'
    const payload = await encrypt(plaintext)
    expect(payload.ciphertext).toBeTruthy()
    expect(payload.iv).toBeTruthy()
    expect(payload.authTag).toBeTruthy()

    const out = await decryptString(payload)
    expect(out).toBe(plaintext)
  })

  it('encrypt/decrypt round-trip preserves binary data', async () => {
    const bytes = Buffer.from([0, 1, 2, 3, 255, 128, 64])
    const payload = await encrypt(bytes)
    const out = await decrypt(payload)
    expect(Buffer.compare(out, bytes)).toBe(0)
  })

  it('tampered ciphertext fails authentication', async () => {
    const payload = await encrypt('secret')
    const broken = { ...payload, ciphertext: Buffer.from('AAAA==', 'base64').toString('base64') }
    await expect(decrypt(broken)).rejects.toThrow()
  })
})
