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
        const text = responseText(body)
        const stream = Boolean((body as { stream?: unknown } | null)?.stream)
        if (stream) sendChatCompletionStream(res, text)
        else sendJson(res, chatCompletionResponse(text))
        return
      }

      if (req.method === 'POST' && (url.pathname === '/v1/responses' || url.pathname === '/responses')) {
        if (failureMessage) {
          sendJson(res, { error: { message: failureMessage } }, 500)
          return
        }
        const text = responseText(body)
        const stream = Boolean((body as { stream?: unknown } | null)?.stream)
        if (stream) sendResponseStream(res, text)
        else sendJson(res, responseApiResponse(text))
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

function chatCompletionResponse(text = deterministicText) {
  return {
    id: 'chatcmpl-kaivo-test',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: 'gpt-5.5',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: text },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
  }
}

function responseApiResponse(text = deterministicText) {
  return {
    id: 'resp_kaivo_test',
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    model: 'gpt-5.5',
    status: 'completed',
    output_text: text,
    output: [
      {
        id: 'msg_kaivo_test',
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text, annotations: [] }],
      },
    ],
    usage: { input_tokens: 12, output_tokens: 8, total_tokens: 20 },
  }
}

function sendChatCompletionStream(res: http.ServerResponse, text: string): void {
  const chunks = streamChunks(text)
  sendSse(res, [
    { id: 'chatcmpl-kaivo-test', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] },
    ...chunks.map((content) => ({ id: 'chatcmpl-kaivo-test', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content }, finish_reason: null }] })),
    { id: 'chatcmpl-kaivo-test', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
  ], chunks.length > 1 ? 500 : 0)
}

function sendResponseStream(res: http.ServerResponse, text: string): void {
  const chunks = streamChunks(text)
  const started = { ...responseApiResponse(text), status: 'in_progress', output: [] }
  const message = {
    id: 'msg_kaivo_test',
    type: 'message',
    status: 'completed',
    role: 'assistant',
    content: [{ type: 'output_text', text, annotations: [] }],
  }
  const deltas = chunks.map((delta, index) => ({ type: 'response.output_text.delta', sequence_number: 4 + index, item_id: message.id, output_index: 0, content_index: 0, delta }))
  const doneSequence = 4 + deltas.length
  sendSse(res, [
    { type: 'response.created', sequence_number: 0, response: started },
    { type: 'response.in_progress', sequence_number: 1, response: started },
    { type: 'response.output_item.added', sequence_number: 2, output_index: 0, item: { ...message, status: 'in_progress', content: [] } },
    { type: 'response.content_part.added', sequence_number: 3, item_id: message.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
    ...deltas,
    { type: 'response.output_text.done', sequence_number: doneSequence, item_id: message.id, output_index: 0, content_index: 0, text },
    { type: 'response.content_part.done', sequence_number: doneSequence + 1, item_id: message.id, output_index: 0, content_index: 0, part: message.content[0] },
    { type: 'response.output_item.done', sequence_number: doneSequence + 2, output_index: 0, item: message },
    { type: 'response.completed', sequence_number: doneSequence + 3, response: responseApiResponse(text) },
  ], chunks.length > 1 ? 500 : 0)
}

function streamChunks(text: string): string[] {
  if (!text.startsWith('# Conceptual walkthrough')) return [text]
  const opening = text.indexOf('```kaivo-diff')
  const closing = text.indexOf('\n```', opening)
  if (opening < 0 || closing < 0) return [text]
  return [text.slice(0, opening), text.slice(opening, closing), text.slice(closing)]
}

function responseText(body: unknown): string {
  const strings: string[] = []
  const visit = (value: unknown) => {
    if (typeof value === 'string') strings.push(value)
    else if (Array.isArray(value)) value.forEach(visit)
    else if (value && typeof value === 'object') Object.values(value).forEach(visit)
  }
  visit(body)
  const prompt = strings.find((value) => value.includes('CANONICAL MANIFEST\n') && value.includes('\n\nRAW UNIFIED DIFF'))
  if (!prompt) return deterministicText
  try {
    const manifest = JSON.parse(prompt.split('CANONICAL MANIFEST\n')[1]!.split('\n\nRAW UNIFIED DIFF')[0]!) as {
      digest: string
      files: Array<{ index: number; oldPath: string | null; newPath: string | null }>
    }
    return [
      '# Conceptual walkthrough\n\nThe behavior is reviewed before its supporting files.\n\n',
      ...manifest.files.slice().reverse().map((file) => {
        const directive = {
          version: 1,
          diff: manifest.digest,
          id: `concept-${file.index}`,
          file: { index: file.index, oldPath: file.oldPath, newPath: file.newPath },
          collapsed: false,
        }
        return `## Concept ${file.index + 1}\n\n\`\`\`kaivo-diff\n${JSON.stringify(directive)}\n\`\`\`\n\n`
      }),
    ].join('')
  } catch {
    return deterministicText
  }
}

function sendSse(res: http.ServerResponse, events: unknown[], delayMs = 0): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })
  void (async () => {
    for (const event of events) {
      const eventName = typeof event === 'object' && event && 'type' in event ? String((event as { type: unknown }).type) : 'message'
      res.write(`event: ${eventName}\n`)
      res.write(`data: ${JSON.stringify(event)}\n\n`)
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs))
    }
    res.write('data: [DONE]\n\n')
    res.end()
  })()
}

function sendJson(res: http.ServerResponse, body: unknown, status = 200): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}
