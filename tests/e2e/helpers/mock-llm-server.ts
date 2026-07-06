import http from 'node:http'

export type MockLlmRequest = {
  method: string
  path: string
  body: unknown
}

export type MockLlmServer = {
  url: string
  requests: MockLlmRequest[]
  failAllRequests: (message: string) => void
  close: () => Promise<void>
}

const deterministicText = 'Mocked OpenCode response from the test LLM.'

export async function startMockLlmServer(): Promise<MockLlmServer> {
  const requests: MockLlmRequest[] = []
  let failureMessage: string | null = null
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const body = await readJsonBody(req)
      requests.push({ method: req.method ?? 'GET', path: url.pathname, body })

      if (req.method === 'GET' && (url.pathname === '/v1/models' || url.pathname === '/models')) {
        sendJson(res, { object: 'list', data: [{ id: 'gpt-5.5', object: 'model', owned_by: 'kaivo-test' }] })
        return
      }

      if (req.method === 'POST' && (url.pathname === '/v1/chat/completions' || url.pathname === '/chat/completions')) {
        if (failureMessage) {
          sendJson(res, { error: { message: failureMessage } }, 500)
          return
        }
        const stream = Boolean((body as { stream?: unknown } | null)?.stream)
        if (stream) sendChatCompletionStream(res)
        else sendJson(res, chatCompletionResponse())
        return
      }

      if (req.method === 'POST' && (url.pathname === '/v1/responses' || url.pathname === '/responses')) {
        if (failureMessage) {
          sendJson(res, { error: { message: failureMessage } }, 500)
          return
        }
        const stream = Boolean((body as { stream?: unknown } | null)?.stream)
        if (stream) sendResponseStream(res)
        else sendJson(res, responseApiResponse())
        return
      }

      sendJson(res, { error: { message: `Unhandled mock LLM route: ${req.method} ${url.pathname}` } }, 404)
    } catch (err) {
      sendJson(res, { error: { message: err instanceof Error ? err.message : String(err) } }, 500)
    }
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('mock LLM server did not bind a TCP port')
  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    requests,
    failAllRequests: (message) => {
      failureMessage = message
    },
    close: async () => await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  }
}

export function mockLlmText(): string {
  return deterministicText
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  if (req.method === 'GET' || req.method === 'HEAD') return null
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  const raw = Buffer.concat(chunks).toString('utf8').trim()
  if (!raw) return null
  return JSON.parse(raw) as unknown
}

function chatCompletionResponse() {
  return {
    id: 'chatcmpl-kaivo-test',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: 'gpt-5.5',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: deterministicText },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
  }
}

function responseApiResponse() {
  return {
    id: 'resp_kaivo_test',
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    model: 'gpt-5.5',
    status: 'completed',
    output_text: deterministicText,
    output: [
      {
        id: 'msg_kaivo_test',
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text: deterministicText, annotations: [] }],
      },
    ],
    usage: { input_tokens: 12, output_tokens: 8, total_tokens: 20 },
  }
}

function sendChatCompletionStream(res: http.ServerResponse): void {
  sendSse(res, [
    { id: 'chatcmpl-kaivo-test', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] },
    { id: 'chatcmpl-kaivo-test', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: deterministicText }, finish_reason: null }] },
    { id: 'chatcmpl-kaivo-test', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
  ])
}

function sendResponseStream(res: http.ServerResponse): void {
  const started = { ...responseApiResponse(), status: 'in_progress', output: [] }
  const message = {
    id: 'msg_kaivo_test',
    type: 'message',
    status: 'completed',
    role: 'assistant',
    content: [{ type: 'output_text', text: deterministicText, annotations: [] }],
  }
  sendSse(res, [
    { type: 'response.created', sequence_number: 0, response: started },
    { type: 'response.in_progress', sequence_number: 1, response: started },
    { type: 'response.output_item.added', sequence_number: 2, output_index: 0, item: { ...message, status: 'in_progress', content: [] } },
    { type: 'response.content_part.added', sequence_number: 3, item_id: message.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
    { type: 'response.output_text.delta', sequence_number: 4, item_id: message.id, output_index: 0, content_index: 0, delta: deterministicText },
    { type: 'response.output_text.done', sequence_number: 5, item_id: message.id, output_index: 0, content_index: 0, text: deterministicText },
    { type: 'response.content_part.done', sequence_number: 6, item_id: message.id, output_index: 0, content_index: 0, part: message.content[0] },
    { type: 'response.output_item.done', sequence_number: 7, output_index: 0, item: message },
    { type: 'response.completed', sequence_number: 8, response: responseApiResponse() },
  ])
}

function sendSse(res: http.ServerResponse, events: unknown[]): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })
  for (const event of events) {
    const eventName = typeof event === 'object' && event && 'type' in event ? String((event as { type: unknown }).type) : 'message'
    res.write(`event: ${eventName}\n`)
    res.write(`data: ${JSON.stringify(event)}\n\n`)
  }
  res.write('data: [DONE]\n\n')
  res.end()
}

function sendJson(res: http.ServerResponse, body: unknown, status = 200): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}
