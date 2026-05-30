// Tests for POST /admin/users, allowed-emails plan storage, and the
// OAuth-callback plan-apply path.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../src/db'
import { createAllowedEmailsStore } from '../src/allowed-emails-store'
import { startServer, type ServerDeps } from '../src/server'
import type { GoogleFetcher } from '../src/google-oauth'

// --- unit: allowed-emails-store planFor + upsert ---

describe('allowed-emails-store: plan storage', () => {
  function setup(now: () => number = Date.now) {
    const db = openDb(':memory:')
    return { db, store: createAllowedEmailsStore(db, now) }
  }

  test('planFor returns null when email not in store', () => {
    const { store } = setup()
    expect(store.planFor('nobody@example.com')).toBeNull()
  })

  test('planFor returns null when email added without plan', () => {
    const { store } = setup()
    store.add('alice@example.com', 'env')
    expect(store.planFor('alice@example.com')).toBeNull()
  })

  test('add with plan stores the plan; planFor returns it', () => {
    const { store } = setup()
    store.add('alice@example.com', 'manual', null, 'pro')
    expect(store.planFor('alice@example.com')).toBe('pro')
  })

  test('add with plan=unlimited stores correctly', () => {
    const { store } = setup()
    store.add('owner@example.com', 'env', null, 'unlimited')
    expect(store.planFor('owner@example.com')).toBe('unlimited')
  })

  test('re-add with new plan updates the stored plan (upsert)', () => {
    const { store } = setup()
    store.add('alice@example.com', 'manual', null, 'free')
    expect(store.planFor('alice@example.com')).toBe('free')
    store.add('alice@example.com', 'manual', null, 'pro')
    expect(store.planFor('alice@example.com')).toBe('pro')
  })

  test('planFor is case-insensitive (normalises email)', () => {
    const { store } = setup()
    store.add('Alice@Example.com', 'manual', null, 'unlimited')
    expect(store.planFor('alice@example.com')).toBe('unlimited')
    expect(store.planFor('ALICE@EXAMPLE.COM')).toBe('unlimited')
  })

  test('add without plan does not clear an existing plan', () => {
    const { store } = setup()
    store.add('alice@example.com', 'manual', null, 'unlimited')
    // Re-add via env-seed path (no plan arg) — should not overwrite
    // the existing plan because INSERT OR IGNORE leaves the row unchanged.
    store.add('alice@example.com', 'env')
    expect(store.planFor('alice@example.com')).toBe('unlimited')
  })

  test('isAllowed still works after add-with-plan', () => {
    const { store } = setup()
    store.add('bob@example.com', 'manual', null, 'pro')
    expect(store.isAllowed('bob@example.com')).toBe(true)
    expect(store.isAllowed('unknown@example.com')).toBe(false)
  })
})

// --- integration: POST /admin/users endpoint ---

const CLIENT_ID = 'test-client.apps.googleusercontent.com'
const CLIENT_SECRET = 'test-secret'
const ADMIN_TOKEN = 'test-admin-token'

function b64url(s: string): string {
  return Buffer.from(s).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')
}
function makeIdToken(payload: Record<string, unknown>): string {
  return `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(JSON.stringify({ iss: 'https://accounts.google.com', aud: CLIENT_ID, exp: Math.floor(Date.now() / 1000) + 3600, email_verified: true, ...payload }))}.sig`
}
function googleFetcher(p: Record<string, unknown>): GoogleFetcher {
  return async () =>
    new Response(
      JSON.stringify({ id_token: makeIdToken(p), access_token: 'fake', token_type: 'Bearer' }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
}

function extractCookie(setCookies: string[], name: string): string | null {
  const found = setCookies.find((c) => c.startsWith(`${name}=`))
  if (!found) return null
  const v = found.split(';')[0]!.split('=')[1]!
  return v.length > 0 ? v : null
}

async function doOAuth(
  baseUrl: string,
): Promise<{ session: string | null; status: number }> {
  const startR = await fetch(`${baseUrl}/auth/google/start`, { redirect: 'manual' })
  const state = extractCookie(startR.headers.getSetCookie(), 'oauth_state')!
  const cbR = await fetch(`${baseUrl}/auth/google/callback?code=fake&state=${state}`, {
    headers: { cookie: `oauth_state=${state}` },
    redirect: 'manual',
  })
  return {
    session: extractCookie(cbR.headers.getSetCookie(), 'session'),
    status: cbR.status,
  }
}

describe('POST /admin/users', () => {
  let dir: string
  let server: Awaited<ReturnType<typeof startServer>>
  let baseUrl: string

  async function startWith(extra: Partial<ServerDeps> = {}) {
    const deps: ServerDeps = {
      dataDir: dir,
      port: 0,
      useTls: false,
      adminToken: ADMIN_TOKEN,
      googleClientId: CLIENT_ID,
      googleClientSecret: CLIENT_SECRET,
      publicUrl: 'http://localhost',
      googleFetcher: googleFetcher({ sub: 'g1', email: 'alice@example.com', name: 'Alice' }),
      ...extra,
    }
    server = await startServer(deps)
    baseUrl = `http://127.0.0.1:${server.port}`
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'voice-clip-adminusers-'))
  })
  afterEach(async () => {
    server?.stop()
    await rm(dir, { recursive: true, force: true })
  })

  test('without admin token → 401', async () => {
    await startWith()
    const r = await fetch(`${baseUrl}/admin/users`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'alice@example.com' }),
    })
    expect(r.status).toBe(401)
  })

  test('wrong method → 405', async () => {
    await startWith()
    const r = await fetch(`${baseUrl}/admin/users`, {
      method: 'GET',
      headers: { 'x-admin-token': ADMIN_TOKEN },
    })
    expect(r.status).toBe(405)
  })

  test('missing email → 400', async () => {
    await startWith()
    const r = await fetch(`${baseUrl}/admin/users`, {
      method: 'POST',
      headers: { 'x-admin-token': ADMIN_TOKEN, 'content-type': 'application/json' },
      body: JSON.stringify({ plan: 'pro' }),
    })
    expect(r.status).toBe(400)
  })

  test('valid POST adds email to allowlist; returns email + plan + applied=false (no user row yet)', async () => {
    await startWith()
    const r = await fetch(`${baseUrl}/admin/users`, {
      method: 'POST',
      headers: { 'x-admin-token': ADMIN_TOKEN, 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'alice@example.com', plan: 'pro' }),
    })
    expect(r.status).toBe(200)
    const body = (await r.json()) as { email: string; plan: string; applied: boolean }
    expect(body.email).toBe('alice@example.com')
    expect(body.plan).toBe('pro')
    expect(body.applied).toBe(false)
  })

  test('default plan is pro when not specified', async () => {
    await startWith()
    const r = await fetch(`${baseUrl}/admin/users`, {
      method: 'POST',
      headers: { 'x-admin-token': ADMIN_TOKEN, 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'bob@example.com' }),
    })
    expect(r.status).toBe(200)
    const body = (await r.json()) as { plan: string }
    expect(body.plan).toBe('pro')
  })

  test('invalid plan string → defaults to pro', async () => {
    await startWith()
    const r = await fetch(`${baseUrl}/admin/users`, {
      method: 'POST',
      headers: { 'x-admin-token': ADMIN_TOKEN, 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'alice@example.com', plan: 'superduper' }),
    })
    expect(r.status).toBe(200)
    const body = (await r.json()) as { plan: string }
    expect(body.plan).toBe('pro')
  })

  test('re-POST same email updates plan; idempotent; no duplicate rows', async () => {
    await startWith()
    const post = async (plan: string) =>
      fetch(`${baseUrl}/admin/users`, {
        method: 'POST',
        headers: { 'x-admin-token': ADMIN_TOKEN, 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'alice@example.com', plan }),
      })

    await post('free')
    const r2 = await post('unlimited')
    expect(r2.status).toBe(200)
    const body = (await r2.json()) as { plan: string }
    expect(body.plan).toBe('unlimited')
  })

  test('after /admin/users, the email can log in via OAuth', async () => {
    await startWith()

    // Add alice to the allowlist first.
    const addR = await fetch(`${baseUrl}/admin/users`, {
      method: 'POST',
      headers: { 'x-admin-token': ADMIN_TOKEN, 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'alice@example.com', plan: 'pro' }),
    })
    expect(addR.status).toBe(200)

    // Now alice tries to log in.
    const oauth = await doOAuth(baseUrl)
    expect(oauth.status).toBe(302)
    expect(oauth.session).not.toBeNull()
  })

  test('added email gets plan applied on first login via OAuth', async () => {
    await startWith()

    // Pre-add alice with 'pro' plan.
    await fetch(`${baseUrl}/admin/users`, {
      method: 'POST',
      headers: { 'x-admin-token': ADMIN_TOKEN, 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'alice@example.com', plan: 'pro' }),
    })

    // Alice logs in.
    const oauth = await doOAuth(baseUrl)
    expect(oauth.session).not.toBeNull()

    // /me should report plan = 'pro'.
    const meR = await fetch(`${baseUrl}/me`, {
      headers: { cookie: `session=${oauth.session}` },
    })
    expect(meR.status).toBe(200)
    const me = (await meR.json()) as { plan: string }
    expect(me.plan).toBe('pro')
  })

  test('applied=true when user row already exists at add time', async () => {
    await startWith({ allowlist: ['alice@example.com'] })

    // Alice logs in first (creates the user row).
    const oauth = await doOAuth(baseUrl)
    expect(oauth.session).not.toBeNull()

    // Now admin adds alice again with a new plan.
    const r = await fetch(`${baseUrl}/admin/users`, {
      method: 'POST',
      headers: { 'x-admin-token': ADMIN_TOKEN, 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'alice@example.com', plan: 'unlimited' }),
    })
    expect(r.status).toBe(200)
    const body = (await r.json()) as { plan: string; applied: boolean }
    expect(body.plan).toBe('unlimited')
    // applied=true because the user row already existed.
    expect(body.applied).toBe(true)

    // /me should immediately reflect unlimited plan (no re-login needed).
    const meR = await fetch(`${baseUrl}/me`, {
      headers: { cookie: `session=${oauth.session}` },
    })
    const me = (await meR.json()) as { plan: string }
    expect(me.plan).toBe('unlimited')
  })

  test('non-allowlisted email → 403 access denied, no session cookie created', async () => {
    // Use a fetcher that returns a stranger's email.
    await startWith({
      googleFetcher: googleFetcher({ sub: 'g-stranger', email: 'stranger@example.com', name: 'Stranger' }),
    })
    // No call to /admin/users for stranger, so they're not on the allowlist.
    const startR = await fetch(`${baseUrl}/auth/google/start`, { redirect: 'manual' })
    const state = extractCookie(startR.headers.getSetCookie(), 'oauth_state')!
    const cbR = await fetch(`${baseUrl}/auth/google/callback?code=fake&state=${state}`, {
      headers: { cookie: `oauth_state=${state}` },
      redirect: 'manual',
    })
    expect(cbR.status).toBe(403)
    const session = extractCookie(cbR.headers.getSetCookie(), 'session')
    expect(session).toBeNull()
    // The access-denied page should be returned.
    const html = await cbR.text()
    expect(html.toLowerCase()).toContain('access denied')
  })
})

// --- integration: owner = unlimited plan on first login ---

describe('owner boot seed → unlimited plan on login', () => {
  let dir: string
  let server: Awaited<ReturnType<typeof startServer>>
  let baseUrl: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'voice-clip-owner-plan-'))
  })
  afterEach(async () => {
    server?.stop()
    await rm(dir, { recursive: true, force: true })
  })

  test('owner logs in → plan is unlimited (seeded at boot)', async () => {
    const ownerEmail = 'owner@example.com'
    server = await startServer({
      dataDir: dir,
      port: 0,
      useTls: false,
      ownerEmail,
      adminToken: ADMIN_TOKEN,
      googleClientId: CLIENT_ID,
      googleClientSecret: CLIENT_SECRET,
      publicUrl: 'http://localhost',
      googleFetcher: googleFetcher({ sub: 'g-owner', email: ownerEmail, name: 'Owner' }),
    })
    baseUrl = `http://127.0.0.1:${server.port}`

    const oauth = await doOAuth(baseUrl)
    expect(oauth.session).not.toBeNull()

    const meR = await fetch(`${baseUrl}/me`, {
      headers: { cookie: `session=${oauth.session}` },
    })
    const me = (await meR.json()) as { plan: string; is_owner: boolean }
    expect(me.plan).toBe('unlimited')
    expect(me.is_owner).toBe(true)
  })
})

// --- integration: GET /welcome ---

describe('GET /welcome', () => {
  let dir: string
  let server: Awaited<ReturnType<typeof startServer>>
  let baseUrl: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'voice-clip-welcome-'))
    server = await startServer({
      dataDir: dir,
      port: 0,
      useTls: false,
    })
    baseUrl = `http://127.0.0.1:${server.port}`
  })
  afterEach(async () => {
    server?.stop()
    await rm(dir, { recursive: true, force: true })
  })

  test('GET /welcome returns 200 HTML without auth', async () => {
    const r = await fetch(`${baseUrl}/welcome`)
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toContain('text/html')
  })

  test('/welcome page contains expected onboarding content in Russian', async () => {
    const html = await fetch(`${baseUrl}/welcome`).then((r) => r.text())
    // Should contain key onboarding phrases
    expect(html).toContain('Safari')
    expect(html).toContain('Войти через Google')
  })

  test('wrong method → 405', async () => {
    const r = await fetch(`${baseUrl}/welcome`, { method: 'POST' })
    expect(r.status).toBe(405)
  })
})
