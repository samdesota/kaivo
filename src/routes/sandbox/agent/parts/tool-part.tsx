import { useState } from 'react'
import type { PaneContent } from '../../shell/tab-state'
import { XTermAttached } from '../../xterm-attached'
import { PermissionBanner } from './permission-banner'
import {
  flattenParts,
  permissionForCall,
  type PermissionRequest,
  type Part,
  type TranscriptState,
} from '../transcript-store'
import { TextPart } from './text-part'
import { ReasoningPart } from './reasoning-part'

interface ToolState {
  status?: 'pending' | 'running' | 'completed' | 'error' | string
  input?: Record<string, unknown>
  output?: string
  error?: string
  metadata?: Record<string, unknown> & {
    cloudcode_shell_id?: string
    cloudcode_exit_code?: number
  }
  time?: { start?: number; end?: number }
}

export function ToolPart({
  part,
  permission,
  sessionId,
  sandboxId,
  onOpenShell,
  childTranscript,
}: {
  part: Part
  permission?: PermissionRequest
  sessionId: string
  sandboxId: string
  onOpenShell?: (content: PaneContent) => void
  childTranscript?: TranscriptState
}) {
  // cloud_bash/cloud_pty are functionally bash/pty from the user's POV; we
  // already collapsed the visual treatment, so normalize the label too.
  const rawTool = (part as { tool?: string }).tool ?? 'tool'
  const tool = rawTool === 'cloud_bash' ? 'bash' : rawTool === 'cloud_pty' ? 'pty' : rawTool
  const callID = (part as { callID?: string }).callID ?? ''
  const state: ToolState = ((part as { state?: ToolState }).state ?? {}) as ToolState

  if (tool === 'bash') {
    return (
      <BashToolPart
        callID={callID}
        state={state}
        permission={permission}
        sessionId={sessionId}
      />
    )
  }
  if (tool === 'pty') {
    return (
      <PtyToolPart
        state={state}
        permission={permission}
        sessionId={sessionId}
        onOpenShell={onOpenShell}
      />
    )
  }
  return (
    <GenericToolPart
      tool={tool}
      state={state}
      permission={permission}
      sessionId={sessionId}
      sandboxId={sandboxId}
      childTranscript={childTranscript}
      onOpenShell={onOpenShell}
    />
  )
}

function StatusDot({ status }: { status?: string }) {
  const cls =
    status === 'running' || status === 'pending'
      ? 'bg-brand-500 animate-pulse'
      : status === 'error'
        ? 'bg-red-500'
        : status === 'completed'
          ? 'bg-emerald-500'
          : 'bg-neutral-600'
  return <span className={`inline-block h-2 w-2 rounded-full ${cls}`} />
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

function BashToolPart({
  callID,
  state,
  permission,
  sessionId,
}: {
  callID: string
  state: ToolState
  permission?: PermissionRequest
  sessionId: string
}) {
  const running = state.status === 'running' || state.status === 'pending'
  // Auto-expand while the command is running so the user can watch output
  // stream in without having to click. Once complete the user's manual
  // toggle state (if any) takes over.
  const [manual, setManual] = useState<boolean | null>(null)
  const open = manual ?? running
  const setOpen = (v: boolean | ((prev: boolean) => boolean)) => {
    setManual((prev) => {
      const curr = prev ?? running
      return typeof v === 'function' ? (v as (x: boolean) => boolean)(curr) : v
    })
  }
  const cmd = String((state.input as { command?: string } | undefined)?.command ?? '')
  const shellId = state.metadata?.cloudcode_shell_id
  const exitCode =
    typeof state.metadata?.cloudcode_exit_code === 'number'
      ? state.metadata.cloudcode_exit_code
      : null
  const d = durationMs(state)

  return (
    <div className="text-xs">
      <ToolHeader open={open} onToggle={() => setOpen((v) => !v)} status={state.status}>
        <span className="font-mono text-neutral-400">$</span>
        <span className="truncate font-mono text-neutral-200">{cmd || '(no command)'}</span>
        <span className="ml-auto flex shrink-0 items-center gap-2 text-[10px] text-neutral-500">
          {exitCode !== null && (
            <span className={exitCode === 0 ? 'text-neutral-500' : 'text-red-400'}>
              exit {exitCode}
            </span>
          )}
          {d !== null && <span>{(d / 1000).toFixed(1)}s</span>}
        </span>
      </ToolHeader>
      {!open && state.status === 'completed' && state.output && (
        <ToolBody>
          <div className="truncate font-mono text-[11px] text-neutral-500">
            {lastLine(state.output)}
          </div>
        </ToolBody>
      )}
      {open && (
        <ToolBody>
          {shellId ? (
            <div className="h-[32rem] resize-y overflow-hidden rounded border border-neutral-800 bg-black" style={{ minHeight: '12rem' }}>
              <XTermAttached key={shellId} shellId={shellId} />
            </div>
          ) : state.output ? (
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded border border-neutral-800 bg-black p-2 font-mono text-[11px] text-neutral-300">
              {state.output}
            </pre>
          ) : (
            <div className="text-[11px] text-neutral-500">
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
      {permission && (
        <ToolBody>
          <PermissionBanner req={permission} sessionId={sessionId} />
        </ToolBody>
      )}
      {!callID && null}
    </div>
  )
}

/**
 * Header row used by every tool variant. Renders the chevron in a fixed
 * 12px slot so children of <ToolBody> can draw a `border-l` aligned to the
 * chevron's center, producing a visual "branch" line under the tool.
 */
function ToolHeader({
  open,
  onToggle,
  status,
  children,
}: {
  open: boolean
  onToggle: () => void
  status?: string
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onToggle}
      className="flex w-full items-center gap-2 rounded py-0.5 text-left hover:bg-neutral-900/40"
    >
      <span className="inline-flex w-3 justify-center font-mono text-neutral-500">
        {open ? '▾' : '▸'}
      </span>
      <StatusDot status={status} />
      {children}
    </button>
  )
}

/**
 * Body slot rendered under a ToolHeader. Indented so its `border-l` sits
 * vertically aligned with the chevron's center, giving each open tool a
 * subtle branch line down to the bottom of its content.
 */
function ToolBody({ children }: { children: React.ReactNode }) {
  return (
    <div className="ml-[5px] border-l border-neutral-800 pl-3 pt-1">
      {children}
    </div>
  )
}

function PtyToolPart({
  state,
  permission,
  sessionId,
  onOpenShell,
}: {
  state: ToolState
  permission?: PermissionRequest
  sessionId: string
  onOpenShell?: (content: PaneContent) => void
}) {
  const shellId = state.metadata?.cloudcode_shell_id
  const label =
    (state.input as { label?: string; cwd?: string } | undefined)?.label ??
    (state.input as { label?: string; cwd?: string } | undefined)?.cwd ??
    (shellId ? shellId.slice(-8) : 'shell')
  return (
    <div className="text-xs">
      <div className="flex items-center gap-2 py-0.5">
        <span className="inline-flex w-3 justify-center font-mono text-neutral-700">·</span>
        <StatusDot status={state.status} />
        <span className="text-neutral-300">Opened shell</span>
        <span className="rounded bg-neutral-800 px-1.5 py-0.5 font-mono text-[11px] text-neutral-200">
          {label}
        </span>
        {shellId && onOpenShell && (
          <button
            onClick={() => onOpenShell({ type: 'shell', shellId })}
            className="ml-auto rounded border border-neutral-700 bg-neutral-900 px-2 py-0.5 text-[11px] text-neutral-200 hover:bg-neutral-800"
          >
            Open in Shells panel
          </button>
        )}
      </div>
      {permission && (
        <ToolBody>
          <PermissionBanner req={permission} sessionId={sessionId} />
        </ToolBody>
      )}
    </div>
  )
}

function GenericToolPart({
  tool,
  state,
  permission,
  sessionId,
  sandboxId,
  childTranscript,
  onOpenShell,
}: {
  tool: string
  state: ToolState
  permission?: PermissionRequest
  sessionId: string
  sandboxId: string
  childTranscript?: TranscriptState
  onOpenShell?: (content: PaneContent) => void
}) {
  const running = state.status === 'running' || state.status === 'pending'
  // Auto-expand while running so the user can watch state stream in. After
  // completion, manual toggle takes over (stays open if user opened, closes
  // otherwise).
  const [manual, setManual] = useState<boolean | null>(null)
  const open = manual ?? running
  const setOpen = (v: boolean | ((prev: boolean) => boolean)) => {
    setManual((prev) => {
      const curr = prev ?? running
      return typeof v === 'function' ? (v as (x: boolean) => boolean)(curr) : v
    })
  }
  const isTask = tool === 'task'
  const taskDescription = isTask
    ? String((state.input as { description?: string } | undefined)?.description ?? '')
    : ''
  // Surface the target path on file-touching tools so the tool list stays
  // scannable without expanding each row. Truncated from the left (rtl)
  // so the basename always wins for visibility.
  const filePath = (() => {
    if (!state.input) return ''
    const inp = state.input as { filePath?: unknown; path?: unknown; file_path?: unknown }
    const v = inp.filePath ?? inp.path ?? inp.file_path
    return typeof v === 'string' ? v : ''
  })()
  const showPath = filePath && /^(read|edit|write|patch|view|multiedit)$/i.test(tool)
  return (
    <div className="text-xs">
      <ToolHeader open={open} onToggle={() => setOpen((v) => !v)} status={state.status}>
        <span className="font-mono text-neutral-300">{tool}</span>
        {isTask && taskDescription && (
          <span className="truncate text-[11px] text-neutral-400">— {taskDescription}</span>
        )}
        {showPath && (
          <span
            className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-left font-mono text-[11px] text-neutral-400"
            style={{ direction: 'rtl', unicodeBidi: 'plaintext' }}
            title={filePath}
          >
            {filePath}
          </span>
        )}
        <span className="ml-auto text-[10px] text-neutral-500">{state.status ?? 'idle'}</span>
      </ToolHeader>
      {open && isTask && (
        <ToolBody>
          <SubagentTranscript
            transcript={childTranscript}
            sessionId={sessionId}
            sandboxId={sandboxId}
            onOpenShell={onOpenShell}
          />
        </ToolBody>
      )}
      {open && !isTask && (
        <ToolBody>
          <div className="font-mono text-[11px]">
            {state.input && (
              <>
                <div className="mb-1 text-neutral-500">input</div>
                <pre className="mb-2 max-h-32 overflow-auto whitespace-pre-wrap text-neutral-400">
                  {JSON.stringify(state.input, null, 2)}
                </pre>
              </>
            )}
            {state.output && (
              <>
                <div className="mb-1 text-neutral-500">output</div>
                <pre className="max-h-48 overflow-auto whitespace-pre-wrap text-neutral-300">
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
      {permission && (
        <ToolBody>
          <PermissionBanner req={permission} sessionId={sessionId} />
        </ToolBody>
      )}
    </div>
  )
}

/**
 * Inline transcript of the subagent spawned by a `task` tool call. Renders
 * the child session's parts (text/reasoning/tool) without recursing into
 * further nested subagents — opencode supports nesting but in practice it
 * rarely happens, and avoiding the recursion keeps the UI bounded.
 */
function SubagentTranscript({
  transcript,
  sessionId,
  sandboxId,
  onOpenShell,
}: {
  transcript?: TranscriptState
  sessionId: string
  sandboxId: string
  onOpenShell?: (content: PaneContent) => void
}) {
  if (!transcript) {
    return (
      <div className="text-[11px] italic text-neutral-500">Waiting for subagent…</div>
    )
  }
  const parts = flattenParts(transcript)
  if (parts.length === 0) {
    return (
      <div className="text-[11px] italic text-neutral-500">Subagent has not produced output yet.</div>
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
        if (p.type === 'text') return <TextPart key={p.id} part={p} role={role} />
        if (p.type === 'reasoning') return <ReasoningPart key={p.id} part={p} />
        if (p.type === 'tool') {
          const callID = (p as { callID?: string }).callID
          const perm = callID ? permissionForCall(transcript, callID) : undefined
          return (
            <ToolPart
              key={p.id}
              part={p}
              permission={perm}
              sessionId={sessionId}
              sandboxId={sandboxId}
              onOpenShell={onOpenShell}
              // Don't pass childTranscript — keeps recursion to one level.
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
