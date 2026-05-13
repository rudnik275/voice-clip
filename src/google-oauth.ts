// Google OAuth 2.0 — minimal, no SDK.
//
// We use the bare `fetch` API against two Google endpoints:
//   1. https://accounts.google.com/o/oauth2/v2/auth   (authorize redirect)
//   2. https://oauth2.googleapis.com/token            (code → tokens)
//
// The token endpoint returns an `id_token` JWT. For v2 we **do NOT verify
// the JWT signature** — we trust the TLS channel to Google (same trust
// model the official google-auth-library uses for non-cacheable flows).
// We DO validate the claim set: iss, aud, exp, email_verified.
//
// TODO(v3 hardening): verify the RS256 signature against Google's JWKS at
// https://www.googleapis.com/oauth2/v3/certs (cache the keys; rotate
// hourly).

export interface GoogleProfile {
  sub: string
  email: string
  name: string
  picture_url: string | null
}

export interface GoogleOAuthDeps {
  clientId: string
  clientSecret: string
  fetcher?: GoogleFetcher
  now?: () => number
}

export type GoogleFetcher = (input: string | URL, init?: RequestInit) => Promise<Response>

export interface GoogleOAuth {
  getAuthUrl(state: string, redirectUri: string): string
  exchangeCode(code: string, redirectUri: string): Promise<GoogleProfile>
}

const AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'

interface IdTokenPayload {
  iss?: string
  aud?: string
  exp?: number
  sub?: string
  email?: string
  email_verified?: boolean
  name?: string
  picture?: string
}

function base64UrlDecode(seg: string): string {
  // JWTs use base64url (no padding). Bun's atob handles standard base64; pad it.
  const pad = seg.length % 4
  const b64 = seg.replace(/-/g, '+').replace(/_/g, '/') + (pad ? '='.repeat(4 - pad) : '')
  return Buffer.from(b64, 'base64').toString('utf8')
}

function decodeIdToken(token: string): IdTokenPayload {
  const parts = token.split('.')
  if (parts.length !== 3) throw new Error('id_token: malformed (expected 3 JWT segments)')
  try {
    return JSON.parse(base64UrlDecode(parts[1] as string)) as IdTokenPayload
  } catch (e) {
    throw new Error(`id_token: payload JSON parse failed: ${(e as Error).message}`)
  }
}

function validateIdToken(
  payload: IdTokenPayload,
  expectedAud: string,
  nowSec: number,
): asserts payload is Required<
  Pick<IdTokenPayload, 'sub' | 'email' | 'name' | 'email_verified' | 'iss' | 'aud' | 'exp'>
> & { picture?: string } {
  const iss = payload.iss
  if (iss !== 'https://accounts.google.com' && iss !== 'accounts.google.com') {
    throw new Error(`id_token: bad iss "${iss ?? ''}"`)
  }
  if (payload.aud !== expectedAud) {
    throw new Error(`id_token: aud mismatch (expected ${expectedAud}, got ${payload.aud ?? ''})`)
  }
  if (typeof payload.exp !== 'number' || payload.exp <= nowSec) {
    throw new Error(`id_token: exp in past (${payload.exp ?? 'missing'} <= ${nowSec})`)
  }
  if (payload.email_verified !== true) {
    throw new Error('id_token: email is not verified')
  }
  if (!payload.sub || !payload.email || !payload.name) {
    throw new Error('id_token: missing one of sub/email/name claims')
  }
}

export function createGoogleOAuth(deps: GoogleOAuthDeps): GoogleOAuth {
  const fetcher: GoogleFetcher = deps.fetcher ?? ((url, init) => fetch(url, init))
  const now = deps.now ?? Date.now

  return {
    getAuthUrl(state: string, redirectUri: string): string {
      const u = new URL(AUTHORIZE_URL)
      u.searchParams.set('client_id', deps.clientId)
      u.searchParams.set('redirect_uri', redirectUri)
      u.searchParams.set('response_type', 'code')
      u.searchParams.set('scope', 'openid email profile')
      u.searchParams.set('state', state)
      u.searchParams.set('access_type', 'online')
      u.searchParams.set('prompt', 'select_account')
      return u.toString()
    },

    async exchangeCode(code: string, redirectUri: string): Promise<GoogleProfile> {
      const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: deps.clientId,
        client_secret: deps.clientSecret,
        redirect_uri: redirectUri,
      }).toString()

      const res = await fetcher(TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
      })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`google token endpoint: ${res.status} ${text}`)
      }
      const tokenJson = (await res.json()) as { id_token?: string }
      if (!tokenJson.id_token) throw new Error('google token endpoint: response missing id_token')

      const payload = decodeIdToken(tokenJson.id_token)
      validateIdToken(payload, deps.clientId, Math.floor(now() / 1000))

      return {
        sub: payload.sub,
        email: payload.email,
        name: payload.name,
        picture_url: payload.picture ?? null,
      }
    },
  }
}
