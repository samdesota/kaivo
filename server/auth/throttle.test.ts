import { describe, it, expect, beforeEach } from 'vitest'
import {
  checkThrottle,
  recordFailure,
  recordSuccess,
  __resetThrottleForTests,
} from './throttle.js'

describe('throttle', () => {
  beforeEach(() => {
    __resetThrottleForTests()
  })

  it('allows first attempt from a new IP', () => {
    expect(checkThrottle('1.1.1.1').allowed).toBe(true)
  })

  it('locks after 10 failures within 10 minutes', () => {
    const ip = '2.2.2.2'
    const now = Date.now()
    for (let i = 0; i < 10; i++) {
      recordFailure(ip, now + i * 1000)
    }
    const check = checkThrottle(ip, now + 10_000)
    expect(check.allowed).toBe(false)
    expect(check.reason).toBe('locked')
    expect(check.retryAfterSec).toBeGreaterThan(0)
  })

  it('clears state on success', () => {
    const ip = '3.3.3.3'
    recordFailure(ip)
    recordSuccess(ip)
    expect(checkThrottle(ip).allowed).toBe(true)
  })

  it('allows a few typos with no backoff, then starts backing off', () => {
    const ip = '4.4.4.4'
    const start = Date.now()
    recordFailure(ip, start)
    // First failure is inside the grace window — still allowed.
    expect(checkThrottle(ip, start + 500).allowed).toBe(true)
    recordFailure(ip, start + 1000)
    // Second still grace.
    expect(checkThrottle(ip, start + 1500).allowed).toBe(true)
    recordFailure(ip, start + 2000)
    // Third failure flips on progressive backoff (≥ 16s).
    const check = checkThrottle(ip, start + 2500)
    expect(check.allowed).toBe(false)
    expect(check.reason).toBe('backoff')
    expect(check.retryAfterSec).toBeGreaterThanOrEqual(10)
  })

  it('allows again after the window rolls past 10 min', () => {
    const ip = '5.5.5.5'
    const base = Date.now()
    for (let i = 0; i < 10; i++) {
      recordFailure(ip, base + i * 1000)
    }
    const after = base + 11 * 60 * 1000
    expect(checkThrottle(ip, after).allowed).toBe(true)
  })
})
