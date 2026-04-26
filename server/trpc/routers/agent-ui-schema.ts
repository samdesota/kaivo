import { z } from 'zod'

export const paneContentSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('file'), path: z.string().min(1).max(4096) }),
  z.object({ type: z.literal('shell'), shellId: z.string().min(1) }),
  z.object({ type: z.literal('preview'), port: z.number().int().min(1).max(65535) }),
  z.object({
    type: z.literal('browser'),
    url: z.string().min(1).max(4096).optional(),
    browserTabId: z.string().min(1).optional(),
  }),
])

export type AgentPaneContent = z.infer<typeof paneContentSchema>
