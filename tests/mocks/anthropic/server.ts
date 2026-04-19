import http from 'node:http'
import { once } from 'node:events'
import { randomBytes } from 'node:crypto'
import type { LoggedRequest, Script, Turn } from './types.js'

export type { ContentBlock, Script, Turn, StopReason, LoggedRequest } from './types.js'

export interface MockHandle {
  readonly url: string
  readonly port: number
  setScript(s: Script): void
  pushTurn(t: Turn): void
  getRequests(): LoggedRequest[]
  reset(): void
  close(): Promise<void>
}

export interface CreateMockOpts {
  port?: number
  host?: string
}

const CONTROL_PATHS = new Set(['/__script', '/__reset', '/__requests', '/__health'])

export async function createAnthropicMock(opts: CreateMockOpts = {}): Promise<MockHandle> {
  let script: Script = { turns: [] }
  let turnIndex = 0
  const requests: LoggedRequest[] = []

  const nextTurn = (): Turn => {
    const t = script.turns[turnIndex]
    if (t) {
      turnIndex++
      return t
    }
    return (
      script.fallback ?? { blocks: [{ type: 'text', text: 'done' }], stopReason: 'end_turn' }
    )
  }

  const server = http.createServer((req, res) => {
    void handle(req, res).catch((err) => {
      try {
        respondJson(res, 500, {
          error: { type: 'internal_error', message: (err as Error).message },
        })
      } catch {
        /* ignore */
      }
    })
  })

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const method = req.method ?? ''
    const url = req.url ?? ''
    const path = url.split('?')[0] ?? ''

    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(Buffer.from(c))
    const raw = Buffer.concat(chunks).toString('utf8')
    let parsed: unknown = undefined
    if (raw.length > 0) {
      try {
        parsed = JSON.parse(raw)
      } catch {
        parsed = raw
      }
    }

    if (!CONTROL_PATHS.has(path)) {
      requests.push({
        method,
        url,
        headers: flattenHeaders(req.headers),
        body: parsed,
        timestamp: Date.now(),
      })
    }

    if (method === 'GET' && path === '/__health') {
      respondJson(res, 200, { ok: true })
      return
    }
    if (method === 'POST' && path === '/__script') {
      if (!parsed || typeof parsed !== 'object') {
        respondJson(res, 400, { error: 'invalid script body' })
        return
      }
      script = parsed as Script
      turnIndex = 0
      respondJson(res, 200, { ok: true })
      return
    }
    if (method === 'POST' && path === '/__reset') {
      script = { turns: [] }
      turnIndex = 0
      requests.length = 0
      respondJson(res, 200, { ok: true })
      return
    }
    if (method === 'GET' && path === '/__requests') {
      respondJson(res, 200, requests)
      return
    }

    if (method === 'POST' && path === '/v1/messages') {
      const body = (parsed ?? {}) as {
        stream?: boolean
        model?: string
      }
      const turn = nextTurn()
      const messageId = `msg_${randomBytes(12).toString('hex')}`
      const model = body.model ?? 'claude-3-5-sonnet-20241022'
      const stopReason =
        turn.stopReason ?? (hasToolUse(turn) ? 'tool_use' : 'end_turn')

      if (body.stream) {
        await streamResponse(res, turn, { messageId, model, stopReason })
      } else {
        respondMessage(res, turn, { messageId, model, stopReason })
      }
      return
    }

    respondJson(res, 404, {
      error: { type: 'not_found_error', message: `${method} ${url}` },
    })
  }

  server.listen(opts.port ?? 0, opts.host ?? '127.0.0.1')
  await once(server, 'listening')
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('anthropic mock: no address')
  const port = addr.port
  const host = opts.host ?? '127.0.0.1'

  return {
    url: `http://${host}:${port}`,
    port,
    setScript(s) {
      script = s
      turnIndex = 0
    },
    pushTurn(t) {
      script = { ...script, turns: [...script.turns, t] }
    },
    getRequests() {
      return requests.slice()
    },
    reset() {
      script = { turns: [] }
      turnIndex = 0
      requests.length = 0
    },
    async close() {
      server.closeAllConnections?.()
      server.close()
      await once(server, 'close').catch(() => {})
    },
  }
}

interface ResponseMeta {
  messageId: string
  model: string
  stopReason: string
}

function respondJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

function respondMessage(res: http.ServerResponse, turn: Turn, meta: ResponseMeta): void {
  const content = turn.blocks.map((b) => {
    if (b.type === 'text') return { type: 'text', text: b.text }
    return {
      type: 'tool_use',
      id: b.id ?? `toolu_${randomBytes(12).toString('hex')}`,
      name: b.name,
      input: b.input,
    }
  })
  respondJson(res, 200, {
    id: meta.messageId,
    type: 'message',
    role: 'assistant',
    content,
    model: meta.model,
    stop_reason: meta.stopReason,
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: estimateTokens(turn) },
  })
}

async function streamResponse(
  res: http.ServerResponse,
  turn: Turn,
  meta: ResponseMeta,
): Promise<void> {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })

  sse(res, 'message_start', {
    type: 'message_start',
    message: {
      id: meta.messageId,
      type: 'message',
      role: 'assistant',
      content: [],
      model: meta.model,
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 0 },
    },
  })
  sse(res, 'ping', { type: 'ping' })

  for (let i = 0; i < turn.blocks.length; i++) {
    const block = turn.blocks[i]
    if (!block) continue
    if (block.type === 'text') {
      sse(res, 'content_block_start', {
        type: 'content_block_start',
        index: i,
        content_block: { type: 'text', text: '' },
      })
      for (const c of chunkText(block.text, 20)) {
        sse(res, 'content_block_delta', {
          type: 'content_block_delta',
          index: i,
          delta: { type: 'text_delta', text: c },
        })
      }
      sse(res, 'content_block_stop', { type: 'content_block_stop', index: i })
    } else {
      const toolId = block.id ?? `toolu_${randomBytes(12).toString('hex')}`
      sse(res, 'content_block_start', {
        type: 'content_block_start',
        index: i,
        content_block: {
          type: 'tool_use',
          id: toolId,
          name: block.name,
          input: {},
        },
      })
      sse(res, 'content_block_delta', {
        type: 'content_block_delta',
        index: i,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) },
      })
      sse(res, 'content_block_stop', { type: 'content_block_stop', index: i })
    }
  }

  sse(res, 'message_delta', {
    type: 'message_delta',
    delta: { stop_reason: meta.stopReason, stop_sequence: null },
    usage: { output_tokens: estimateTokens(turn) },
  })
  sse(res, 'message_stop', { type: 'message_stop' })
  res.end()
}

function sse(res: http.ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\n`)
  res.write(`data: ${JSON.stringify(data)}\n\n`)
}

function chunkText(t: string, size: number): string[] {
  if (t.length <= size) return [t]
  const out: string[] = []
  for (let i = 0; i < t.length; i += size) out.push(t.slice(i, i + size))
  return out
}

function hasToolUse(turn: Turn): boolean {
  return turn.blocks.some((b) => b.type === 'tool_use')
}

function estimateTokens(turn: Turn): number {
  let n = 0
  for (const b of turn.blocks) {
    if (b.type === 'text') n += Math.ceil(b.text.length / 4)
    else n += 20
  }
  return n || 1
}

function flattenHeaders(h: http.IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(h)) {
    out[k] = Array.isArray(v) ? v.join(', ') : (v ?? '')
  }
  return out
}
