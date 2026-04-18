import { describe, expect, it } from 'vitest'
import { parseSsOutput } from './service.js'
import { parsePreviewUrl } from './proxy.js'

describe('parseSsOutput', () => {
  it('parses ipv4 + ipv6 listeners and deduplicates by port+process', () => {
    const stdout = [
      'State   Recv-Q Send-Q Local Address:Port   Peer Address:Port  Process',
      'LISTEN  0      128    0.0.0.0:5173         0.0.0.0:*          users:(("python3",pid=42,fd=3))',
      'LISTEN  0      128    [::]:5173            [::]:*             users:(("python3",pid=42,fd=3))',
      'LISTEN  0      128    127.0.0.1:3000       0.0.0.0:*          users:(("node",pid=99,fd=18))',
    ].join('\n')
    const ports = parseSsOutput(stdout)
    expect(ports).toHaveLength(2)
    const byPort = Object.fromEntries(ports.map((p) => [p.port, p]))
    expect(byPort[5173]!.process).toBe('python3')
    expect(byPort[3000]!.process).toBe('node')
    expect(byPort[3000]!.address).toBe('127.0.0.1')
  })

  it('returns empty array when there are no LISTEN rows', () => {
    expect(parseSsOutput('')).toEqual([])
    expect(parseSsOutput('ESTAB 0 0 127.0.0.1:1234 127.0.0.1:5678 users:(("x",pid=1,fd=2))')).toEqual([])
  })

  it('handles rows without a process column', () => {
    const stdout = 'LISTEN 0 128 0.0.0.0:8080 0.0.0.0:*'
    const ports = parseSsOutput(stdout)
    expect(ports).toEqual([{ port: 8080, address: '0.0.0.0', process: null }])
  })
})

describe('parsePreviewUrl', () => {
  it('preserves the full path so base-aware dev servers see their prefix', () => {
    const out = parsePreviewUrl('/preview/sb_123/5173/assets/index.js?v=1')
    expect(out).toEqual({
      sandboxId: 'sb_123',
      port: 5173,
      rest: '/preview/sb_123/5173/assets/index.js?v=1',
    })
  })

  it('preserves the bare prefix', () => {
    expect(parsePreviewUrl('/preview/sb_123/5173')).toEqual({
      sandboxId: 'sb_123',
      port: 5173,
      rest: '/preview/sb_123/5173',
    })
  })

  it('rejects non-preview paths', () => {
    expect(parsePreviewUrl('/trpc/foo')).toBeNull()
  })

  it('rejects invalid ports', () => {
    expect(parsePreviewUrl('/preview/sb/0/')).toBeNull()
    expect(parsePreviewUrl('/preview/sb/70000/')).toBeNull()
    expect(parsePreviewUrl('/preview/sb/abc/')).toBeNull()
  })
})
