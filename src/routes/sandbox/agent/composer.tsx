import { useState, useRef, useEffect } from 'react'
import { trpc } from '../../../trpc'
import { extractTrpcMessage } from '../../../lib/utils'

export function Composer({
  sessionId,
  pendingApprovalReason,
}: {
  sessionId: string
  /** When set, the composer is disabled and this is shown as a banner. */
  pendingApprovalReason?: string | null
}) {
  const [text, setText] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const send = trpc.agent.sessionSend.useMutation()
  const taRef = useRef<HTMLTextAreaElement | null>(null)

  // Auto-grow.
  useEffect(() => {
    const ta = taRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = Math.min(ta.scrollHeight, 200) + 'px'
  }, [text])

  async function onSend() {
    const msg = text.trim()
    if (!msg || send.isPending || pendingApprovalReason) return
    setErr(null)
    const snapshot = text
    setText('')
    try {
      await send.mutateAsync({ sessionId, message: msg })
    } catch (e) {
      setErr(extractTrpcMessage(e))
      setText(snapshot)
    }
  }

  const disabled = Boolean(pendingApprovalReason) || send.isPending

  return (
    <div className="border-t border-neutral-800 bg-neutral-950 p-2">
      {pendingApprovalReason && (
        <div className="mb-2 rounded border border-amber-500/40 bg-amber-500/5 px-2 py-1 text-[11px] text-amber-200">
          {pendingApprovalReason}
        </div>
      )}
      {err && (
        <div className="mb-2 rounded border border-red-900 bg-red-950/50 px-2 py-1 text-[11px] text-red-300">
          {err}
        </div>
      )}
      <div className="flex items-end gap-2">
        <textarea
          ref={taRef}
          value={text}
          disabled={disabled}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              void onSend()
            }
          }}
          placeholder={
            pendingApprovalReason
              ? 'Waiting on permission approval…'
              : 'Message the agent. Enter to send, Shift+Enter for newline.'
          }
          rows={1}
          className="min-h-[32px] flex-1 resize-none rounded border border-neutral-800 bg-neutral-900 px-2 py-1.5 text-sm text-neutral-100 placeholder:text-neutral-600 focus:border-brand-500/60 focus:outline-none disabled:opacity-60"
        />
        <button
          onClick={() => void onSend()}
          disabled={disabled || !text.trim()}
          className="rounded bg-brand-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-600 disabled:opacity-50"
        >
          {send.isPending ? 'Sending…' : 'Send'}
        </button>
      </div>
    </div>
  )
}
