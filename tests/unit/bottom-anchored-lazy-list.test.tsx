// @vitest-environment jsdom
import React from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BottomAnchoredLazyList } from '../../src/routes/env/agent/bottom-anchored-lazy-list'

class TestResizeObserver {
  observe = vi.fn()
  disconnect = vi.fn()
}

function setScrollMetrics(el: HTMLElement, metrics: { scrollHeight: number; clientHeight: number; scrollTop: number }) {
  let scrollTop = metrics.scrollTop

  Object.defineProperty(el, 'scrollHeight', {
    configurable: true,
    get: () => metrics.scrollHeight,
  })
  Object.defineProperty(el, 'clientHeight', {
    configurable: true,
    get: () => metrics.clientHeight,
  })
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => scrollTop,
    set: (value) => {
      scrollTop = value
    },
  })
}

function renderList() {
  return render(
    <BottomAnchoredLazyList
      resetKey="session-1"
      items={[{ id: 'item-1', text: 'hello' }]}
      itemKey={(item) => item.id}
      renderItem={(item) => <div>{item.text}</div>}
    />,
  )
}

describe('BottomAnchoredLazyList', () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, 'ResizeObserver', {
      configurable: true,
      value: TestResizeObserver,
    })
  })

  afterEach(() => cleanup())

  it('stays stuck to bottom when content grows by more than the threshold', () => {
    const view = renderList()
    const scroller = view.container.firstElementChild as HTMLElement

    setScrollMetrics(scroller, { scrollHeight: 1_000, clientHeight: 400, scrollTop: 600 })

    act(() => {
      scroller.dispatchEvent(new Event('scroll'))
    })

    setScrollMetrics(scroller, { scrollHeight: 1_800, clientHeight: 400, scrollTop: scroller.scrollTop })

    act(() => {
      scroller.dispatchEvent(new Event('scroll'))
    })

    expect(scroller.scrollTop).toBe(1_800)
  })

  it('does not restick after the user scrolls up', () => {
    const view = renderList()
    const scroller = view.container.firstElementChild as HTMLElement

    setScrollMetrics(scroller, { scrollHeight: 1_000, clientHeight: 400, scrollTop: 600 })

    act(() => {
      scroller.dispatchEvent(new Event('scroll'))
    })

    setScrollMetrics(scroller, { scrollHeight: 1_000, clientHeight: 400, scrollTop: 350 })

    act(() => {
      scroller.dispatchEvent(new Event('scroll'))
    })

    setScrollMetrics(scroller, { scrollHeight: 1_800, clientHeight: 400, scrollTop: scroller.scrollTop })

    act(() => {
      scroller.dispatchEvent(new Event('scroll'))
    })

    expect(scroller.scrollTop).toBe(350)
  })
})
