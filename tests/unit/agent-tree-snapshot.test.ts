import { describe, expect, it } from 'vitest'
import {
  AGENT_TREE_SOURCE,
  serializeSnapshot,
  snapshotToText,
  type AgentTreeNode,
} from '../../packages/zoottle-desktop/src/agent-tree-snapshot'

function raw(root: AgentTreeNode | null) {
  return {
    url: 'https://example.test/form',
    title: 'Example Form',
    version: 1,
    durationMs: 3.4,
    root,
    interactiveCount: 0,
  }
}

describe('ported agent tree snapshot serializer', () => {
  it('renders compact semantic tree text with interactive element ids', () => {
    const snapshot = serializeSnapshot(raw({
      tag: 'body',
      role: 'main',
      children: [
        { tag: 'h1', role: 'heading', name: 'Welcome', state: { level: 1 } },
        { tag: 'button', role: 'button', name: 'Submit', id: 'e12', attrs: { type: 'submit', id: 'submit-btn' } },
      ],
    }))

    expect(snapshot.interactiveCount).toBe(1)
    expect(snapshot.refs.e12).toEqual({ role: 'button', name: 'Submit' })
    expect(snapshotToText(snapshot)).toBe(
      '{"url":"https://example.test/form","title":"Example Form","interactiveCount":1,"durationMs":3.4}\nmain\n\theading "Welcome" {level=1}\n\t[12] button "Submit"',
    )
  })

  it('filters by regex while preserving matching descendants', () => {
    const snapshot = serializeSnapshot(raw({
      tag: 'body',
      role: 'main',
      children: [
        { tag: 'a', role: 'link', name: 'Docs', id: 'e1', attrs: { href: '/docs' } },
        { tag: 'button', role: 'button', name: 'Save', id: 'e2' },
      ],
    }), { filter: 'save', filterFlags: 'i' })

    expect(snapshot.tree).toBe('main\n\t[2] button "Save"')
    expect(Object.keys(snapshot.refs)).toEqual(['e2'])
  })

  it('prunes decorative nodes and collapses generic wrappers', () => {
    const snapshot = serializeSnapshot(raw({
      tag: 'div',
      children: [
        { tag: 'svg', role: 'img', name: 'Decorative icon' },
        { tag: 'div', children: [{ tag: 'a', role: 'link', name: 'Home', id: 'e3', attrs: { href: '/' } }] },
      ],
    }))

    expect(snapshot.tree).toBe('[3] link "Home"')
  })

  it('keeps upstream in-page behavior for viewport, shadow DOM, ARIA names, and ids', () => {
    expect(AGENT_TREE_SOURCE).toContain('intersectsViewport')
    expect(AGENT_TREE_SOURCE).toContain('element.shadowRoot')
    expect(AGENT_TREE_SOURCE).toContain("referencedText(element, 'aria-labelledby')")
    expect(AGENT_TREE_SOURCE).toContain("id = 'e' + nextId++")
  })
})
