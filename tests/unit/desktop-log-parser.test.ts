import { describe, expect, it } from 'vitest'
import { hasUnhandledDesktopError, parseDesktopLogLine } from '../desktop/harness/logs'

describe('desktop log parser', () => {
  it('classifies main, chrome renderer, tab renderer, crash, and exception records', () => {
    const records = [
      parseDesktopLogLine(JSON.stringify({ kind: 'main', level: 'info', msg: 'started' })),
      parseDesktopLogLine(JSON.stringify({ kind: 'chrome-renderer', level: 'info', msg: 'chrome' })),
      parseDesktopLogLine(JSON.stringify({ kind: 'tab-renderer', level: 'info', msg: 'tab' })),
      parseDesktopLogLine(JSON.stringify({ kind: 'crash', level: 'error', msg: 'gone' })),
      parseDesktopLogLine(JSON.stringify({ kind: 'exception', level: 'error', msg: 'unhandled' })),
    ]

    expect(records.map((record) => record?.kind)).toEqual([
      'main',
      'chrome-renderer',
      'tab-renderer',
      'crash',
      'exception',
    ])
    expect(hasUnhandledDesktopError(records.filter((record) => !!record))).toBe(true)
  })
})
