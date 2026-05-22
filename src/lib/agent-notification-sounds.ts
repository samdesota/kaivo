import { useCallback, useEffect, useState } from 'react'

export const AGENT_NOTIFICATION_SOUND_PRESETS = [
  { id: 'off', label: 'Off' },
  { id: 'beep-up', label: 'Beep up' },
  { id: 'soft-ding', label: 'Soft ding' },
  { id: 'bubble', label: 'Bubble pop' },
  { id: 'marimba', label: 'Marimba tap' },
] as const

export type AgentNotificationSoundId = typeof AGENT_NOTIFICATION_SOUND_PRESETS[number]['id']

export type AgentNotificationSoundPrefs = {
  soundId: AgentNotificationSoundId
  longRunThresholdSeconds: number
}

export const DEFAULT_AGENT_NOTIFICATION_SOUND_PREFS: AgentNotificationSoundPrefs = {
  soundId: 'beep-up',
  longRunThresholdSeconds: 30,
}

export const AGENT_RUN_DURATION_KEY_PREFIX = 'kaivo.agentRunDurationMs:'
const LEGACY_AGENT_RUN_DURATION_KEY_PREFIX = 'zoottle.agentRunDurationMs:'

const PREFS_KEY = 'kaivo.agentNotificationSoundPrefs'
const LEGACY_PREFS_KEY = 'zoottle.agentNotificationSoundPrefs'
const PREFS_EVENT = 'kaivo:agent-notification-sound-prefs'

export function readAgentNotificationSoundPrefs(): AgentNotificationSoundPrefs {
  if (typeof window === 'undefined') return DEFAULT_AGENT_NOTIFICATION_SOUND_PREFS
  try {
    const parsed = JSON.parse(readMigratedLocalStorage(PREFS_KEY, LEGACY_PREFS_KEY) ?? '{}') as Partial<AgentNotificationSoundPrefs>
    const soundId = AGENT_NOTIFICATION_SOUND_PRESETS.some((preset) => preset.id === parsed.soundId)
      ? parsed.soundId as AgentNotificationSoundId
      : DEFAULT_AGENT_NOTIFICATION_SOUND_PREFS.soundId
    const longRunThresholdSeconds = clampThreshold(parsed.longRunThresholdSeconds)
    return { soundId, longRunThresholdSeconds }
  } catch {
    return DEFAULT_AGENT_NOTIFICATION_SOUND_PREFS
  }
}

export function writeAgentNotificationSoundPrefs(prefs: AgentNotificationSoundPrefs): void {
  if (typeof window === 'undefined') return
  const next = { soundId: prefs.soundId, longRunThresholdSeconds: clampThreshold(prefs.longRunThresholdSeconds) }
  window.localStorage.setItem(PREFS_KEY, JSON.stringify(next))
  window.dispatchEvent(new CustomEvent(PREFS_EVENT, { detail: next }))
}

export function useAgentNotificationSoundPrefs(): [AgentNotificationSoundPrefs, (prefs: AgentNotificationSoundPrefs) => void] {
  const [prefs, setPrefs] = useState(readAgentNotificationSoundPrefs)
  useEffect(() => {
    function sync() {
      setPrefs(readAgentNotificationSoundPrefs())
    }
    window.addEventListener('storage', sync)
    window.addEventListener(PREFS_EVENT, sync)
    return () => {
      window.removeEventListener('storage', sync)
      window.removeEventListener(PREFS_EVENT, sync)
    }
  }, [])
  const save = useCallback((next: AgentNotificationSoundPrefs) => {
    writeAgentNotificationSoundPrefs(next)
    setPrefs(readAgentNotificationSoundPrefs())
  }, [])
  return [prefs, save]
}

export function recordAgentRunStarted(sessionId: string, startedAt = Date.now()): void {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(`${AGENT_RUN_DURATION_KEY_PREFIX}${sessionId}:startedAt`, String(startedAt))
}

export function recordAgentRunFinished(sessionId: string, finishedAt = Date.now()): number | null {
  if (typeof window === 'undefined') return null
  const key = `${AGENT_RUN_DURATION_KEY_PREFIX}${sessionId}:startedAt`
  const startedAt = Number(readMigratedLocalStorage(key, `${LEGACY_AGENT_RUN_DURATION_KEY_PREFIX}${sessionId}:startedAt`) ?? '')
  window.localStorage.removeItem(key)
  if (!Number.isFinite(startedAt) || startedAt <= 0) return null
  const durationMs = Math.max(0, finishedAt - startedAt)
  window.localStorage.setItem(`${AGENT_RUN_DURATION_KEY_PREFIX}${sessionId}:last`, String(durationMs))
  return durationMs
}

export function readLastAgentRunDurationMs(sessionId: string): number | null {
  if (typeof window === 'undefined') return null
  const value = Number(readMigratedLocalStorage(`${AGENT_RUN_DURATION_KEY_PREFIX}${sessionId}:last`, `${LEGACY_AGENT_RUN_DURATION_KEY_PREFIX}${sessionId}:last`) ?? '')
  return Number.isFinite(value) && value >= 0 ? value : null
}

function readMigratedLocalStorage(key: string, legacyKey: string): string | null {
  const value = window.localStorage.getItem(key)
  if (value !== null) return value
  const legacyValue = window.localStorage.getItem(legacyKey)
  if (legacyValue === null) return null
  window.localStorage.setItem(key, legacyValue)
  return legacyValue
}

export async function playAgentNotificationSound(soundId = readAgentNotificationSoundPrefs().soundId): Promise<void> {
  if (soundId === 'off') return
  const AudioContextCtor = window.AudioContext ?? (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!AudioContextCtor) return
  const ctx = new AudioContextCtor()
  const gain = ctx.createGain()
  gain.gain.value = 0.001
  gain.connect(ctx.destination)
  if (soundId === 'beep-up') playToneSequence(ctx, gain, [660, 880], 0.08, 'sine')
  else if (soundId === 'soft-ding') playToneSequence(ctx, gain, [1046, 1568], 0.18, 'sine')
  else if (soundId === 'bubble') playBubble(ctx, gain)
  else if (soundId === 'marimba') playToneSequence(ctx, gain, [523, 659, 784], 0.09, 'triangle')
  await new Promise((resolve) => setTimeout(resolve, 700))
  await ctx.close().catch(() => undefined)
}

function clampThreshold(value: unknown): number {
  const next = Math.round(Number(value))
  if (!Number.isFinite(next)) return DEFAULT_AGENT_NOTIFICATION_SOUND_PREFS.longRunThresholdSeconds
  return Math.min(3600, Math.max(0, next))
}

function playToneSequence(ctx: AudioContext, gain: GainNode, freqs: number[], step: number, type: OscillatorType): void {
  const start = ctx.currentTime
  for (let i = 0; i < freqs.length; i += 1) {
    const osc = ctx.createOscillator()
    osc.type = type
    osc.frequency.value = freqs[i] ?? 440
    osc.connect(gain)
    const t = start + i * step
    gain.gain.setValueAtTime(0.001, t)
    gain.gain.exponentialRampToValueAtTime(0.08, t + 0.015)
    gain.gain.exponentialRampToValueAtTime(0.001, t + step)
    osc.start(t)
    osc.stop(t + step + 0.02)
  }
}

function playBubble(ctx: AudioContext, gain: GainNode): void {
  const start = ctx.currentTime
  for (let i = 0; i < 4; i += 1) {
    const osc = ctx.createOscillator()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(520 + i * 95, start + i * 0.035)
    osc.frequency.exponentialRampToValueAtTime(760 + i * 100, start + i * 0.035 + 0.06)
    osc.connect(gain)
    const t = start + i * 0.035
    gain.gain.setValueAtTime(0.001, t)
    gain.gain.exponentialRampToValueAtTime(0.05, t + 0.01)
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.075)
    osc.start(t)
    osc.stop(t + 0.08)
  }
}
