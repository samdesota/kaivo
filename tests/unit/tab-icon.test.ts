import { describe, expect, it } from 'vitest'
import { paneTabIconForType } from '../../src/components/tab-icon'

describe('pane tab icons', () => {
  it('maps current pane types to default pane icons', () => {
    expect(paneTabIconForType('shell')).toEqual({ kind: 'pane', pane: 'shell' })
    expect(paneTabIconForType('file')).toEqual({ kind: 'pane', pane: 'file' })
    expect(paneTabIconForType('browser')).toEqual({ kind: 'pane', pane: 'browser' })
  })
})
