export function chatDebug(label: string, data?: Record<string, unknown>): void {
  const enabled = typeof window !== 'undefined' && window.localStorage.getItem('chat-debug') === '1'
  if (!enabled || typeof console === 'undefined') return
  console.info(`[chat-debug] ${label}`, data ?? {})
}
