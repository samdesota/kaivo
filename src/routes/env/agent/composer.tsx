import { useState, useRef, useEffect, useMemo } from 'react'
import { envTrpc } from '../../../env-trpc'
import { extractTrpcMessage } from '../../../lib/utils'

interface CommandEntry {
  name: string
  description?: string | null
}

export function Composer({
  sessionId,
  pendingApprovalReason,
  running = false,
  onSent,
}: {
  sessionId: string
  pendingApprovalReason?: string | null
  running?: boolean
  onSent?: () => void
}) {
  const [text, setText] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [activeIdx, setActiveIdx] = useState(0)

  const send = envTrpc.agent.sessionSend.useMutation()
  const rename = envTrpc.agent.sessionRename.useMutation()
  const runCommand = envTrpc.agent.runCommand.useMutation()
  const abort = envTrpc.agent.sessionAbort.useMutation()
  const commands = envTrpc.agent.listCommands.useQuery(undefined, {
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  })
  const utils = envTrpc.useUtils()
  const taRef = useRef<HTMLTextAreaElement | null>(null)

  const entries = useMemo(() => {
    const list: SlashEntry[] = [
      {
        name: 'rename',
        description: 'Rename this session',
        argsHint: '<title>',
        source: 'ui',
      },
    ]
    for (const c of (commands.data as CommandEntry[] | undefined) ?? []) {
      list.push({
        name: c.name,
        description: c.description ?? '',
        argsHint: '',
        source: 'opencode',
      })
    }
    return list
  }, [commands.data])

  const { isSlash, cmdName, filtered } = useMemo(() => {
    const m = /^\/([\w-]*)/.exec(text)
    if (!m) return { isSlash: false, cmdName: '', filtered: [] as SlashEntry[] }
    const q = (m[1] ?? '').toLowerCase()
    return {
      isSlash: true,
      cmdName: m[1] ?? '',
      filtered: entries
        .filter((e) => e.name.toLowerCase().startsWith(q))
        .slice(0, 20),
    }
  }, [text, entries])

  useEffect(() => {
    setMenuOpen(isSlash && filtered.length > 0)
    setActiveIdx(0)
  }, [isSlash, filtered.length])

  useEffect(() => {
    const ta = taRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = Math.min(ta.scrollHeight, 200) + 'px'
  }, [text])

  function selectEntry(e: SlashEntry) {
    setText(`/${e.name} `)
    setMenuOpen(false)
    taRef.current?.focus()
  }

  async function runSlashCommand(raw: string): Promise<void> {
    const m = /^\/([\w-]+)\s*(.*)$/s.exec(raw)
    if (!m) throw new Error('bad slash command')
    const name = m[1]!
    const args = (m[2] ?? '').trim()
    if (name === 'rename') {
      if (!args) throw new Error('usage: /rename <new title>')
      await rename.mutateAsync({ sessionId, title: args })
      await utils.agent.sessionList.invalidate()
      return
    }
    const known = (commands.data as CommandEntry[] | undefined)?.find((c) => c.name === name)
    if (!known) throw new Error(`unknown command: /${name}`)
    await runCommand.mutateAsync({ sessionId, command: name, arguments: args })
  }

  async function onSend() {
    const msg = text.trim()
    if (!msg || send.isPending || pendingApprovalReason || running) return
    setErr(null)
    const snapshot = text
    setText('')
    try {
      if (msg.startsWith('/')) {
        await runSlashCommand(msg)
      } else {
        await send.mutateAsync({ sessionId, message: msg })
      }
      onSent?.()
    } catch (e) {
      setErr(extractTrpcMessage(e))
      setText(snapshot)
    }
  }

  async function onStop() {
    if (!running || abort.isPending) return
    setErr(null)
    try {
      await abort.mutateAsync({ sessionId })
    } catch (e) {
      setErr(extractTrpcMessage(e))
    }
  }

  const disabled =
    Boolean(pendingApprovalReason) ||
    send.isPending ||
    rename.isPending ||
    runCommand.isPending ||
    running

  return (
    <div className="relative border-t border-neutral-800 bg-neutral-950 p-2">
      {running && (
        <div className="mb-2 flex items-center gap-2 rounded border border-brand-500/40 bg-brand-500/5 px-2 py-1 text-[11px] text-brand-300">
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-brand-400 opacity-60" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-brand-400" />
          </span>
          <span>Agent is responding…</span>
          <span className="ml-auto text-[10px] text-neutral-500">esc to stop</span>
        </div>
      )}
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
      {menuOpen && (
        <SlashMenu
          entries={filtered}
          activeIdx={activeIdx}
          onHover={(i) => setActiveIdx(i)}
          onPick={selectEntry}
          query={cmdName}
        />
      )}
      <div className="flex items-end gap-2">
        <textarea
          ref={taRef}
          value={text}
          disabled={disabled}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (menuOpen) {
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setActiveIdx((i) => Math.min(filtered.length - 1, i + 1))
                return
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault()
                setActiveIdx((i) => Math.max(0, i - 1))
                return
              }
              if (e.key === 'Tab') {
                e.preventDefault()
                const chosen = filtered[activeIdx]
                if (chosen) selectEntry(chosen)
                return
              }
              if (e.key === 'Escape') {
                e.preventDefault()
                setMenuOpen(false)
                return
              }
            }
            if (e.key === 'Escape' && running) {
              e.preventDefault()
              void onStop()
              return
            }
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              void onSend()
            }
          }}
          placeholder={
            pendingApprovalReason
              ? 'Waiting on permission approval…'
              : running
                ? 'Agent is responding — esc to stop.'
                : 'Message the agent. Enter to send, Shift+Enter for newline. Type / for commands.'
          }
          rows={1}
          className="min-h-[32px] flex-1 resize-none rounded border border-neutral-800 bg-neutral-900 px-2 py-1.5 text-sm text-neutral-100 placeholder:text-neutral-600 focus:border-brand-500/60 focus:outline-none disabled:opacity-60"
        />
        {running ? (
          <button
            onClick={() => void onStop()}
            disabled={abort.isPending}
            title="Stop the agent (Esc)"
            className="rounded bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-500 disabled:opacity-50"
          >
            {abort.isPending ? 'Stopping…' : 'Stop'}
          </button>
        ) : (
          <button
            onClick={() => void onSend()}
            disabled={disabled || !text.trim()}
            className="rounded bg-brand-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-600 disabled:opacity-50"
          >
            {send.isPending || rename.isPending || runCommand.isPending ? '…' : 'Send'}
          </button>
        )}
      </div>
    </div>
  )
}

interface SlashEntry {
  name: string
  description: string
  argsHint: string
  source: 'ui' | 'opencode'
}

function SlashMenu({
  entries,
  activeIdx,
  onHover,
  onPick,
  query,
}: {
  entries: SlashEntry[]
  activeIdx: number
  onHover: (i: number) => void
  onPick: (e: SlashEntry) => void
  query: string
}) {
  if (entries.length === 0) {
    return (
      <div className="absolute bottom-full left-2 right-2 mb-1 rounded border border-neutral-800 bg-neutral-950 px-3 py-2 text-xs text-neutral-500 shadow-lg">
        No commands match <span className="font-mono">/{query}</span>
      </div>
    )
  }
  return (
    <div className="absolute bottom-full left-2 right-2 mb-1 max-h-64 overflow-auto rounded border border-neutral-800 bg-neutral-950 shadow-lg">
      {entries.map((e, i) => {
        const active = i === activeIdx
        return (
          <button
            key={`${e.source}:${e.name}`}
            onMouseEnter={() => onHover(i)}
            onMouseDown={(ev) => {
              ev.preventDefault()
              onPick(e)
            }}
            className={
              'flex w-full items-start gap-3 px-3 py-1.5 text-left text-xs transition-colors ' +
              (active ? 'bg-neutral-800 text-neutral-100' : 'text-neutral-300 hover:bg-neutral-900')
            }
          >
            <span className="shrink-0 font-mono text-neutral-100">/{e.name}</span>
            {e.argsHint && (
              <span className="shrink-0 font-mono text-[11px] text-neutral-500">{e.argsHint}</span>
            )}
            {e.description && (
              <span className="min-w-0 flex-1 truncate text-neutral-500">{e.description}</span>
            )}
            <span className="shrink-0 text-[10px] uppercase tracking-wide text-neutral-600">
              {e.source === 'ui' ? 'ui' : 'opencode'}
            </span>
          </button>
        )
      })}
    </div>
  )
}
