import type { WalkthroughModelSelection } from './contracts.js'

export interface WalkthroughMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export type WalkthroughModelStreamEvent =
  | { type: 'session'; sessionId: string }
  | { type: 'text-delta'; delta: string }
  | { type: 'finish' }

export interface WalkthroughModelRunInput {
  cwd: string
  model: WalkthroughModelSelection
  messages: WalkthroughMessage[]
  signal: AbortSignal
  sessionId?: string
}

export interface WalkthroughModelRunner {
  run(input: WalkthroughModelRunInput): AsyncIterable<WalkthroughModelStreamEvent>
}
