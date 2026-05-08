import type { SessionsStore } from './sessions-store'
import type { UsersStore, User } from './users-store'

const SESSION_COOKIE = 'session'
// 1 year — sessions are deleted explicitly via /logout, no idle expiry.
const SESSION_MAX_AGE = 60 * 60 * 24 * 365

export function parseSessionCookie(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null
  for (const part of cookieHeader.split(';')) {
    const [name, ...rest] = part.trim().split('=')
    if (name === SESSION_COOKIE) return rest.join('=')
  }
  return null
}

export function setSessionCookieHeader(token: string, secure = true): string {
  const flags = ['HttpOnly', 'SameSite=Lax', 'Path=/', `Max-Age=${SESSION_MAX_AGE}`]
  if (secure) flags.push('Secure')
  return `${SESSION_COOKIE}=${token}; ${flags.join('; ')}`
}

export function clearSessionCookieHeader(secure = true): string {
  const flags = ['HttpOnly', 'SameSite=Lax', 'Path=/', 'Max-Age=0']
  if (secure) flags.push('Secure')
  return `${SESSION_COOKIE}=; ${flags.join('; ')}`
}

export interface AuthenticatedUser {
  user: User
  sessionToken: string
}

// Resolves the request's session cookie to a User, or null if absent/expired.
export async function resolveSession(
  req: Request,
  sessions: SessionsStore,
  users: UsersStore,
): Promise<AuthenticatedUser | null> {
  const token = parseSessionCookie(req.headers.get('cookie'))
  if (!token) return null
  const session = await sessions.get(token)
  if (!session) return null
  const user = await users.get(session.userId)
  if (!user) {
    // Stale session — user was deleted. Treat as logged-out.
    return null
  }
  return { user, sessionToken: token }
}

export function unauthorized(message = 'Sign in required'): Response {
  return new Response(message, { status: 401 })
}

export function forbidden(message = 'Forbidden'): Response {
  return new Response(message, { status: 403 })
}
