import pino from 'pino'
import { config } from './config.js'
import { makeRemoteLogStream } from './logger-remote.js'

const stdoutStream: pino.StreamEntry = {
  level: 'info',
  stream: process.stdout,
}

// Ship every line that would otherwise be visible to the operator up to
// identity too. Filtered to `info` and above to match stdout — the buffer
// in logger-remote is bounded so this can't backpressure the app.
const remoteStream: pino.StreamEntry = {
  level: 'info',
  stream: makeRemoteLogStream({
    source: `cc-env:${config.CC_KIND}:${config.CC_LABEL}`,
  }),
}

export const logger = pino(
  {
    level: config.NODE_ENV === 'test' ? 'silent' : 'info',
    base: { svc: 'cc-env', kind: config.CC_KIND, label: config.CC_LABEL },
  },
  pino.multistream(config.NODE_ENV === 'test' ? [] : [stdoutStream, remoteStream]),
)
