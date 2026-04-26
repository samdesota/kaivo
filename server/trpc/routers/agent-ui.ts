import { TRPCError } from '@trpc/server'
import { observable } from '@trpc/server/observable'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { protectedProcedure, router } from '../trpc.js'
import {
  agentShellProcedure,
  resolveAgentSandboxId,
} from '../middleware/agent-shell-auth.js'
import { db } from '../../db/client.js'
import { agentSessions, shellSessions } from '../../db/schema.js'
import { resolveWorkspacePath, toWorkspaceRelative } from '../../fs/service.js'
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

async function resolveSessionId(sandboxId: string, opencodeSessionId: string): Promise<string> {
  const rows = await db
    .select({ id: agentSessions.id })
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.sandboxId, sandboxId),
        eq(agentSessions.opencodeSessionId, opencodeSessionId),
      ),
    )
    .limit(1)
  const row = rows[0]
  if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'agent session not found' })
  return row.id
}

async function assertShellInSandbox(shellId: string, sandboxId: string): Promise<void> {
  const info = terminalService.get(shellId)
  if (info) {
    if (info.sandboxId !== sandboxId) {
      throw new TRPCError({ code: 'FORBIDDEN', message: 'shell not in this sandbox' })
    }
    return
  }
  const rows = await db
    .select({ sandboxId: shellSessions.sandboxId })
    .from(shellSessions)
    .where(eq(shellSessions.id, shellId))
    .limit(1)
  const row = rows[0]
  if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'shell not found' })
  if (row.sandboxId !== sandboxId) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'shell not in this sandbox' })
  }
}

async function validateContent(sandboxId: string, content: AgentPaneContent): Promise<AgentPaneContent> {
  if (content.type === 'file') {
    const abs = resolveWorkspacePath(sandboxId, content.path)
    return { type: 'file', path: toWorkspaceRelative(sandboxId, abs) }
  }
  if (content.type === 'shell') {
    await assertShellInSandbox(content.shellId, sandboxId)
  }
  return content
}

export const agentUiRouter = router({
  openPane: agentShellProcedure
    .input(
      z.object({
        sandboxId: z.string().min(1).optional(),
        opencodeSessionId: z.string().min(1),
        content: paneContentSchema,
        title: z.string().min(1).max(120).optional(),
        activate: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const sandboxId = resolveAgentSandboxId(ctx, input.sandboxId)
      const sessionId = await resolveSessionId(sandboxId, input.opencodeSessionId)
      const content = await validateContent(sandboxId, input.content)
      publish({
        type: 'open_pane',
        sessionId,
        content,
        title: input.title,
        activate: input.activate ?? true,
      })
      return { ok: true as const }
    }),

  events: protectedProcedure
    .input(z.object({ sessionId: z.string().min(1) }))
    .subscription(({ input }) => {
      return observable<AgentUiEvent>((emit) => subscribe(input.sessionId, (evt) => emit.next(evt)))
    }),
})
