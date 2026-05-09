import { z } from 'zod'

export const paneContentSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('file'),
    path: z.string().min(1).max(4096),
    absolute: z.boolean().optional(),
  }),
  z.object({ type: z.literal('shell'), shellId: z.string().min(1) }),
  z.object({
    type: z.literal('browser'),
    url: z.string().min(1).max(4096).optional(),
    browserTabId: z.string().min(1).optional(),
  }),
])

export type AgentPaneContent = z.infer<typeof paneContentSchema>
