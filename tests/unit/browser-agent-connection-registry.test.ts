import { describe, expect, it } from 'vitest'
import { BrowserAgentConnectionRegistry } from '../../packages/cloud-code-desktop/src/browser-agent-registry'

describe('BrowserAgentConnectionRegistry', () => {
  it('prevents cross-session cdpId reuse', () => {
    const registry = new BrowserAgentConnectionRegistry()
    const scopeA = { sandboxId: 'sb-a', opencodeSessionId: 'oc-a' }
    const scopeB = { sandboxId: 'sb-b', opencodeSessionId: 'oc-b' }
    const connection = registry.connect(scopeA, 'tab-1')

    expect(registry.get(scopeA, connection.cdpId)).toMatchObject({ browserTabId: 'tab-1' })
    expect(registry.get(scopeB, connection.cdpId)).toBeNull()
    expect(registry.disconnect(scopeB, connection.cdpId)).toBeNull()
    expect(registry.get(scopeA, connection.cdpId)).not.toBeNull()
  })

  it('cleans up stale tab connections', () => {
    const registry = new BrowserAgentConnectionRegistry()
    const scope = { sandboxId: 'sb-a', opencodeSessionId: 'oc-a' }
    const a = registry.connect(scope, 'tab-1')
    const b = registry.connect(scope, 'tab-1')

    expect(registry.isConnected('tab-1')).toBe(true)
    expect(registry.disconnectTab('tab-1')).toHaveLength(2)
    expect(registry.get(scope, a.cdpId)).toBeNull()
    expect(registry.get(scope, b.cdpId)).toBeNull()
    expect(registry.isConnected('tab-1')).toBe(false)
  })
})
