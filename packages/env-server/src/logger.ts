import pino from 'pino'
import { config } from './config.js'

export const logger = pino({
  level: config.NODE_ENV === 'test' ? 'silent' : 'info',
  base: { svc: 'cc-env', kind: config.CC_KIND, label: config.CC_LABEL },
})
