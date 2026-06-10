// Cookie + session-resolution middleware.
//
// Cookie spec: `session=<hex>` HttpOnly Secure SameSite=Lax, Path=/.
// Session token = sessions-store hex (256-bit). resolveUserFromRequest is
// the single chokepoint every authed route uses.

import type { Session, SessionsStore } from './sessions-store'
import type { User, UsersStore } from './users-store'
import type { Device, DevicesStore } from './devices-store'

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

// Short-lived invite cookie — set when an invitee opens /invite/<token>, then
// consumed in /auth/google/callback. Same shape as the OAuth state cookie
// (HttpOnly, 10min, Lax) so it survives the Google redirect round-trip but
// doesn't linger past the signup attempt.
const INVITE_COOKIE_NAME = 'invite'
const INVITE_MAX_AGE_SEC = 600

export function buildInviteCookie(token: string, opts: { secure?: boolean } = {}): string {
  const parts = [
    `${INVITE_COOKIE_NAME}=${token}`,
    'HttpOnly',
    'Path=/',
    `Max-Age=${INVITE_MAX_AGE_SEC}`,
    'SameSite=Lax',
  ]
  if (opts.secure ?? true) parts.push('Secure')
  return parts.join('; ')
}

export function buildClearInviteCookie(opts: { secure?: boolean } = {}): string {
  const parts = [
    `${INVITE_COOKIE_NAME}=`,
    'HttpOnly',
    'Path=/',
    'Max-Age=0',
    'SameSite=Lax',
  ]
  if (opts.secure ?? true) parts.push('Secure')
  return parts.join('; ')
}

export function parseInviteCookie(header: string | null | undefined): string | null {
  if (!header) return null
  for (const segment of header.split(';')) {
    const idx = segment.indexOf('=')
    if (idx < 0) continue
    const key = segment.slice(0, idx).trim()
    if (key !== INVITE_COOKIE_NAME) continue
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

// ----- device-token auth (Mac Tauri app) -----
//
// The Mac app authenticates with the opaque device_token issued at pairing,
// stored in its macOS Keychain. It presents the token as the `X-Device-Token`
// header (preferred: keeps the bearer out of proxy/tunnel access logs) OR as
// `?device_token=` query parameter (deprecated: still accepted for
// back-compat with older Tauri clients that have not yet updated). Header
// wins if both are present.

const DEVICE_TOKEN_HEADER = 'x-device-token'

export function parseDeviceToken(req: Request): string | null {
  const fromHeader = req.headers.get(DEVICE_TOKEN_HEADER)
  if (fromHeader && fromHeader.length > 0) return fromHeader
  // Deprecated: ?device_token= query form writes the bearer token into proxy
  // and tunnel access logs on every reconnect. Kept for back-compat only.
  const fromQuery = new URL(req.url).searchParams.get('device_token')
  if (fromQuery && fromQuery.length > 0) return fromQuery
  return null
}

export function resolveDeviceFromRequest(
  req: Request,
  devices: DevicesStore,
): Device | null {
  const token = parseDeviceToken(req)
  if (!token) return null
  return devices.findByToken(token)
}

// ----- unified auth (Mac browser-PWA + Mac Tauri-app share routes) -----
//
// The Tauri app needs to call /me, /upload, /history, /cost the same way the
// PWA does. The PWA carries a session cookie; the Tauri webview carries the
// device_token (Keychain-backed). This helper accepts either: cookie wins
// when present (a paired Mac running both shouldn't double-bill), otherwise
// we resolve the user via the device row. Session is null in the device path
// because the Tauri app doesn't own a session — routes that mutate session
// state (e.g. /logout, /pair/*) must keep using resolveUserFromRequest.
export interface AuthedUser {
  user: User
  session: Session | null
}

export function resolveUserOrDevice(
  req: Request,
  sessions: SessionsStore,
  users: UsersStore,
  devices: DevicesStore,
): AuthedUser | null {
  const authed = resolveUserFromRequest(req, sessions, users)
  if (authed) return authed
  const device = resolveDeviceFromRequest(req, devices)
  if (!device) return null
  const user = users.findById(device.user_id)
  if (!user) return null
  return { user, session: null }
}
