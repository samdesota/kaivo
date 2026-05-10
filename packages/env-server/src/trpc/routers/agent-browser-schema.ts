import { z } from 'zod'

export const MAX_BROWSER_URL_LENGTH = 4096
export const MAX_JAVASCRIPT_EXPRESSION_LENGTH = 20_000
export const MAX_JAVASCRIPT_TIMEOUT_MS = 10_000
export const MAX_POST_SNAPSHOT_WAIT_MS = 5_000

export const browserErrorCodeSchema = z.enum([
  'browser_tools_unavailable',
  'browser_tab_closed',
  'browser_connection_not_found',
  'element_id_not_found',
  'unsafe_url',
  'unsafe_javascript',
  'payload_too_large',
  'invalid_action',
])

export type BrowserErrorCode = z.infer<typeof browserErrorCodeSchema>

export const cdpIdSchema = z.string().trim().min(1).max(200)
export const browserTabIdSchema = z.string().trim().min(1).max(200)
export const elementIdSchema = z.string().trim().min(1).max(200)

export function normalizeBrowserToolUrl(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) throw new Error('url is required')
  if (trimmed === 'about:blank') return trimmed
  if (trimmed.startsWith('localhost') || /^\d{1,3}(\.\d{1,3}){3}(:\d+)?/.test(trimmed)) {
    return `http://${trimmed}`
  }
  if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(trimmed)) return trimmed
  return `https://${trimmed}`
}

export function isSafeBrowserToolUrl(raw: string): boolean {
  let parsed: URL
  try {
    const normalized = normalizeBrowserToolUrl(raw)
    if (normalized === 'about:blank') return true
    parsed = new URL(normalized)
  } catch {
    return false
  }
  return parsed.protocol === 'http:' || parsed.protocol === 'https:'
}

export const safeBrowserUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_BROWSER_URL_LENGTH)
  .transform((value) => normalizeBrowserToolUrl(value))
  .refine((value) => isSafeBrowserToolUrl(value), 'unsafe browser URL')

export const browserConnectionSchema = z.object({
  cdpId: cdpIdSchema,
  browserTabId: browserTabIdSchema,
  url: z.string().min(1).max(MAX_BROWSER_URL_LENGTH),
  title: z.string().max(500),
  connectedAt: z.string().datetime(),
})

export const browserTabSummarySchema = z.object({
  browserTabId: browserTabIdSchema,
  url: z.string().min(1).max(MAX_BROWSER_URL_LENGTH),
  title: z.string().max(500),
  active: z.boolean(),
  connected: z.boolean(),
  connectedByCurrentAgent: z.boolean(),
})

export const listTabsInputSchema = z.object({
  sandboxId: z.string().min(1).optional(),
  opencodeSessionId: z.string().min(1),
})

export const connectTabInputSchema = listTabsInputSchema.extend({
  browserTabId: browserTabIdSchema,
})

export const openAndConnectInputSchema = listTabsInputSchema.extend({
  url: safeBrowserUrlSchema,
  title: z.string().min(1).max(120).optional(),
  activate: z.boolean().optional(),
})

export const cdpConnectionInputSchema = listTabsInputSchema.extend({
  cdpId: cdpIdSchema,
})

export const snapshotInputFieldsSchema = z.object({
  filter: z.string().min(1).max(1_000).optional(),
  filterFlags: z.string().min(1).max(20).optional(),
  viewportOnly: z.boolean().optional(),
})

export const snapshotInputSchema = cdpConnectionInputSchema.merge(snapshotInputFieldsSchema)

export const snapshotOutputSchema = z.object({
  url: z.string().min(1).max(MAX_BROWSER_URL_LENGTH),
  title: z.string().max(500),
  interactiveCount: z.number().int().min(0),
  durationMs: z.number().min(0),
  text: z.string(),
})

export const interactActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('click'), elementId: elementIdSchema }),
  z.object({ type: z.literal('type'), elementId: elementIdSchema, text: z.string(), clear: z.boolean().optional() }),
  z.object({
    type: z.literal('fill'),
    fields: z.array(z.object({ elementId: elementIdSchema, text: z.string(), clear: z.boolean().optional() })).min(1),
  }),
  z.object({ type: z.literal('scroll'), x: z.number().finite().optional(), y: z.number().finite().optional() }),
  z.object({ type: z.literal('goto'), url: safeBrowserUrlSchema }),
  z.object({ type: z.literal('back') }),
  z.object({ type: z.literal('forward') }),
  z.object({
    type: z.literal('wait'),
    ms: z.number().int().min(0).max(MAX_POST_SNAPSHOT_WAIT_MS).optional(),
    until: z.enum(['load', 'settle']).optional(),
  }),
])

export const postSnapshotSchema = z.union([
  z.literal(false),
  z.object({
    wait: z.enum(['none', 'load', 'settle']).optional(),
    waitMs: z.number().int().min(0).max(MAX_POST_SNAPSHOT_WAIT_MS).optional(),
    filter: z.string().min(1).max(1_000).optional(),
    filterFlags: z.string().min(1).max(20).optional(),
    viewportOnly: z.boolean().optional(),
  }),
])

export const interactInputSchema = cdpConnectionInputSchema.extend({
  action: interactActionSchema,
  postSnapshot: postSnapshotSchema.optional(),
})

export const interactOutputSchema = z.object({
  ok: z.boolean(),
  action: interactActionSchema,
  url: z.string().min(1).max(MAX_BROWSER_URL_LENGTH),
  title: z.string().max(500),
  error: z.string().optional(),
  snapshot: snapshotOutputSchema.optional(),
})

export const screenshotInputSchema = cdpConnectionInputSchema.extend({
  format: z.enum(['jpeg', 'png']).optional(),
  quality: z.number().int().min(1).max(100).optional(),
  fullPage: z.boolean().optional(),
})

export const screenshotOutputSchema = z.object({
  format: z.enum(['jpeg', 'png']),
  width: z.number().int().min(1),
  height: z.number().int().min(1),
  base64: z.string(),
  byteLength: z.number().int().min(0),
})

export const executeJsInputSchema = cdpConnectionInputSchema.extend({
  expression: z.string().min(1).max(MAX_JAVASCRIPT_EXPRESSION_LENGTH),
  awaitPromise: z.boolean().optional(),
  timeoutMs: z.number().int().min(1).max(MAX_JAVASCRIPT_TIMEOUT_MS).optional(),
})

export const executeJsOutputSchema = z.object({
  type: z.string().min(1),
  value: z.unknown().optional(),
  unserializableValue: z.string().optional(),
  exception: z.string().optional(),
})

export const readLogsInputSchema = cdpConnectionInputSchema.extend({
  maxEntries: z.number().int().min(1).max(500).optional(),
})

export const browserLogEntrySchema = z.object({
  ts: z.string().datetime(),
  level: z.string().min(1),
  message: z.string(),
  line: z.number().int().optional(),
  sourceId: z.string().optional(),
})

export const readLogsOutputSchema = z.object({
  entries: z.array(browserLogEntrySchema),
  truncated: z.boolean(),
})

export type BrowserConnection = z.infer<typeof browserConnectionSchema>
export type BrowserTabSummary = z.infer<typeof browserTabSummarySchema>
export type InteractAction = z.infer<typeof interactActionSchema>
export type SnapshotOutput = z.infer<typeof snapshotOutputSchema>
export type InteractOutput = z.infer<typeof interactOutputSchema>
export type ScreenshotOutput = z.infer<typeof screenshotOutputSchema>
export type ExecuteJsOutput = z.infer<typeof executeJsOutputSchema>
export type BrowserLogEntry = z.infer<typeof browserLogEntrySchema>
export type ReadLogsOutput = z.infer<typeof readLogsOutputSchema>
