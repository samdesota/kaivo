import { describe, expect, it } from 'vitest'
import { workspaceTabFromPaneContent, workspaceTabKey } from '../../shared/workspace-pane'

describe('workspaceTabFromPaneContent', () => {
  it('creates shell, file, preview, and browser tabs with expected titles and keys', () => {
    const shell = workspaceTabFromPaneContent({ type: 'shell', shellId: 'shell-12345678' }, 'env-a')
    const file = workspaceTabFromPaneContent({ type: 'file', path: '/tmp/a.ts' }, 'env-a')
    const preview = workspaceTabFromPaneContent({ type: 'preview', port: 5173 }, 'env-a')
    const browser = workspaceTabFromPaneContent({ type: 'browser', url: 'https://example.com' }, undefined)

    expect(shell).toMatchObject({ type: 'shell', envId: 'env-a', shellId: 'shell-12345678', title: 'shell 12345678' })
    expect(file).toMatchObject({ type: 'file', envId: 'env-a', path: '/tmp/a.ts', title: 'a.ts' })
    expect(preview).toMatchObject({ type: 'preview', envId: 'env-a', port: 5173, title: 'preview :5173' })
    expect(browser).toMatchObject({ type: 'browser', url: 'https://example.com', title: 'https://example.com' })

    expect(shell && workspaceTabKey(shell)).toBe('shell:env-a:shell-12345678')
    expect(file && workspaceTabKey(file)).toBe('file:env-a::/tmp/a.ts')
    expect(preview && workspaceTabKey(preview)).toBe('preview:env-a:5173')
    expect(browser && workspaceTabKey(browser)).toBe(browser ? `browser:${browser.id}` : null)
  })

  it('uses stable logical keys for duplicate file tabs even when tab ids differ', () => {
    const first = workspaceTabFromPaneContent({ type: 'file', path: '/tmp/a.ts' }, 'env-a')
    const second = workspaceTabFromPaneContent({ type: 'file', path: '/tmp/a.ts' }, 'env-a')

    expect(first?.id).not.toBe(second?.id)
    expect(first && second && workspaceTabKey(first)).toBe(second && workspaceTabKey(second))
  })

  it('uses distinct identity keys for browser tabs with the same URL', () => {
    const first = workspaceTabFromPaneContent({ type: 'browser', url: 'https://example.com' }, undefined)
    const second = workspaceTabFromPaneContent({ type: 'browser', url: 'https://example.com' }, undefined)

    expect(first?.id).not.toBe(second?.id)
    expect(first && second && workspaceTabKey(first)).not.toBe(second && workspaceTabKey(second))
  })

  it('creates preview tabs instead of dropping preview open requests', () => {
    expect(workspaceTabFromPaneContent({ type: 'preview', port: 5173 }, 'env-a')).toMatchObject({
      type: 'preview',
      envId: 'env-a',
      port: 5173,
      title: 'preview :5173',
    })
  })

  it('creates browser tabs without an env and preserves native tab ids when provided', () => {
    expect(workspaceTabFromPaneContent({ type: 'browser', url: 'http://127.0.0.1:5173', browserTabId: 'native-1' }, undefined)).toMatchObject({
      type: 'browser',
      url: 'http://127.0.0.1:5173',
      browserTabId: 'native-1',
      title: 'http://127.0.0.1:5173',
    })
  })

  it('rejects env-backed tabs when no env is available', () => {
    expect(workspaceTabFromPaneContent({ type: 'preview', port: 5173 }, undefined)).toBeNull()
    expect(workspaceTabFromPaneContent({ type: 'shell', shellId: 'shell-1' }, undefined)).toBeNull()
  })
})
