export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence'

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id?: string; name: string; input: Record<string, unknown> }

export interface Turn {
  blocks: ContentBlock[]
  stopReason?: StopReason
}

export interface Script {
  turns: Turn[]
  fallback?: Turn
}

export interface LoggedRequest {
  method: string
  url: string
  headers: Record<string, string>
  body: unknown
  timestamp: number
}
