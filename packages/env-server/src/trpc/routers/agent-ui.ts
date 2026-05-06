import path from 'node:path'
import { TRPCError } from '@trpc/server'
import { observable } from '@trpc/server/observable'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { agentShellProcedure, authedProcedure, router } from '../trpc.js'
import { config } from '../../config.js'
import { db } from '../../db/client.js'
import { agentSessions } from '../../db/schema.js'
import { openPane as persistOpenPane } from '../../identity/client.js'
import { terminalService } from '../../terminal/service.js'
import { paneContentSchema, type AgentPaneContent } from './agent-ui-schema.js'

export interface AgentUiEvent {
  type: 'open_pane'
  sessionId: string
  content: AgentPaneContent
  title?: string
  activate: boolean
}

type Listener = (evt: AgentUiEvent) => void

const listenersBySession = new Map<string, Set<Listener>>()

function publish(evt: AgentUiEvent): void {
  const listeners = listenersBySession.get(evt.sessionId)
  if (!listeners) return
  for (const l of listeners) l(evt)
}

export async function openPaneForAgent(input: {
  opencodeSessionId: string
  content: AgentPaneContent
  title?: string
  activate?: boolean
}): Promise<{ ok: true }> {
  const session = resolveSession(input.opencodeSessionId)
  if (!session.workspaceId) {
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'agent session is not attached to a workspace' })
  }
  const content = validateContent(input.content, session.workingDir)
  const title = input.title?.trim() || undefined
  await persistOpenPane({
    workspaceId: session.workspaceId,
    envId: `local-${config.CC_INSTANCE_ID}`,
    content,
    title,
    activate: input.activate,
  })
  publish({
    type: 'open_pane',
    sessionId: session.id,
    content,
    title,
    activate: input.activate ?? true,
  })
  return { ok: true as const }
}

function subscribe(sessionId: string, listener: Listener): () => void {
  let listeners = listenersBySession.get(sessionId)
  if (!listeners) {
    listeners = new Set()
    listenersBySession.set(sessionId, listeners)
  }
  listeners.add(listener)
  return () => {
    listeners?.delete(listener)
    if (listeners?.size === 0) listenersBySession.delete(sessionId)
  }
}

function resolveSession(opencodeSessionId: string): { id: string; workspaceId: string | null; workingDir: string | null } {
  const row = db
    .select({ id: agentSessions.id, workspaceId: agentSessions.workspaceId, workingDir: agentSessions.workingDir })
    .from(agentSessions)
    .where(eq(agentSessions.opencodeSessionId, opencodeSessionId))
    .limit(1)
    .all()[0]
  if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'agent session not found' })
  return row
}

/**
 * Resolve an agent-supplied file path. Leading "/" means absolute filesystem
 * path; anything else is relative to the agent session's working_dir (and
 * falls back to CC_WORKING_DIR if the session has none). Always returns an
 * absolute path — the FE viewer reads via fs.read with absolute=true so the
 * file resolves regardless of where it sits relative to the workspace root.
 */
function resolveAgentFilePath(rawPath: string, sessionWorkingDir: string | null): string {
  if (path.isAbsolute(rawPath)) return path.resolve(rawPath)
  const base = sessionWorkingDir ?? config.CC_WORKING_DIR
  return path.resolve(base, rawPath)
}

function validateContent(content: AgentPaneContent, sessionWorkingDir: string | null): AgentPaneContent {
  if (content.type === 'file') {
    const abs = resolveAgentFilePath(content.path, sessionWorkingDir)
    return { type: 'file', path: abs, absolute: true }
  }
  if (content.type === 'shell') {
    const info = terminalService.get(content.shellId)
    if (!info) throw new TRPCError({ code: 'NOT_FOUND', message: 'shell not found' })
  }
  return content
}

export const agentUiRouter = router({
  openPane: agentShellProcedure
    .input(
      z.object({
        opencodeSessionId: z.string().min(1),
        content: paneContentSchema,
        title: z.string().max(120).optional(),
        activate: z.boolean().optional(),
      }),
    )
    .mutation(({ input }) => {
      return openPaneForAgent(input)
    }),

  events: authedProcedure
    .input(z.object({ sessionId: z.string().min(1) }))
    .subscription(({ input }) => {
      return observable<AgentUiEvent>((emit) => subscribe(input.sessionId, (evt) => emit.next(evt)))
    }),
})
