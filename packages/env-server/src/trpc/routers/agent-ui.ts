import { TRPCError } from '@trpc/server'
import { observable } from '@trpc/server/observable'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { agentShellProcedure, authedProcedure, router } from '../trpc.js'
import { db } from '../../db/client.js'
import { agentSessions } from '../../db/schema.js'
import { resolveWorkspacePath, toWorkspaceRelative } from '../../fs/service.js'
import { terminalService } from '../../terminal/service.js'

const paneContentSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('file'), path: z.string().min(1).max(4096) }),
  z.object({ type: z.literal('shell'), shellId: z.string().min(1) }),
  z.object({ type: z.literal('preview'), port: z.number().int().min(1).max(65535) }),
])

export type AgentPaneContent = z.infer<typeof paneContentSchema>

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

function resolveSessionId(opencodeSessionId: string): string {
  const row = db
    .select({ id: agentSessions.id })
    .from(agentSessions)
    .where(eq(agentSessions.opencodeSessionId, opencodeSessionId))
    .limit(1)
    .all()[0]
  if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'agent session not found' })
  return row.id
}

function validateContent(content: AgentPaneContent): AgentPaneContent {
  if (content.type === 'file') {
    const abs = resolveWorkspacePath(content.path)
    return { type: 'file', path: toWorkspaceRelative(abs) }
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
        title: z.string().min(1).max(120).optional(),
        activate: z.boolean().optional(),
      }),
    )
    .mutation(({ input }) => {
      const sessionId = resolveSessionId(input.opencodeSessionId)
      const content = validateContent(input.content)
      publish({
        type: 'open_pane',
        sessionId,
        content,
        title: input.title,
        activate: input.activate ?? true,
      })
      return { ok: true as const }
    }),

  events: authedProcedure
    .input(z.object({ sessionId: z.string().min(1) }))
    .subscription(({ input }) => {
      return observable<AgentUiEvent>((emit) => subscribe(input.sessionId, (evt) => emit.next(evt)))
    }),
})
