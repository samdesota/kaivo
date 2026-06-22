import type { PaneContent } from '../../shell/tab-state'
import { XTermAttached } from '../../xterm-attached'
import { useOpenState } from './open-state'
import {
  flattenParts,
  type Part,
  type TranscriptState,
} from '../transcript-store'
import { TextPart } from './text-part'
import { ReasoningPart } from './reasoning-part'
import { DiffView } from './diff-view'
import { DisclosureBody, DisclosureHeader } from './disclosure'

interface ToolState {
  status?: 'pending' | 'running' | 'completed' | 'error' | string
  input?: Record<string, unknown>
  output?: string
  error?: string
  metadata?: Record<string, unknown> & {
    kaivo_shell_id?: string
    kaivo_exit_code?: number
    cloudcode_shell_id?: string
    cloudcode_exit_code?: number
  }
  time?: { start?: number; end?: number }
}

export function ToolPart({
  part,
  sessionId,
  onOpenShell,
  childTranscript,
}: {
  part: Part
  sessionId: string
  onOpenShell?: (content: PaneContent) => void
  childTranscript?: TranscriptState
}) {
  const rawTool = (part as { tool?: string }).tool ?? 'tool'
  const tool = rawTool === 'kaivo_bash' ? 'bash' : rawTool === 'kaivo_pty' ? 'pty' : rawTool
  const callID = (part as { callID?: string }).callID ?? ''
  const state: ToolState = ((part as { state?: ToolState }).state ?? {}) as ToolState

  if (tool === 'bash') {
    return (
      <BashToolPart
        partId={part.id}
        callID={callID}
        state={state}
      />
    )
  }
  if (tool === 'pty') {
    return (
      <PtyToolPart
        state={state}
        onOpenShell={onOpenShell}
      />
    )
  }
  if (tool === 'apply_patch') {
    return (
      <ApplyPatchToolPart
        partId={part.id}
        state={state}
        onOpenShell={onOpenShell}
      />
    )
  }
  return (
    <GenericToolPart
      partId={part.id}
      tool={tool}
      state={state}
      sessionId={sessionId}
      childTranscript={childTranscript}
      onOpenShell={onOpenShell}
    />
  )
}

function ApplyPatchToolPart({
  state,
  onOpenShell,
}: {
  partId: string
  state: ToolState
  onOpenShell?: (content: PaneContent) => void
}) {
  const patchText = typeof state.input?.patchText === 'string' ? state.input.patchText : ''

  return (
    <div className="text-xs">
      {patchText ? (
        <DiffView diff={patchText} onOpenFile={(path) => onOpenShell?.({ type: 'file', path })} />
      ) : (
        <div className="text-[11px] text-help">
          {state.status === 'pending' ? 'Waiting for patch…' : 'No patch available.'}
        </div>
      )}
      {state.error && (
        <div className="mt-2 rounded border border-red-900 bg-red-950/50 p-2 font-mono text-[11px] text-red-300">
          {state.error}
        </div>
      )}
    </div>
  )
}

function durationMs(state: ToolState): number | null {
  const s = state.time?.start
  const e = state.time?.end
  if (typeof s === 'number' && typeof e === 'number' && e >= s) return e - s
  return null
}

function lastLine(s: string | undefined): string {
  if (!s) return ''
  const trimmed = s.replace(/\s+$/, '')
  const idx = trimmed.lastIndexOf('\n')
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed
}

function isPendingStatus(status?: string): boolean {
  return status === 'running' || status === 'pending'
}

function errorReason(state: ToolState): string | null {
  if (state.status !== 'error') return null
  return lastLine(state.error) || 'Tool call failed'
}

function ToolName({
  pending,
  className = '',
  children,
}: {
  pending: boolean
  className?: string
  children: React.ReactNode
}) {
  return (
    <span
      className={`inline-block min-w-0 ${className} ${
        pending ? 'tool-name-shimmer' : ''
      }`}
    >
      {children}
    </span>
  )
}

function BashToolPart({
  partId,
  callID,
  state,
}: {
  partId: string
  callID: string
  state: ToolState
}) {
  const running = isPendingStatus(state.status)
  const [open, setOpen] = useOpenState(`tool:${partId}`, running)
  const cmd = String((state.input as { command?: string } | undefined)?.command ?? '')
  const shellId = state.metadata?.kaivo_shell_id ?? state.metadata?.cloudcode_shell_id
  const exitCode =
    typeof state.metadata?.kaivo_exit_code === 'number'
      ? state.metadata.kaivo_exit_code
      : typeof state.metadata?.cloudcode_exit_code === 'number'
      ? state.metadata.cloudcode_exit_code
      : null
  const d = durationMs(state)
  const reason = errorReason(state)

  return (
    <div className="text-xs">
      <ToolHeader open={open} onToggle={() => setOpen((v) => !v)}>
        <span className="font-mono text-ui-default">$</span>
        <ToolName pending={running} className="truncate font-mono text-header-3">
          {cmd || '(no command)'}
        </ToolName>
        <span className="ml-auto flex shrink-0 items-center gap-2 text-[10px] text-ui-muted">
          {reason && (
            <span className="max-w-56 truncate text-red-400" title={state.error}>{reason}</span>
          )}
          {exitCode !== null && (
            <span className={exitCode === 0 ? 'text-ui-muted' : 'text-red-400'}>
              exit {exitCode}
            </span>
          )}
          {d !== null && <span>{(d / 1000).toFixed(1)}s</span>}
        </span>
      </ToolHeader>
      {!open && state.status === 'completed' && state.output && (
        <ToolBody>
          <div className="truncate font-mono text-[11px] text-help">
            {lastLine(state.output)}
          </div>
        </ToolBody>
      )}
      {open && (
        <ToolBody>
          {shellId && running ? (
            <div className="h-[32rem] resize-y overflow-hidden rounded border border-neutral-800 bg-black" style={{ minHeight: '12rem' }}>
              <XTermAttached key={shellId} shellId={shellId} />
            </div>
          ) : state.output ? (
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded border border-neutral-800 bg-black p-2 font-mono text-[11px] text-content-default">
              {state.output}
            </pre>
          ) : (
            <div className="text-[11px] text-help">
              {state.status === 'pending' ? 'Waiting to start…' : 'No output available.'}
            </div>
          )}
          {state.error && (
            <div className="mt-2 rounded border border-red-900 bg-red-950/50 p-2 font-mono text-[11px] text-red-300">
              {state.error}
            </div>
          )}
        </ToolBody>
      )}
      {!callID && null}
    </div>
  )
}

function ToolHeader({
  open,
  onToggle,
  children,
}: {
  open: boolean
  onToggle: () => void
  children: React.ReactNode
}) {
  return (
    <DisclosureHeader open={open} onToggle={onToggle}>
      {children}
    </DisclosureHeader>
  )
}

function ToolBody({ children }: { children: React.ReactNode }) {
  return <DisclosureBody>{children}</DisclosureBody>
}

function PtyToolPart({
  state,
  onOpenShell,
}: {
  state: ToolState
  onOpenShell?: (content: PaneContent) => void
}) {
  const shellId = state.metadata?.kaivo_shell_id ?? state.metadata?.cloudcode_shell_id
  const label =
    (state.input as { label?: string; cwd?: string } | undefined)?.label ??
    (state.input as { label?: string; cwd?: string } | undefined)?.cwd ??
    (shellId ? shellId.slice(-8) : 'shell')
  const running = isPendingStatus(state.status)
  const reason = errorReason(state)
  return (
    <div className="text-xs">
      <div className="flex items-center gap-2 py-0.5">
        <ToolName pending={running} className="text-content-default">
          Opened shell
        </ToolName>
        <span className="rounded bg-neutral-800 px-1.5 py-0.5 font-mono text-[11px] text-header-3">
          {label}
        </span>
        {reason && (
          <span className="max-w-56 truncate text-[10px] text-red-400" title={state.error}>{reason}</span>
        )}
        {shellId && onOpenShell && (
          <button
            onClick={() => onOpenShell({ type: 'shell', shellId })}
            className="ml-auto rounded border border-neutral-700 bg-neutral-900 px-2 py-0.5 text-[11px] text-header-3 hover:bg-neutral-800"
          >
            Open in Shells panel
          </button>
        )}
      </div>
    </div>
  )
}

function GenericToolPart({
  partId,
  tool,
  state,
  sessionId,
  childTranscript,
  onOpenShell,
}: {
  partId: string
  tool: string
  state: ToolState
  sessionId: string
  childTranscript?: TranscriptState
  onOpenShell?: (content: PaneContent) => void
}) {
  const running = isPendingStatus(state.status)
  const isTask = tool === 'task'
  const [open, setOpen] = useOpenState(`tool:${partId}`, isTask ? false : running)
  const taskDescription = isTask
    ? String((state.input as { description?: string } | undefined)?.description ?? '')
    : ''
  const filePath = (() => {
    if (!state.input) return ''
    const inp = state.input as { filePath?: unknown; path?: unknown; file_path?: unknown }
    const v = inp.filePath ?? inp.path ?? inp.file_path
    return typeof v === 'string' ? v : ''
  })()
  const showPath = filePath && /^(read|edit|write|patch|view|multiedit)$/i.test(tool)
  const globPattern =
    tool === 'glob' && typeof state.input?.pattern === 'string'
      ? state.input.pattern
      : ''
  const reason = errorReason(state)
  return (
    <div className="text-xs">
      <ToolHeader open={open} onToggle={() => setOpen((v) => !v)}>
        <ToolName pending={running} className="font-mono text-content-default">
          {tool}
        </ToolName>
        {globPattern && (
          <span className="min-w-0 truncate font-mono text-[11px] text-ui-default">
            {globPattern}
          </span>
        )}
        {isTask && taskDescription && (
          <span className="truncate text-[11px] text-ui-default">— {taskDescription}</span>
        )}
        {showPath && (
          <span
            className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-left font-mono text-[11px] text-ui-default"
            style={{ direction: 'rtl', unicodeBidi: 'plaintext' }}
            title={filePath}
          >
            {filePath}
          </span>
        )}
        {reason && (
          <span className="ml-auto max-w-56 truncate text-[10px] text-red-400" title={state.error}>{reason}</span>
        )}
      </ToolHeader>
      {open && isTask && (
        <ToolBody>
          <SubagentTranscript
            transcript={childTranscript}
            sessionId={sessionId}
            onOpenShell={onOpenShell}
          />
        </ToolBody>
      )}
      {open && !isTask && (
        <ToolBody>
          <div className="font-mono text-[11px]">
            {state.input && (
              <>
                <div className="mb-1 text-label">input</div>
                <pre className="mb-2 max-h-32 overflow-auto whitespace-pre-wrap text-ui-default">
                  {JSON.stringify(state.input, null, 2)}
                </pre>
              </>
            )}
            {state.output && (
              <>
                <div className="mb-1 text-label">output</div>
                <pre className="max-h-48 overflow-auto whitespace-pre-wrap text-content-default">
                  {state.output}
                </pre>
              </>
            )}
            {state.error && (
              <div className="mt-1 rounded border border-red-900 bg-red-950/50 p-2 text-red-300">
                {state.error}
              </div>
            )}
          </div>
        </ToolBody>
      )}
    </div>
  )
}

function SubagentTranscript({
  transcript,
  sessionId,
  onOpenShell,
}: {
  transcript?: TranscriptState
  sessionId: string
  onOpenShell?: (content: PaneContent) => void
}) {
  if (!transcript) {
    return (
      <div className="text-[11px] italic text-help">Waiting for subagent…</div>
    )
  }
  const parts = flattenParts(transcript)
  if (parts.length === 0) {
    return (
      <div className="text-[11px] italic text-help">Subagent has not produced output yet.</div>
    )
  }
  return (
    <div className="space-y-2">
      {parts.map((p) => {
        if (p.type === 'step-start' || p.type === 'step-finish' || p.type === 'snapshot') {
          return null
        }
        if ((p as { synthetic?: boolean }).synthetic) return null
        const role = transcript.messages.get(p.messageID)?.role ?? 'assistant'
        if (p.type === 'text') {
          return (
            <TextPart
              key={p.id}
              part={p}
              role={role}
              onOpenBrowserPane={(url) => onOpenShell?.({ type: 'browser', url })}
            />
          )
        }
        if (p.type === 'reasoning') return <ReasoningPart key={p.id} part={p} />
        if (p.type === 'tool') {
          return (
            <ToolPart
              key={p.id}
              part={p}
              sessionId={sessionId}
              onOpenShell={onOpenShell}
            />
          )
        }
        return (
          <div key={p.id} className="text-[10px] italic text-neutral-600">
            {p.type}
          </div>
        )
      })}
    </div>
  )
}
