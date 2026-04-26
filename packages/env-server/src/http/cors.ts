import { allowedOrigins } from '../config.js'

export function isAllowedOrigin(origin: string): boolean {
  return allowedOrigins.includes(origin)
}
