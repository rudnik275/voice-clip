// Cookie + session-resolution middleware.
//
// Cookie spec: `session=<hex>` HttpOnly Secure SameSite=Lax, Path=/.
// Session token = sessions-store hex (256-bit). resolveUserFromRequest is
// the single chokepoint every authed route uses.

import type { Session, SessionsStore } from './sessions-store'
import type { User, UsersStore } from './users-store'

const SESSION_COOKIE_NAME = 'session'
const DEFAULT_MAX_AGE_SEC = 90 * 24 * 60 * 60 // 90 days, matches SESSION_TTL_MS

export interface AuthedRequest {
  user: User
  session: Session
}

export interface CookieOptions {
  maxAgeSec?: number
  secure?: boolean
}

export function parseSessionCookie(header: string | null | undefined): string | null {
  if (!header) return null
  for (const segment of header.split(';')) {
    const idx = segment.indexOf('=')
    if (idx < 0) continue
    const key = segment.slice(0, idx).trim()
    if (key !== SESSION_COOKIE_NAME) continue
    const value = segment.slice(idx + 1).trim()
    return value.length > 0 ? value : null
  }
  return null
}

export function buildSessionCookie(token: string, opts: CookieOptions = {}): string {
  const maxAge = opts.maxAgeSec ?? DEFAULT_MAX_AGE_SEC
  const secure = opts.secure ?? true
  const parts = [
    `${SESSION_COOKIE_NAME}=${token}`,
    'HttpOnly',
    'Path=/',
    `Max-Age=${maxAge}`,
    'SameSite=Lax',
  ]
  if (secure) parts.push('Secure')
  return parts.join('; ')
}

export function buildClearSessionCookie(opts: { secure?: boolean } = {}): string {
  const parts = [`${SESSION_COOKIE_NAME}=`, 'HttpOnly', 'Path=/', 'Max-Age=0', 'SameSite=Lax']
  if (opts.secure ?? true) parts.push('Secure')
  return parts.join('; ')
}

// Short-lived (10 min) state cookie used for OAuth CSRF protection.
const STATE_COOKIE_NAME = 'oauth_state'
const STATE_MAX_AGE_SEC = 600

export function buildStateCookie(state: string, opts: { secure?: boolean } = {}): string {
  const parts = [
    `${STATE_COOKIE_NAME}=${state}`,
    'HttpOnly',
    'Path=/',
    `Max-Age=${STATE_MAX_AGE_SEC}`,
    'SameSite=Lax',
  ]
  if (opts.secure ?? true) parts.push('Secure')
  return parts.join('; ')
}

export function buildClearStateCookie(opts: { secure?: boolean } = {}): string {
  const parts = [
    `${STATE_COOKIE_NAME}=`,
    'HttpOnly',
    'Path=/',
    'Max-Age=0',
    'SameSite=Lax',
  ]
  if (opts.secure ?? true) parts.push('Secure')
  return parts.join('; ')
}

export function parseStateCookie(header: string | null | undefined): string | null {
  if (!header) return null
  for (const segment of header.split(';')) {
    const idx = segment.indexOf('=')
    if (idx < 0) continue
    const key = segment.slice(0, idx).trim()
    if (key !== STATE_COOKIE_NAME) continue
    const value = segment.slice(idx + 1).trim()
    return value.length > 0 ? value : null
  }
  return null
}

export function resolveUserFromRequest(
  req: Request,
  sessions: SessionsStore,
  users: UsersStore,
): AuthedRequest | null {
  const token = parseSessionCookie(req.headers.get('cookie'))
  if (!token) return null
  const session = sessions.resolve(token)
  if (!session) return null
  const user = users.findById(session.user_id)
  if (!user) return null
  return { user, session }
}

export function unauthorized(): Response {
  return Response.json({ error: 'unauthorized' }, { status: 401 })
}
