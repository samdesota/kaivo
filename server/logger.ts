import pino from 'pino'
import pinoPretty from 'pino-pretty'
import { env, isProd } from './env.js'
import { makeLocalLogStream } from './logs/local-stream.js'

// In dev we want the colorized human stream; in prod, raw JSON to stdout.
// We always layer the local-DB sink on top so the orchestrator's own
// activity ends up in event_logs alongside everything else.
const stdout: pino.StreamEntry = {
  level: 'info',
  stream: isProd
    ? process.stdout
    : pinoPretty({ colorize: true, translateTime: 'HH:MM:ss' }),
}

const localDb: pino.StreamEntry = {
  level: 'info',
  stream: makeLocalLogStream({ source: 'orchestrator', principal: null }),
}

export const logger = pino(
  {
    level: env.NODE_ENV === 'test' ? 'silent' : 'info',
  },
  pino.multistream(env.NODE_ENV === 'test' ? [] : [stdout, localDb]),
)
