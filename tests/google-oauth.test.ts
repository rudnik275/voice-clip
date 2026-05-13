import { describe, expect, test } from 'bun:test'
import { createGoogleOAuth, type GoogleFetcher } from '../src/google-oauth'

const CLIENT_ID = 'client-id-123.apps.googleusercontent.com'
const CLIENT_SECRET = 'client-secret-xyz'
const REDIRECT = 'https://voice.rudifamily.uk/auth/google/callback'

function b64url(s: string): string {
  return Buffer.from(s).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')
}

function makeIdToken(payload: Record<string, unknown>): string {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const body = b64url(JSON.stringify(payload))
  return `${header}.${body}.fake-signature`
}

describe('google-oauth.getAuthUrl', () => {
  test('builds the Google authorize URL with required query params', () => {
    const oauth = createGoogleOAuth({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
    })
    const url = oauth.getAuthUrl('state-abc', REDIRECT)
    const u = new URL(url)
    expect(u.origin + u.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    expect(u.searchParams.get('client_id')).toBe(CLIENT_ID)
    expect(u.searchParams.get('redirect_uri')).toBe(REDIRECT)
    expect(u.searchParams.get('response_type')).toBe('code')
    expect(u.searchParams.get('scope')).toBe('openid email profile')
    expect(u.searchParams.get('state')).toBe('state-abc')
    expect(u.searchParams.get('access_type')).toBe('online')
    expect(u.searchParams.get('prompt')).toBe('select_account')
  })
})

describe('google-oauth.exchangeCode', () => {
  test('POSTs form-encoded body to token endpoint then returns decoded id_token payload', async () => {
    let capturedUrl: string | undefined
    let capturedInit: RequestInit | undefined
    const idToken = makeIdToken({
      iss: 'https://accounts.google.com',
      aud: CLIENT_ID,
      exp: Math.floor(Date.now() / 1000) + 3600,
      sub: 'google-sub-1',
      email: 'alice@example.com',
      email_verified: true,
      name: 'Alice Doe',
      picture: 'https://lh3/avatar.png',
    })

    const fetcher: GoogleFetcher = async (url, init) => {
      capturedUrl = typeof url === 'string' ? url : url.toString()
      capturedInit = init
      return new Response(JSON.stringify({ id_token: idToken, access_token: 'a', token_type: 'Bearer' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }

    const oauth = createGoogleOAuth({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      fetcher,
    })
    const profile = await oauth.exchangeCode('code-from-google', REDIRECT)

    expect(capturedUrl).toBe('https://oauth2.googleapis.com/token')
    expect(capturedInit?.method).toBe('POST')
    expect((capturedInit?.headers as Record<string, string>)['content-type']).toBe(
      'application/x-www-form-urlencoded',
    )
    const body = new URLSearchParams(String(capturedInit?.body))
    expect(body.get('grant_type')).toBe('authorization_code')
    expect(body.get('code')).toBe('code-from-google')
    expect(body.get('client_id')).toBe(CLIENT_ID)
    expect(body.get('client_secret')).toBe(CLIENT_SECRET)
    expect(body.get('redirect_uri')).toBe(REDIRECT)

    expect(profile).toEqual({
      sub: 'google-sub-1',
      email: 'alice@example.com',
      name: 'Alice Doe',
      picture_url: 'https://lh3/avatar.png',
    })
  })

  test('accepts iss "accounts.google.com" (no https://) — Google uses both', async () => {
    const idToken = makeIdToken({
      iss: 'accounts.google.com',
      aud: CLIENT_ID,
      exp: Math.floor(Date.now() / 1000) + 3600,
      sub: 'sub-2',
      email: 'b@example.com',
      email_verified: true,
      name: 'B',
    })
    const oauth = createGoogleOAuth({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      fetcher: async () =>
        new Response(JSON.stringify({ id_token: idToken }), { status: 200 }),
    })
    const p = await oauth.exchangeCode('code', REDIRECT)
    expect(p.sub).toBe('sub-2')
  })

  test('rejects when iss is not Google', async () => {
    const idToken = makeIdToken({
      iss: 'evil.example.com',
      aud: CLIENT_ID,
      exp: Math.floor(Date.now() / 1000) + 3600,
      sub: 'sub',
      email: 'a@x.com',
      email_verified: true,
      name: 'A',
    })
    const oauth = createGoogleOAuth({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      fetcher: async () => new Response(JSON.stringify({ id_token: idToken }), { status: 200 }),
    })
    await expect(oauth.exchangeCode('code', REDIRECT)).rejects.toThrow(/iss/)
  })

  test('rejects when aud does not match clientId', async () => {
    const idToken = makeIdToken({
      iss: 'https://accounts.google.com',
      aud: 'some-other-client.apps.googleusercontent.com',
      exp: Math.floor(Date.now() / 1000) + 3600,
      sub: 'sub',
      email: 'a@x.com',
      email_verified: true,
      name: 'A',
    })
    const oauth = createGoogleOAuth({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      fetcher: async () => new Response(JSON.stringify({ id_token: idToken }), { status: 200 }),
    })
    await expect(oauth.exchangeCode('code', REDIRECT)).rejects.toThrow(/aud/)
  })

  test('rejects when exp is in the past', async () => {
    const idToken = makeIdToken({
      iss: 'https://accounts.google.com',
      aud: CLIENT_ID,
      exp: Math.floor(Date.now() / 1000) - 60,
      sub: 'sub',
      email: 'a@x.com',
      email_verified: true,
      name: 'A',
    })
    const oauth = createGoogleOAuth({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      fetcher: async () => new Response(JSON.stringify({ id_token: idToken }), { status: 200 }),
    })
    await expect(oauth.exchangeCode('code', REDIRECT)).rejects.toThrow(/exp/)
  })

  test('rejects when email_verified is false', async () => {
    const idToken = makeIdToken({
      iss: 'https://accounts.google.com',
      aud: CLIENT_ID,
      exp: Math.floor(Date.now() / 1000) + 3600,
      sub: 'sub',
      email: 'a@x.com',
      email_verified: false,
      name: 'A',
    })
    const oauth = createGoogleOAuth({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      fetcher: async () => new Response(JSON.stringify({ id_token: idToken }), { status: 200 }),
    })
    await expect(oauth.exchangeCode('code', REDIRECT)).rejects.toThrow(/verified/)
  })

  test('rejects on non-2xx response from token endpoint', async () => {
    const oauth = createGoogleOAuth({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      fetcher: async () => new Response('bad', { status: 400 }),
    })
    await expect(oauth.exchangeCode('code', REDIRECT)).rejects.toThrow()
  })

  test('rejects when token response is missing id_token', async () => {
    const oauth = createGoogleOAuth({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      fetcher: async () =>
        new Response(JSON.stringify({ access_token: 'a' }), { status: 200 }),
    })
    await expect(oauth.exchangeCode('code', REDIRECT)).rejects.toThrow(/id_token/)
  })

  test('picture_url is null when Google omits the picture claim', async () => {
    const idToken = makeIdToken({
      iss: 'https://accounts.google.com',
      aud: CLIENT_ID,
      exp: Math.floor(Date.now() / 1000) + 3600,
      sub: 'sub',
      email: 'a@x.com',
      email_verified: true,
      name: 'A',
    })
    const oauth = createGoogleOAuth({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      fetcher: async () => new Response(JSON.stringify({ id_token: idToken }), { status: 200 }),
    })
    const p = await oauth.exchangeCode('code', REDIRECT)
    expect(p.picture_url).toBeNull()
  })
})
