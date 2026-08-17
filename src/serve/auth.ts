/**
 * Bearer-token check.
 *
 * Off unless `apiKey` is configured, because the default bind address is
 * loopback. Set both a key and a non-loopback host, or neither.
 */

import { unauthorized } from './errors.ts'
import type { Config } from './config.ts'

export function requireAuth(request: Request, config: Config): void {
  if (!config.apiKey) return

  const header = request.headers.get('authorization') ?? ''
  const [scheme, token] = header.split(' ')
  if (scheme?.toLowerCase() !== 'bearer' || !token) {
    throw unauthorized('Missing Authorization header. Expected `Authorization: Bearer <key>`.')
  }
  if (!timingSafeEqual(token, config.apiKey)) {
    throw unauthorized()
  }
}

/** Constant-time comparison; a short-circuiting `===` leaks the key by timing. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}
